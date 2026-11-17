//! md-reader desktop app. The window shows the same front end as the localhost version
//! (`public/`); these commands replace the Node server. Nothing here reads a file except through
//! `RootStore::resolve_inside`.

mod roots;

use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use percent_encoding::percent_decode_str;
use roots::{default_config_path, GuardError, Kind, RootInfo, RootStore, Tree, DOC_EXTS, IMAGE_EXTS};
use serde::Serialize;
use std::fs;
use std::sync::Mutex;
use tauri::http::Response;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MAX_DOC_BYTES: u64 = 5 * 1024 * 1024;

struct AppState {
    store: Mutex<RootStore>,
    /// Watches the folder of the note that is open. Replaced when another note is opened.
    watcher: Mutex<Option<Watched>>,
}

struct Watched {
    root: String,
    path: String,
    _watcher: RecommendedWatcher,
}

type CommandResult<T> = Result<T, String>;

fn message(err: GuardError) -> String {
    err.message
}

#[derive(Serialize)]
struct Doc {
    path: String,
    source: String,
}

#[derive(Clone, Serialize)]
struct DocChanged {
    root: String,
    path: String,
}

#[tauri::command]
fn list_roots(state: State<'_, AppState>) -> Vec<RootInfo> {
    state.store.lock().unwrap().list()
}

#[tauri::command]
fn add_root(state: State<'_, AppState>, path: String) -> CommandResult<RootInfo> {
    state.store.lock().unwrap().add(&path).map_err(message)
}

#[tauri::command]
fn remove_root(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    state.store.lock().unwrap().remove(&id).map_err(message)?;
    // Stop watching a note of the folder that was just removed.
    let mut watched = state.watcher.lock().unwrap();
    if watched.as_ref().is_some_and(|w| w.root == id) {
        *watched = None;
    }
    Ok(())
}

#[tauri::command]
fn tree(state: State<'_, AppState>, root: String) -> CommandResult<Tree> {
    state.store.lock().unwrap().tree(&root).map_err(message)
}

/// The Markdown text of a note. The page renders it (`public/render.js`).
#[tauri::command]
fn read_doc(state: State<'_, AppState>, root: String, path: String) -> CommandResult<Doc> {
    let resolved = state.store.lock().unwrap().resolve_inside(&root, &path, DOC_EXTS).map_err(message)?;
    let size = fs::metadata(&resolved.file).map(|m| m.len()).map_err(|_| "File not found.".to_string())?;
    if size > MAX_DOC_BYTES {
        return Err("This file is too large to display.".into());
    }
    let bytes = fs::read(&resolved.file).map_err(|_| "File not found.".to_string())?;
    Ok(Doc { path: resolved.rel, source: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Sends a `doc-changed` event each time the note is saved. The folder is watched, not the
/// file, because editors replace the file on save.
#[tauri::command]
fn watch_doc(app: AppHandle, state: State<'_, AppState>, root: String, path: String) -> CommandResult<()> {
    let resolved = state.store.lock().unwrap().resolve_inside(&root, &path, DOC_EXTS).map_err(message)?;
    let dir = resolved.file.parent().ok_or("File not found.")?.to_path_buf();
    let name = resolved.file.file_name().map(|n| n.to_os_string());
    let payload = DocChanged { root: root.clone(), path: resolved.rel.clone() };
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        // Reading the file is an event too; reacting to it would reload forever. Closing it
        // after a write is the one access event that matters: the save is complete.
        let closed_after_write = matches!(event.kind, EventKind::Access(AccessKind::Close(AccessMode::Write)));
        if matches!(event.kind, EventKind::Access(_)) && !closed_after_write {
            return;
        }
        if event.paths.iter().any(|p| p.file_name().map(|n| n.to_os_string()) == name) {
            let _ = app.emit("doc-changed", payload.clone());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&dir, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    *state.watcher.lock().unwrap() = Some(Watched { root, path: resolved.rel, _watcher: watcher });
    Ok(())
}

/// Stops watching a note when it is closed. Names the note, so that a late call cannot stop
/// the watch of the note opened after it.
#[tauri::command]
fn unwatch_doc(state: State<'_, AppState>, root: String, path: String) {
    let mut watched = state.watcher.lock().unwrap();
    if watched.as_ref().is_some_and(|w| w.root == root && w.path == path) {
        *watched = None;
    }
}

/// The system's folder dialog. Returns the chosen folder, or nothing when cancelled.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Add a folder to md-reader")
        .blocking_pick_folder()
        .and_then(|folder| folder.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Opens a web or mail link from a note in the system's default program.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> CommandResult<()> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err("Only web and mail links can be opened.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// `on` missing: toggle. Returns the new state.
#[tauri::command]
fn set_fullscreen(window: WebviewWindow, on: Option<bool>) -> CommandResult<bool> {
    let now = window.is_fullscreen().map_err(|e| e.to_string())?;
    let wanted = on.unwrap_or(!now);
    if wanted != now {
        window.set_fullscreen(wanted).map_err(|e| e.to_string())?;
    }
    Ok(wanted)
}

fn image_type(file: &std::path::Path) -> &'static str {
    match file.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

/// `mdr://localhost/<folder id>/<path>`: the images a note links to. Same guard as the notes,
/// images only.
fn asset_response(state: &AppState, uri_path: &str) -> Response<Vec<u8>> {
    let refuse = |status: u16| Response::builder().status(status).body(Vec::new()).unwrap();
    let decoded = percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8_lossy();
    let Some((root, rel)) = decoded.split_once('/') else { return refuse(400) };
    let resolved = match state.store.lock().unwrap().resolve_inside(root, rel, IMAGE_EXTS) {
        Ok(resolved) => resolved,
        Err(err) => {
            return refuse(match err.kind {
                Kind::BadRequest => 400,
                Kind::Forbidden => 403,
                Kind::NotFound => 404,
            })
        }
    };
    match fs::read(&resolved.file) {
        Ok(bytes) => Response::builder()
            .status(200)
            .header("Content-Type", image_type(&resolved.file))
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-cache")
            // An SVG shown as a page could run script; sandbox it. As <img> it never does.
            .header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
            .body(bytes)
            .unwrap(),
        Err(_) => refuse(404),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            store: Mutex::new(RootStore::new(default_config_path())),
            watcher: Mutex::new(None),
        })
        .register_uri_scheme_protocol("mdr", |context, request| {
            let state = context.app_handle().state::<AppState>();
            asset_response(&state, request.uri().path())
        })
        .invoke_handler(tauri::generate_handler![
            list_roots,
            add_root,
            remove_root,
            tree,
            read_doc,
            watch_doc,
            unwatch_doc,
            pick_folder,
            open_external,
            set_fullscreen
        ])
        .run(tauri::generate_context!())
        .expect("md-reader could not start");
}

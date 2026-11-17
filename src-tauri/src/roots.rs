//! The list of allowed sources and the path guard. Every command that reads from disk goes through
//! `RootStore::resolve_inside`, the only place that turns a request into a file path.
//!
//! A source is a folder (all its `.md` files) or a single `.md` file. In the config file a
//! plain folder is a string; anything else is `{ path, kind: "folder" | "file", github? }`,
//! where `github` describes the repository a downloaded copy came from (`github.rs`).

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fmt;
use std::fs;
use std::iter::Peekable;
use std::path::{Component, Path, PathBuf};
use std::str::Chars;

pub const DOC_EXTS: &[&str] = &["md"];
pub const IMAGE_EXTS: &[&str] = &["svg", "png", "jpg", "jpeg", "gif", "webp"];

const SKIP_DIRS: &[&str] = &["node_modules"];
const MAX_TREE_DEPTH: usize = 8;
const MAX_TREE_FILES: usize = 5000;
const MAX_SETTINGS_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    BadRequest,
    Forbidden,
    NotFound,
}

#[derive(Debug)]
pub struct GuardError {
    pub kind: Kind,
    pub message: String,
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

fn fail<T>(kind: Kind, message: &str) -> Result<T, GuardError> {
    Err(GuardError { kind, message: message.to_string() })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Folder,
    File,
}

/// Where a downloaded copy came from. `dir` is the clone on disk; the page never sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Github {
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sub: String,
    pub dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GithubInfo {
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sub: String,
}

#[derive(Debug, Clone)]
pub struct Root {
    pub id: String,
    pub path: PathBuf,
    pub kind: SourceKind,
    pub github: Option<Github>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RootInfo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub github: Option<GithubInfo>,
    pub missing: bool,
}

/// One entry of "roots" in the config file -> a source, or None when it is not valid.
fn read_entry(entry: &serde_json::Value) -> Option<Root> {
    if let Some(text) = entry.as_str() {
        let path = PathBuf::from(text);
        return path.is_absolute().then(|| Root { id: root_id(&path), path, kind: SourceKind::Folder, github: None });
    }
    let path = PathBuf::from(entry.get("path")?.as_str()?);
    if !path.is_absolute() {
        return None;
    }
    let kind = match entry.get("kind")?.as_str()? {
        "folder" => SourceKind::Folder,
        "file" => SourceKind::File,
        _ => return None,
    };
    let github = entry
        .get("github")
        .and_then(|g| serde_json::from_value::<Github>(g.clone()).ok())
        .filter(|g| Path::new(&g.dir).is_absolute());
    Some(Root { id: root_id(&path), path, kind, github })
}

fn write_entry(root: &Root) -> serde_json::Value {
    let path = root.path.to_string_lossy().into_owned();
    match (&root.kind, &root.github) {
        (SourceKind::Folder, None) => serde_json::json!(path),
        (kind, github) => {
            let mut entry = serde_json::json!({
                "path": path,
                "kind": if *kind == SourceKind::File { "file" } else { "folder" },
            });
            if let Some(github) = github {
                entry["github"] = serde_json::json!(github);
            }
            entry
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Node {
    Dir { name: String, path: String, children: Vec<Node> },
    File { name: String, path: String },
}

#[derive(Debug, Serialize)]
pub struct Tree {
    pub nodes: Vec<Node>,
    pub truncated: bool,
}

#[derive(Debug)]
pub struct Resolved {
    /// The real file, symlinks resolved.
    pub file: PathBuf,
    /// Its path relative to the folder, with `/` separators.
    pub rel: String,
}

pub struct RootStore {
    file: PathBuf,
    roots: Vec<Root>,
}

pub fn default_config_path() -> PathBuf {
    // An empty variable counts as unset.
    if let Some(path) = std::env::var_os("MD_READER_CONFIG").filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config"));
    base.join("md-reader").join("config.json")
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// A source downloaded from GitHub must be, links resolved, inside the folder of its download.
fn require_inside_copy(real: &Path, github: &Github) -> Result<(), GuardError> {
    match fs::canonicalize(&github.dir) {
        Ok(copy) if real.starts_with(&copy) => Ok(()),
        _ => fail(Kind::Forbidden, "This source leads outside its downloaded copy."),
    }
}

/// True for a folder that is too much to open as a side effect of adding one file in it: the
/// top of the disk and the home folder.
fn too_broad(dir: &Path, home: &Path) -> bool {
    dir.parent().is_none() || dir == fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf())
}

fn expand_home(input: &str) -> PathBuf {
    if input == "~" {
        home_dir()
    } else if let Some(rest) = input.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(input)
    }
}

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| exts.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Stable id for a folder path (FNV-1a, 64 bit). Only has to be the same from run to run.
fn root_id(path: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

impl RootStore {
    pub fn new(file: PathBuf) -> Self {
        let mut store = RootStore { file, roots: Vec::new() };
        store.load();
        store
    }

    fn load(&mut self) {
        self.roots.clear();
        let Ok(text) = fs::read_to_string(&self.file) else { return };
        let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) else { return };
        let Some(list) = data.get("roots").and_then(|r| r.as_array()) else { return };
        for root in list.iter().filter_map(read_entry) {
            if !self.roots.iter().any(|r| r.path == root.path) {
                self.roots.push(root);
            }
        }
    }

    /// The whole config file as it is on disk now, or an empty object.
    fn read_file(&self) -> serde_json::Map<String, serde_json::Value> {
        fs::read_to_string(&self.file)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|data| data.as_object().cloned())
            .unwrap_or_default()
    }

    /// Writes one key of the config file and keeps the rest as it is on disk, so two
    /// running copies of the app (which share the file) do not undo each other's changes.
    fn write(&self, key: &str, value: serde_json::Value) -> std::io::Result<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut data = self.read_file();
        data.insert(key.to_string(), value);
        let text = serde_json::to_string_pretty(&serde_json::Value::Object(data))? + "\n";
        let tmp = self.file.with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&tmp, text)?;
        fs::rename(&tmp, &self.file)
    }

    fn save(&self) -> std::io::Result<()> {
        let entries: Vec<serde_json::Value> = self.roots.iter().map(write_entry).collect();
        self.write("roots", serde_json::json!(entries))
    }

    /// Fonts and colours. Stored as given; the page checks every value before using it
    /// (`public/settings.js`), so this only keeps the file small and well-formed.
    pub fn settings(&self) -> serde_json::Value {
        self.read_file().remove("settings").filter(|s| s.is_object()).unwrap_or_else(|| serde_json::json!({}))
    }

    pub fn save_settings(&self, settings: serde_json::Value) -> Result<(), GuardError> {
        if !settings.is_object() {
            return fail(Kind::BadRequest, "Settings must be an object.");
        }
        if settings.to_string().len() > MAX_SETTINGS_BYTES {
            return fail(Kind::BadRequest, "Settings are too large.");
        }
        self.write("settings", settings).or_else(|_| fail(Kind::BadRequest, "The settings could not be saved."))
    }

    fn info(root: &Root) -> RootInfo {
        RootInfo {
            id: root.id.clone(),
            path: root.path.to_string_lossy().into_owned(),
            name: root
                .path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| root.path.to_string_lossy().into_owned()),
            kind: if root.kind == SourceKind::File { "file" } else { "folder" },
            github: root.github.as_ref().map(|g| GithubInfo {
                repo: g.repo.clone(),
                git_ref: g.git_ref.clone(),
                sub: g.sub.clone(),
            }),
            missing: if root.kind == SourceKind::File { !root.path.is_file() } else { !root.path.is_dir() },
        }
    }

    pub fn list(&self) -> Vec<RootInfo> {
        self.roots.iter().map(Self::info).collect()
    }

    pub fn add(&mut self, input: &str) -> Result<RootInfo, GuardError> {
        let input = input.trim();
        if input.is_empty() || input.contains('\0') {
            return fail(Kind::BadRequest, "Give the path of a folder.");
        }
        self.load(); // another running copy may have changed the list since it was read
        let wanted = expand_home(input);
        if !wanted.is_absolute() {
            return fail(Kind::BadRequest, "The path must be absolute (start with / or ~).");
        }
        let Ok(real) = fs::canonicalize(&wanted) else {
            return fail(Kind::NotFound, "That folder does not exist.");
        };
        if !real.is_dir() {
            return fail(Kind::BadRequest, "That path is a file, not a folder.");
        }
        if real.parent().is_none() {
            return fail(Kind::BadRequest, "The whole disk cannot be added. Pick a folder.");
        }
        self.put(Root { id: root_id(&real), path: real, kind: SourceKind::Folder, github: None })
    }

    /// One `.md` file. Only that file can be opened, plus images in its own folder or below.
    pub fn add_file(&mut self, input: &str, github: Option<Github>) -> Result<RootInfo, GuardError> {
        let input = input.trim();
        if input.is_empty() || input.contains('\0') {
            return fail(Kind::BadRequest, "Give the path of a Markdown file.");
        }
        self.load();
        let wanted = expand_home(input);
        if !wanted.is_absolute() {
            return fail(Kind::BadRequest, "The path must be absolute (start with / or ~).");
        }
        let Ok(real) = fs::canonicalize(&wanted) else {
            return fail(Kind::NotFound, "That file does not exist.");
        };
        if !real.is_file() {
            return fail(Kind::BadRequest, "That path is not a file.");
        }
        if !has_ext(&real, DOC_EXTS) {
            return fail(Kind::Forbidden, "Only Markdown (.md) files can be added.");
        }
        if let Some(github) = &github {
            require_inside_copy(&real, github)?;
        }
        self.put(Root { id: root_id(&real), path: real, kind: SourceKind::File, github })
    }

    /// A downloaded copy of a GitHub folder (`github.rs` made it and says where it is).
    pub fn add_github_folder(&mut self, dir: &Path, github: Github) -> Result<RootInfo, GuardError> {
        self.load();
        let Ok(real) = fs::canonicalize(dir) else {
            return fail(Kind::NotFound, "That folder does not exist.");
        };
        if !real.is_dir() {
            return fail(Kind::BadRequest, "That path is a file, not a folder.");
        }
        require_inside_copy(&real, &github)?;
        self.put(Root { id: root_id(&real), path: real, kind: SourceKind::Folder, github: Some(github) })
    }

    fn put(&mut self, root: Root) -> Result<RootInfo, GuardError> {
        if let Some(existing) = self.roots.iter().find(|r| r.path == root.path) {
            return Ok(Self::info(existing));
        }
        self.roots.push(root);
        if self.save().is_err() {
            self.roots.pop();
            return fail(Kind::BadRequest, "The folder list could not be saved.");
        }
        Ok(Self::info(self.roots.last().expect("just pushed")))
    }

    pub fn config_file(&self) -> PathBuf {
        self.file.clone()
    }

    pub fn get(&self, id: &str) -> Option<Root> {
        self.roots.iter().find(|r| r.id == id).cloned()
    }

    /// Returns the entry that was removed.
    pub fn remove(&mut self, id: &str) -> Result<Root, GuardError> {
        self.load();
        let Some(index) = self.roots.iter().position(|r| r.id == id) else {
            return fail(Kind::NotFound, "Unknown folder.");
        };
        let removed = self.roots.remove(index);
        if self.save().is_err() {
            self.roots.insert(index, removed);
            return fail(Kind::BadRequest, "The folder list could not be saved.");
        }
        Ok(removed)
    }

    /// Turns (folder id, relative path) into a real file path, or refuses. Rules, in order: the
    /// folder must be in the list; the extension must be allowed; the path must not climb out
    /// with `..`; the real path (symlinks resolved) must stay inside the real folder; the real
    /// file's extension must be allowed too. For a single-file source the "folder" is the file's
    /// folder, and the only `.md` file that can be opened is the file itself.
    pub fn resolve_inside(&self, id: &str, rel: &str, exts: &[&str]) -> Result<Resolved, GuardError> {
        let Some(root) = self.roots.iter().find(|r| r.id == id) else {
            return fail(Kind::NotFound, "Unknown folder.");
        };
        if rel.is_empty() || rel.contains('\0') {
            return fail(Kind::BadRequest, "Missing path.");
        }
        if !has_ext(Path::new(rel), exts) {
            return fail(Kind::Forbidden, "This file type cannot be opened.");
        }
        let single = root.kind == SourceKind::File;
        let Ok(source_real) = fs::canonicalize(&root.path) else {
            return fail(Kind::NotFound, if single { "The file no longer exists." } else { "The folder no longer exists." });
        };
        // A repository may hold links; a downloaded source never reads outside its own copy.
        if let Some(github) = &root.github {
            require_inside_copy(&source_real, github)?;
        }
        let root_real = match (single, source_real.parent()) {
            (true, Some(parent)) => parent.to_path_buf(),
            (true, None) => return fail(Kind::NotFound, "The file no longer exists."),
            (false, _) => source_real.clone(),
        };
        // A file kept directly in the home folder or at the top of the disk must not open every
        // image below it: for such a file only the note itself is served.
        if single && !has_ext(Path::new(rel), DOC_EXTS) && too_broad(&root_real, &home_dir()) {
            return fail(Kind::Forbidden, "Images are not shown for a file kept directly in the home folder.");
        }
        let mut candidate = root_real.clone();
        let mut depth = 0usize;
        for part in Path::new(rel).components() {
            match part {
                Component::Normal(name) => {
                    candidate.push(name);
                    depth += 1;
                }
                Component::CurDir => {}
                Component::ParentDir if depth > 0 => {
                    candidate.pop();
                    depth -= 1;
                }
                _ => return fail(Kind::Forbidden, "Path is outside the folder."),
            }
        }
        let Ok(real) = fs::canonicalize(&candidate) else {
            return fail(Kind::NotFound, "File not found.");
        };
        if !real.starts_with(&root_real) {
            return fail(Kind::Forbidden, "Path is outside the folder.");
        }
        if !has_ext(&real, exts) {
            return fail(Kind::Forbidden, "This file type cannot be opened.");
        }
        if single && has_ext(&real, DOC_EXTS) && real != source_real {
            return fail(Kind::Forbidden, "Only the file that was added can be opened.");
        }
        if !fs::metadata(&real).map(|m| m.is_file()).unwrap_or(false) {
            return fail(Kind::NotFound, "File not found.");
        }
        let rel = real
            .strip_prefix(&root_real)
            .expect("checked above")
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        Ok(Resolved { file: real, rel })
    }

    /// Nested list of the `.md` files under a folder. Symlinks are not followed.
    pub fn tree(&self, id: &str) -> Result<Tree, GuardError> {
        let Some(root) = self.roots.iter().find(|r| r.id == id) else {
            return fail(Kind::NotFound, "Unknown folder.");
        };
        if root.kind == SourceKind::File {
            if !root.path.is_file() {
                return fail(Kind::NotFound, "The file no longer exists.");
            }
            let name = root.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            return Ok(Tree { nodes: vec![Node::File { name: name.clone(), path: name }], truncated: false });
        }
        if !root.path.is_dir() {
            return fail(Kind::NotFound, "The folder no longer exists.");
        }
        let mut left = MAX_TREE_FILES;
        let nodes = walk(&root.path, "", 0, &mut left);
        Ok(Tree { nodes, truncated: left == 0 })
    }
}

fn walk(abs: &Path, rel: &str, depth: usize, left: &mut usize) -> Vec<Node> {
    let mut dirs: Vec<(String, Node)> = Vec::new();
    let mut files: Vec<(String, Node)> = Vec::new();
    let Ok(entries) = fs::read_dir(abs) else { return Vec::new() };
    for entry in entries.flatten() {
        if *left == 0 {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if kind.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || depth >= MAX_TREE_DEPTH {
                continue;
            }
            let children = walk(&entry.path(), &child_rel, depth + 1, left);
            if !children.is_empty() {
                dirs.push((name.clone(), Node::Dir { name, path: child_rel, children }));
            }
        } else if kind.is_file() && has_ext(Path::new(&name), DOC_EXTS) {
            *left -= 1;
            files.push((name.clone(), Node::File { name, path: child_rel }));
        }
    }
    dirs.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    files.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    dirs.into_iter().chain(files).map(|(_, node)| node).collect()
}

/// Case-insensitive order in which "p3l2" comes before "p3l10".
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut left, mut right) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                match take_number(&mut left).cmp(&take_number(&mut right)) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                left.next();
                right.next();
            }
        }
    }
}

fn take_number(chars: &mut Peekable<Chars<'_>>) -> u128 {
    let mut number = 0u128;
    while let Some(digit) = chars.peek().and_then(|c| c.to_digit(10)) {
        number = number.saturating_mul(10).saturating_add(u128::from(digit));
        chars.next();
    }
    number
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        store: RootStore,
        id: String,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn fixture() -> Fixture {
        let n = COUNTER.fetch_add(1, AtomicOrdering::SeqCst);
        let base = std::env::temp_dir().join(format!("mdr-test-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(&base).unwrap();
        let root = base.join("notes");
        for dir in ["diagrams", "sub", "node_modules/pkg", ".hidden", "empty"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        for (file, text) in [
            ("a.md", "# A"),
            ("B.MD", "# B"),
            ("a.pdf", "pdf"),
            ("sub/c.md", "# C"),
            ("node_modules/pkg/README.md", "x"),
            (".hidden/h.md", "x"),
            ("diagrams/d.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
        ] {
            fs::write(root.join(file), text).unwrap();
        }
        fs::write(base.join("secret.md"), "secret").unwrap();
        symlink(base.join("secret.md"), root.join("escape.md")).unwrap();
        symlink(root.join("a.pdf"), root.join("disguised.md")).unwrap();
        symlink(&base, root.join("up")).unwrap();
        let mut store = RootStore::new(base.join("config").join("config.json"));
        let id = store.add(root.to_str().unwrap()).unwrap().id;
        Fixture { base, root, store, id }
    }

    fn kind(result: Result<Resolved, GuardError>) -> Kind {
        result.expect_err("should be refused").kind
    }

    #[test]
    fn opens_md_files_inside_an_added_folder() {
        let f = fixture();
        assert_eq!(f.store.resolve_inside(&f.id, "a.md", DOC_EXTS).unwrap().file, f.root.join("a.md"));
        assert_eq!(f.store.resolve_inside(&f.id, "sub/c.md", DOC_EXTS).unwrap().rel, "sub/c.md");
        assert_eq!(f.store.resolve_inside(&f.id, "./sub/../B.MD", DOC_EXTS).unwrap().rel, "B.MD");
    }

    #[test]
    fn refuses_anything_that_is_not_md_as_a_document() {
        let f = fixture();
        assert_eq!(kind(f.store.resolve_inside(&f.id, "a.pdf", DOC_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&f.id, "diagrams/d.svg", DOC_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&f.id, "sub", DOC_EXTS)), Kind::Forbidden);
    }

    #[test]
    fn refuses_paths_that_leave_the_folder() {
        let f = fixture();
        assert_eq!(kind(f.store.resolve_inside(&f.id, "../secret.md", DOC_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&f.id, "sub/../../secret.md", DOC_EXTS)), Kind::Forbidden);
        let absolute = f.base.join("secret.md");
        assert_eq!(kind(f.store.resolve_inside(&f.id, absolute.to_str().unwrap(), DOC_EXTS)), Kind::Forbidden);
    }

    #[test]
    fn refuses_symlinks_that_leave_the_folder_or_hide_another_file_type() {
        let f = fixture();
        assert_eq!(kind(f.store.resolve_inside(&f.id, "escape.md", DOC_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&f.id, "up/secret.md", DOC_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&f.id, "disguised.md", DOC_EXTS)), Kind::Forbidden);
    }

    #[test]
    fn unknown_folders_and_missing_files_are_not_found() {
        let f = fixture();
        assert_eq!(kind(f.store.resolve_inside("nope", "a.md", DOC_EXTS)), Kind::NotFound);
        assert_eq!(kind(f.store.resolve_inside(&f.id, "missing.md", DOC_EXTS)), Kind::NotFound);
        assert_eq!(kind(f.store.resolve_inside(&f.id, "", DOC_EXTS)), Kind::BadRequest);
    }

    #[test]
    fn assets_are_images_only() {
        let f = fixture();
        assert!(f.store.resolve_inside(&f.id, "diagrams/d.svg", IMAGE_EXTS).unwrap().file.ends_with("d.svg"));
        assert_eq!(kind(f.store.resolve_inside(&f.id, "a.md", IMAGE_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&f.id, "a.pdf", IMAGE_EXTS)), Kind::Forbidden);
    }

    #[test]
    fn tree_lists_only_md_files_and_skips_hidden_folders_node_modules_and_symlinks() {
        let f = fixture();
        fn flatten(nodes: &[Node], out: &mut Vec<String>) {
            for node in nodes {
                match node {
                    Node::Dir { children, .. } => flatten(children, out),
                    Node::File { path, .. } => out.push(path.clone()),
                }
            }
        }
        let mut paths = Vec::new();
        flatten(&f.store.tree(&f.id).unwrap().nodes, &mut paths);
        assert_eq!(paths, ["sub/c.md", "a.md", "B.MD"]);
    }

    #[test]
    fn folders_persist_deduplicate_and_stop_being_readable_once_removed() {
        let mut f = fixture();
        let again = format!("{}/", f.root.display());
        assert_eq!(f.store.add(&again).unwrap().id, f.id);
        assert_eq!(RootStore::new(f.store.file.clone()).list().len(), 1);
        let id = f.id.clone();
        f.store.remove(&id).unwrap();
        assert_eq!(kind(f.store.resolve_inside(&id, "a.md", DOC_EXTS)), Kind::NotFound);
        assert_eq!(RootStore::new(f.store.file.clone()).list().len(), 0);
    }

    #[test]
    fn add_refuses_files_missing_paths_relative_paths_and_the_disk_root() {
        let mut f = fixture();
        let file = f.root.join("a.md");
        let missing = f.root.join("nope");
        assert_eq!(f.store.add(file.to_str().unwrap()).unwrap_err().kind, Kind::BadRequest);
        assert_eq!(f.store.add(missing.to_str().unwrap()).unwrap_err().kind, Kind::NotFound);
        assert_eq!(f.store.add("notes").unwrap_err().kind, Kind::BadRequest);
        assert_eq!(f.store.add("/").unwrap_err().kind, Kind::BadRequest);
    }

    #[test]
    fn settings_are_kept_next_to_the_folders_and_neither_overwrites_the_other() {
        let mut f = fixture();
        assert_eq!(f.store.settings(), serde_json::json!({}));
        f.store.save_settings(serde_json::json!({ "preset": "dark" })).unwrap();
        assert_eq!(f.store.save_settings(serde_json::json!("dark")).unwrap_err().kind, Kind::BadRequest);
        let big = serde_json::json!({ "x": "y".repeat(9000) });
        assert_eq!(f.store.save_settings(big).unwrap_err().kind, Kind::BadRequest);
        let sub = f.root.join("sub");
        f.store.add(sub.to_str().unwrap()).unwrap();
        let reloaded = RootStore::new(f.store.file.clone());
        assert_eq!(reloaded.list().len(), 2);
        assert_eq!(reloaded.settings(), serde_json::json!({ "preset": "dark" }));
    }

    #[test]
    fn natural_order_is_case_insensitive_and_numeric() {
        let mut names = vec!["p3l10.md", "B.md", "p3l2.md", "a.md"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["a.md", "B.md", "p3l2.md", "p3l10.md"]);
    }

    #[test]
    fn a_single_file_only_that_file_opens_plus_images_in_its_folder_or_below() {
        let mut f = fixture();
        let id = f.store.add_file(f.root.join("a.md").to_str().unwrap(), None).unwrap().id;
        assert_eq!(f.store.list().iter().find(|r| r.id == id).unwrap().kind, "file");
        assert_eq!(f.store.resolve_inside(&id, "a.md", DOC_EXTS).unwrap().file, f.root.join("a.md"));
        let tree = f.store.tree(&id).unwrap();
        assert!(matches!(&tree.nodes[..], [Node::File { name, path }] if name == "a.md" && path == "a.md"));
        // Other notes of the same folder stay closed, by name, by sub-folder and by symlink.
        assert_eq!(kind(f.store.resolve_inside(&id, "B.MD", DOC_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&id, "sub/c.md", DOC_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&id, "escape.md", DOC_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&id, "../secret.md", DOC_EXTS)), Kind::Forbidden);
        // Images: its own folder or below, never above.
        assert_eq!(f.store.resolve_inside(&id, "diagrams/d.svg", IMAGE_EXTS).unwrap().rel, "diagrams/d.svg");
        assert_eq!(kind(f.store.resolve_inside(&id, "../x.svg", IMAGE_EXTS)), Kind::Forbidden);
        assert_eq!(kind(f.store.resolve_inside(&id, "a.pdf", IMAGE_EXTS)), Kind::Forbidden);
        // A symlink added as the file is followed once, when it is added.
        let via_link = f.store.add_file(f.root.join("escape.md").to_str().unwrap(), None).unwrap();
        assert_eq!(via_link.path, f.base.join("secret.md").to_string_lossy());
        fs::write(f.base.join("other.md"), "x").unwrap();
        assert_eq!(kind(f.store.resolve_inside(&via_link.id, "other.md", DOC_EXTS)), Kind::Forbidden);
    }

    #[test]
    fn a_file_in_the_home_folder_or_at_the_top_of_the_disk_opens_no_images() {
        let f = fixture();
        assert!(too_broad(Path::new("/"), &f.root));
        assert!(too_broad(&f.root, &f.root));
        assert!(!too_broad(&f.root.join("sub"), &f.root));
    }

    #[test]
    fn a_source_from_github_never_leads_outside_its_downloaded_copy() {
        let mut f = fixture();
        let github = |dir: &Path| Github { repo: "octo/notes".into(), git_ref: "main".into(), sub: "sub".into(), dir: dir.to_string_lossy().into_owned() };
        // Links committed in a repository: a folder and a file that point out of the copy.
        let _ = symlink(&f.base, f.root.join("up")); // the fixture may have it
        assert_eq!(f.store.add_github_folder(&f.root.join("up"), github(&f.root)).unwrap_err().kind, Kind::Forbidden);
        assert_eq!(f.store.add_file(f.root.join("escape.md").to_str().unwrap(), Some(github(&f.root))).unwrap_err().kind, Kind::Forbidden);
        assert_eq!(f.store.add_github_folder(&f.root.join("sub"), github(&f.base.join("nowhere"))).unwrap_err().kind, Kind::Forbidden);
        let id = f.store.add_github_folder(&f.root.join("sub"), github(&f.root)).unwrap().id;
        assert_eq!(f.store.resolve_inside(&id, "c.md", DOC_EXTS).unwrap().rel, "c.md");
        // An update turns the folder into a link: nothing is read through it.
        fs::remove_dir_all(f.root.join("sub")).unwrap();
        symlink(&f.base, f.root.join("sub")).unwrap();
        assert_eq!(kind(f.store.resolve_inside(&id, "secret.md", DOC_EXTS)), Kind::Forbidden);
    }

    #[test]
    fn add_file_refuses_folders_other_file_types_and_missing_files() {
        let mut f = fixture();
        let root = f.root.clone();
        let add = |store: &mut RootStore, p: PathBuf| store.add_file(p.to_str().unwrap(), None).expect_err("refused").kind;
        assert_eq!(add(&mut f.store, root.clone()), Kind::BadRequest);
        assert_eq!(add(&mut f.store, root.join("a.pdf")), Kind::Forbidden);
        assert_eq!(add(&mut f.store, root.join("disguised.md")), Kind::Forbidden);
        assert_eq!(add(&mut f.store, root.join("nope.md")), Kind::NotFound);
        assert_eq!(f.store.add_file("a.md", None).expect_err("refused").kind, Kind::BadRequest);
    }

    #[test]
    fn folders_and_single_files_are_kept_together_in_the_config_file() {
        let mut f = fixture();
        let file = f.store.add_file(f.root.join("sub/c.md").to_str().unwrap(), None).unwrap();
        let config = f.base.join("config").join("config.json");
        let saved: serde_json::Value = serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(
            saved["roots"],
            serde_json::json!([f.root.to_str().unwrap(), { "path": f.root.join("sub/c.md").to_str().unwrap(), "kind": "file" }])
        );
        let mut reloaded = RootStore::new(config);
        assert_eq!(reloaded.list().iter().map(|r| r.kind).collect::<Vec<_>>(), ["folder", "file"]);
        reloaded.remove(&f.id).unwrap();
        assert_eq!(kind(reloaded.resolve_inside(&f.id, "a.md", DOC_EXTS)), Kind::NotFound);
        assert_eq!(reloaded.resolve_inside(&file.id, "c.md", DOC_EXTS).unwrap().rel, "c.md");
    }
}

//! GitHub sources: a folder or one `.md` file of a repository, downloaded with `git` into the
//! app's own data folder and then read like any local source (same path guard, `.md` only).
//!
//! - The copy is read-only from the app's side: it is cloned, fetched and reset, never
//!   committed to or pushed.
//! - Only what is asked for is downloaded: a shallow, sparse clone without blobs
//!   (`git clone --depth 1 --filter=blob:none --sparse` plus `git sparse-checkout set`).
//! - Submodules inside a downloaded folder are read too (`Submodules`): the commit the
//!   repository names is fetched and its files are put into the same copy, so the path guard
//!   needs no other rule for them. Their addresses come from `.gitmodules`, which is text from
//!   the repository: each is checked by `submodule_repo` and `git` only ever sees an address
//!   built here from the owner and name that passed.
//! - A token for private repositories is kept in its own file (mode 0600) next to the config
//!   file. It is handed to `git` through the environment for one command at a time; it is
//!   never written into the clone, its URL or its `.git/config`, and never sent to the page.

use crate::roots::{Github, GuardError, Kind, Root, SourceKind};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(180);

fn fail<T>(kind: Kind, message: &str) -> Result<T, GuardError> {
    Err(GuardError { kind, message: message.to_string() })
}

/// What a GitHub address names. `git_ref` is empty for the default branch, `sub` is empty for
/// the whole repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    pub owner: String,
    pub repo: String,
    pub git_ref: String,
    pub sub: String,
    pub kind: SourceKind,
}

fn is_owner(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && text.len() <= 39
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn is_repo(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 100
        && text != "."
        && text != ".."
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn is_ref(text: &str, slashes: bool) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && text.len() <= 200
        && !text.contains("..")
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') || (slashes && c == '/'))
}

/// A path segment that is safe as a sparse-checkout folder and as a file name.
fn is_segment(text: &str) -> bool {
    !text.is_empty()
        && text != "."
        && text != ".."
        && !text.starts_with('-')
        && text == text.trim()
        && !text.chars().any(|c| (c as u32) < 0x20 || matches!(c, '/' | '\\' | '*' | '?' | '[' | ']' | '!' | '#'))
}

fn is_token(text: &str) -> bool {
    (20..=255).contains(&text.len()) && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_md(path: &str) -> bool {
    path.len() > 3 && path.to_ascii_lowercase().ends_with(".md")
}

/// `https://github.com/owner/repo`, `.../tree/<branch>/<folder>`, `.../blob/<branch>/<file>.md`
/// or `owner/repo`. A branch name with a `/` in it cannot be told apart from a folder in such
/// an address, so it is not supported.
pub fn parse_github_url(input: &str) -> Result<Spec, GuardError> {
    let mut text = input.trim();
    if text.is_empty() || text.len() > 2000 {
        return fail(Kind::BadRequest, "Give the address of a GitHub repository, folder or file.");
    }
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("git@github.com:") {
        text = &text["git@github.com:".len()..];
    } else if lower.contains("://") || lower.starts_with("github.com/") || lower.starts_with("www.github.com/") {
        let rest = match lower.find("://") {
            Some(at) if &lower[..at] == "https" => &text[at + 3..],
            Some(_) => return fail(Kind::BadRequest, "Only https://github.com addresses can be added."),
            None => text,
        };
        let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
        if !matches!(host.to_ascii_lowercase().as_str(), "github.com" | "www.github.com") {
            return fail(Kind::BadRequest, "Only https://github.com addresses can be added.");
        }
        text = path.split(['?', '#']).next().unwrap_or("");
    }
    let mut parts = Vec::new();
    for part in text.split('/').filter(|p| !p.is_empty()) {
        match percent_decode_str(part).decode_utf8() {
            Ok(decoded) => parts.push(decoded.into_owned()),
            Err(_) => return fail(Kind::BadRequest, "That is not a valid address."),
        }
    }
    if parts.len() < 2 {
        return fail(Kind::BadRequest, "The address must name a repository: github.com/owner/repository.");
    }
    let owner = parts[0].clone();
    let repo = match parts[1].to_ascii_lowercase().strip_suffix(".git") {
        Some(_) => parts[1][..parts[1].len() - 4].to_string(),
        None => parts[1].clone(),
    };
    if !is_owner(&owner) || !is_repo(&repo) {
        return fail(Kind::BadRequest, "That is not a GitHub repository name.");
    }
    let Some(marker) = parts.get(2) else {
        return Ok(Spec { owner, repo, git_ref: String::new(), sub: String::new(), kind: SourceKind::Folder });
    };
    if marker != "tree" && marker != "blob" {
        return fail(Kind::BadRequest, "Give the address of a repository, of a folder in it, or of a .md file in it.");
    }
    let git_ref = parts.get(3).cloned().unwrap_or_default();
    if !is_ref(&git_ref, false) {
        return fail(Kind::BadRequest, "The branch name in that address cannot be used.");
    }
    let rest = &parts[4.min(parts.len())..];
    if !rest.iter().all(|part| is_segment(part)) {
        return fail(Kind::BadRequest, "The path in that address cannot be used.");
    }
    let sub = rest.join("/");
    if marker == "tree" {
        return Ok(Spec { owner, repo, git_ref, sub, kind: SourceKind::Folder });
    }
    if !is_md(&sub) {
        return fail(Kind::Forbidden, "Only Markdown (.md) files can be added.");
    }
    Ok(Spec { owner, repo, git_ref, sub, kind: SourceKind::File })
}

/// The same repository and branch as `spec`, narrowed to one of its folders (chosen from the
/// list that `folders` gave). The folder is checked like the path of an address.
pub fn with_folder(mut spec: Spec, sub: &str) -> Result<Spec, GuardError> {
    if spec.kind != SourceKind::Folder || !spec.sub.is_empty() || !is_folder_path(sub) {
        return fail(Kind::BadRequest, "That folder cannot be added.");
    }
    spec.sub = sub.to_string();
    Ok(spec)
}

fn is_folder_path(sub: &str) -> bool {
    sub.len() <= 1000 && sub.split('/').all(is_segment)
}

fn is_sha(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

fn is_hidden(segment: &str) -> bool {
    segment.starts_with('.') || segment == "node_modules"
}

/// The repository that the address of a submodule names, as (owner, name), or None when it is
/// not one on GitHub. `parent` is the `owner/name` of the repository whose `.gitmodules` holds
/// the address: one like `../other.git` is relative to it. The web version has the same rules
/// (`submoduleRepo` in `public/github-url.js`).
pub fn submodule_repo(parent: &str, address: &str) -> Option<(String, String)> {
    const HOSTS: [&str; 5] = ["https://github.com/", "https://www.github.com/", "git@github.com:", "ssh://git@github.com/", "git://github.com/"];
    let address = address.trim();
    let mut parts: Vec<&str> = Vec::new();
    if address.starts_with("./") || address.starts_with("../") {
        parts.extend(parent.split('/'));
        if parts.len() != 2 {
            return None;
        }
        for part in address.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop()?;
                }
                name => parts.push(name),
            }
        }
    } else {
        let lower = address.to_ascii_lowercase();
        let host = HOSTS.iter().find(|host| lower.starts_with(*host))?;
        parts.extend(address[host.len()..].split('/').filter(|p| !p.is_empty()));
    }
    let [owner, repo] = parts[..] else { return None };
    let repo = if repo.to_ascii_lowercase().ends_with(".git") { &repo[..repo.len() - 4] } else { repo };
    (is_owner(owner) && is_repo(repo)).then(|| (owner.to_string(), repo.to_string()))
}

/// True when a submodule at `path` belongs to a source that is the folder `scope` ("" is the
/// whole repository): it is that folder, lies inside it, or holds it.
fn in_scope(path: &str, scope: &str) -> bool {
    scope.is_empty() || path == scope || path.starts_with(&format!("{scope}/")) || scope.starts_with(&format!("{path}/"))
}

// ---------- Where things are kept ----------

/// With `MD_READER_CONFIG` (a scratch folder list for testing) the downloads go next to that
/// file, so a test never touches the copies of the real folder list.
pub fn data_dir() -> PathBuf {
    if let Some(config) = std::env::var_os("MD_READER_CONFIG").filter(|p| !p.is_empty()) {
        let config = std::path::absolute(PathBuf::from(config)).unwrap_or_default();
        return config.parent().unwrap_or_else(|| Path::new("/")).join("md-reader-data");
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
            home.join(".local").join("share")
        });
    base.join("md-reader")
}

fn repos_dir() -> PathBuf {
    data_dir().join("repos")
}

/// The folder of one source's clone: `repos/<owner>/<repo>/<key>`, the key naming branch and path.
fn clone_dir(spec: &Spec) -> PathBuf {
    let kind = if spec.kind == SourceKind::File { "file" } else { "folder" };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in format!("{}\n{}\n{kind}", spec.git_ref, spec.sub).bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    repos_dir().join(&spec.owner).join(&spec.repo).join(format!("{:010x}", hash & 0xff_ffff_ffff))
}

/// A short-lived folder beside the clones of a repository, for reading its list of files.
fn listing_dir(spec: &Spec) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    repos_dir().join(&spec.owner).join(&spec.repo).join(format!("list-{}-{n}", std::process::id()))
}

/// True for a folder that this module made: three levels below `repos/`.
fn is_clone_dir(dir: &Path) -> bool {
    let Ok(rel) = dir.strip_prefix(repos_dir()) else { return false };
    let parts: Vec<Component> = rel.components().collect();
    parts.len() == 3 && parts.iter().all(|part| matches!(part, Component::Normal(_)))
}

fn remove_dir(dir: &Path) {
    if !is_clone_dir(dir) {
        return;
    }
    let _ = fs::remove_dir_all(dir);
    // Empty <repo> and <owner> folders are not left behind.
    let mut parent = dir.parent();
    for _ in 0..2 {
        match parent {
            Some(p) if fs::remove_dir(p).is_ok() => parent = p.parent(),
            _ => break,
        }
    }
}

// ---------- The token ----------

fn token_file(config_file: &Path) -> PathBuf {
    config_file.parent().unwrap_or_else(|| Path::new("/")).join("github-token")
}

pub fn read_token(config_file: &Path) -> Option<String> {
    let token = fs::read_to_string(token_file(config_file)).ok()?.trim().to_string();
    is_token(&token).then_some(token)
}

pub fn has_token(config_file: &Path) -> bool {
    read_token(config_file).is_some()
}

pub fn save_token(config_file: &Path, token: &str) -> Result<(), GuardError> {
    let token = token.trim();
    if !is_token(token) {
        return fail(Kind::BadRequest, "That does not look like a GitHub token.");
    }
    let file = token_file(config_file);
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        let _ = fs::remove_file(&tmp);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut out = options.open(&tmp)?;
        out.write_all(format!("{token}\n").as_bytes())?;
        fs::rename(&tmp, &file)
    };
    write().or_else(|_| fail(Kind::BadRequest, "The token could not be saved."))
}

pub fn clear_token(config_file: &Path) {
    let _ = fs::remove_file(token_file(config_file));
}

fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let n = u32::from(chunk[0]) << 16 | u32::from(*chunk.get(1).unwrap_or(&0)) << 8 | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

// ---------- Running git ----------

fn git(args: &[&str], cwd: Option<&Path>, token: Option<&str>) -> Result<String, GuardError> {
    let mut command = Command::new("git");
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    if let Some(token) = token {
        // Sent as a request header for github.com only, for this one command.
        command
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
            .env("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {}", base64(format!("x-access-token:{token}").as_bytes())));
    }
    // Its own process group, so a timeout also stops the helpers git starts.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return fail(Kind::BadRequest, "git is not installed. It is needed to download from GitHub.")
        }
        Err(_) => return fail(Kind::BadRequest, "git could not be started."),
    };
    // The two pipes are read on their own threads so a full pipe never blocks git.
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut text);
            }
            String::from_utf8_lossy(&text).into_owned()
        })
    };
    let out = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                #[cfg(unix)]
                let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", child.id())]).status();
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // After a timeout the pipes are not waited for: a helper may still hold them open.
    let Some(status) = status else {
        return fail(Kind::BadRequest, "The download took too long and was stopped.");
    };
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    if status.success() {
        Ok(out)
    } else {
        Err(git_error(&err, token.is_some()))
    }
}

/// git's own message -> something a reader can act on. The token is never part of it.
pub fn git_error(stderr: &str, had_token: bool) -> GuardError {
    let lower = stderr.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    let (kind, message) = if has(&[
        "repository not found",
        "could not read username",
        "authentication failed",
        "terminal prompts disabled",
        "returned error: 401",
        "returned error: 403",
        "returned error: 404",
    ]) {
        let message = if had_token {
            "GitHub did not give access to that repository. Check the address, and that the saved token may read it."
        } else {
            "That repository was not found. If it is private, save a GitHub token first."
        };
        (Kind::NotFound, message.to_string())
    } else if has(&["remote branch", "couldn't find remote ref", "not our ref"]) {
        (Kind::NotFound, "That branch was not found in the repository.".to_string())
    } else if has(&["could not resolve host", "unable to access", "connection timed out", "connection refused", "failed to connect"]) {
        (Kind::BadRequest, "GitHub could not be reached. Check the network connection.".to_string())
    } else {
        let line = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("unknown error");
        (Kind::BadRequest, format!("git failed: {}", line.chars().take(300).collect::<String>()))
    };
    GuardError { kind, message }
}

// ---------- Download and update ----------

/// The folder that the sparse checkout must hold for a source ("" = only the top of the repository).
fn sparse_folder(kind: SourceKind, sub: &str) -> String {
    match kind {
        SourceKind::Folder => sub.to_string(),
        SourceKind::File => sub.rsplit_once('/').map(|(dir, _)| dir.to_string()).unwrap_or_default(),
    }
}

pub struct Download {
    /// The folder or file to add as a source.
    pub target: PathBuf,
    /// What the config file keeps about it.
    pub github: Github,
    /// Submodules inside it that could not be read.
    pub skipped: Vec<String>,
}

/// Downloads what `spec` names.
pub fn download(spec: &Spec, config_file: &Path) -> Result<Download, GuardError> {
    let token = read_token(config_file);
    let token = token.as_deref();
    let dir = clone_dir(spec);
    let target = spec.sub.split('/').filter(|p| !p.is_empty()).fold(dir.clone(), |path, part| path.join(part));
    let found = || if spec.kind == SourceKind::File { target.is_file() } else { target.is_dir() };
    let repo = format!("{}/{}", spec.owner, spec.repo);
    let made = |git_ref: String, skipped: Vec<String>| Download {
        target: target.clone(),
        github: Github { repo: repo.clone(), git_ref, sub: spec.sub.clone(), dir: dir.to_string_lossy().into_owned() },
        skipped,
    };
    // Already downloaded (the same address was added before): that copy is used as it is, never
    // deleted and fetched again. "Update" is what brings it up to date.
    if dir.join(".git").exists() && found() {
        let git_ref = if spec.git_ref.is_empty() {
            git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(&dir), None)?.trim().to_string()
        } else {
            spec.git_ref.clone()
        };
        return Ok(made(git_ref, Vec::new()));
    }
    remove_dir(&dir); // what an interrupted download left
    if dir.parent().map(fs::create_dir_all).and_then(Result::ok).is_none() {
        return fail(Kind::BadRequest, "The folder for downloads could not be made.");
    }
    let dir_text = dir.to_string_lossy().into_owned();
    let url = format!("https://github.com/{}/{}.git", spec.owner, spec.repo);
    let folder = sparse_folder(spec.kind, &spec.sub);
    let whole = spec.kind == SourceKind::Folder && spec.sub.is_empty();
    let run = || -> Result<Download, GuardError> {
        let mut args = vec!["clone", "--quiet", "--depth", "1", "--single-branch", "--no-tags", "--filter=blob:none"];
        if !whole {
            args.push("--sparse");
        }
        if !spec.git_ref.is_empty() {
            args.extend(["--branch", &spec.git_ref]);
        }
        args.extend(["--", &url, &dir_text]);
        git(&args, None, token)?;
        if !folder.is_empty() {
            git(&["sparse-checkout", "set", "--cone", "--", &folder], Some(&dir), token)?;
        }
        let skipped = if spec.kind == SourceKind::Folder { submodules(&dir, &repo, &spec.sub, token)? } else { Vec::new() };
        let git_ref = if spec.git_ref.is_empty() {
            git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(&dir), None)?.trim().to_string()
        } else {
            spec.git_ref.clone()
        };
        if !found() {
            return fail(
                Kind::NotFound,
                if spec.kind == SourceKind::File { "That file was not found in the repository." } else { "That folder was not found in the repository." },
            );
        }
        Ok(made(git_ref, skipped))
    };
    let result = run();
    if result.is_err() {
        remove_dir(&dir);
    }
    result
}

// ---------- Submodules ----------

const MAX_SUBMODULES: usize = 30;
const MAX_SUBMODULE_DEPTH: usize = 5;

/// Reads the submodules of a clone, those of submodules included. With `checkout` their files
/// are put into the working copy, each where its repository has it, and the clone is then one
/// folder of plain files (nothing in it is a repository of its own). Without, only the names of
/// all files are collected, for the list of folders.
///
/// What comes from the repository is never trusted: a path must pass the segment rule, an
/// address must name a GitHub repository (`submodule_repo`), and there is a limit on how many
/// are read and how deep. One that fails any of these, or cannot be fetched, is left out and
/// named in `skipped`.
struct Submodules<'a> {
    dir: &'a Path,
    token: Option<&'a str>,
    /// The folder of the source; submodules outside it are left alone.
    scope: &'a str,
    checkout: bool,
    taken: usize,
    files: Vec<String>,
    skipped: Vec<String>,
}

impl Submodules<'_> {
    /// `rev` is a commit of `repo` (`owner/name`) whose files are at `prefix` in the clone.
    fn walk(&mut self, prefix: &str, rev: &str, repo: &str, depth: usize) -> Result<(), GuardError> {
        let listing = git(&["ls-tree", "-r", "-z", rev], Some(self.dir), self.token)?;
        let mut links = Vec::new();
        for record in listing.split('\0') {
            // "<mode> <type> <id>\t<path>"; mode 160000 is a submodule.
            let Some((meta, name)) = record.split_once('\t') else { continue };
            let mut meta = meta.split(' ');
            let (mode, id) = (meta.next().unwrap_or(""), meta.nth(1).unwrap_or(""));
            if mode == "160000" {
                links.push((name.to_string(), id.to_string()));
            } else if !self.checkout {
                self.files.push(format!("{prefix}{name}"));
            }
        }
        links.retain(|(name, _)| {
            let path = format!("{prefix}{name}");
            !path.split('/').any(is_hidden) && in_scope(&path, self.scope)
        });
        if links.is_empty() {
            return Ok(());
        }
        let addresses = self.addresses(rev);
        for (name, id) in links {
            let path = format!("{prefix}{name}");
            let source = addresses.iter().find(|(at, _)| *at == name).and_then(|(_, address)| submodule_repo(repo, address));
            let allowed = is_folder_path(&path) && is_sha(&id) && depth < MAX_SUBMODULE_DEPTH && self.taken < MAX_SUBMODULES;
            let Some((owner, name)) = source.filter(|_| allowed) else {
                self.skipped.push(path);
                continue;
            };
            self.taken += 1;
            if self.fetch(&owner, &name, &id).and_then(|()| self.place(&path, &id)).is_err() {
                self.skipped.push(path);
                continue;
            }
            // Its own submodules; one that cannot be listed leaves the rest as it is.
            let _ = self.walk(&format!("{path}/"), &id, &format!("{owner}/{name}"), depth + 1);
        }
        Ok(())
    }

    /// (path, address) of every entry of `.gitmodules` as it is in commit `rev`.
    fn addresses(&self, rev: &str) -> Vec<(String, String)> {
        let Ok(text) = git(&["config", "--blob", &format!("{rev}:.gitmodules"), "--list", "-z"], Some(self.dir), self.token) else {
            return Vec::new();
        };
        // "submodule.<name>.path\n<value>" and "submodule.<name>.url\n<value>", in any order.
        let mut entries: Vec<(&str, Option<&str>, Option<&str>)> = Vec::new();
        for record in text.split('\0') {
            let Some((key, value)) = record.split_once('\n') else { continue };
            let Some((name, field)) = key.strip_prefix("submodule.").and_then(|rest| rest.rsplit_once('.')) else { continue };
            let at = entries.iter().position(|entry| entry.0 == name).unwrap_or_else(|| {
                entries.push((name, None, None));
                entries.len() - 1
            });
            match field {
                "path" => entries[at].1 = Some(value),
                "url" => entries[at].2 = Some(value),
                _ => {}
            }
        }
        entries.into_iter().filter_map(|(_, path, address)| Some((path?.to_string(), address?.to_string()))).collect()
    }

    /// Brings commit `id` of a repository into the clone, unless it is there.
    fn fetch(&self, owner: &str, repo: &str, id: &str) -> Result<(), GuardError> {
        if git(&["cat-file", "-e", &format!("{id}^{{tree}}")], Some(self.dir), None).is_ok() {
            return Ok(());
        }
        let url = format!("https://github.com/{owner}/{repo}.git");
        // With its files when they are to be written out; the list of folders needs none.
        let filter = if self.checkout { "--no-filter" } else { "--filter=blob:none" };
        git(&["fetch", "--quiet", "--depth", "1", "--no-tags", filter, "--", &url, id], Some(self.dir), self.token).map(|_| ())
    }

    /// Puts the files of commit `id` where the submodule is. Only the index and the working
    /// copy change: nothing is committed.
    fn place(&self, path: &str, id: &str) -> Result<(), GuardError> {
        if !self.checkout {
            return Ok(());
        }
        git(&["update-index", "--force-remove", "--", path], Some(self.dir), None)?;
        git(&["read-tree", &format!("--prefix={path}/"), "-u", id], Some(self.dir), self.token).map(|_| ())
    }
}

/// Puts the files of the submodules inside the folder `scope` into the clone `dir`, which is in
/// the state `git` left it in (just cloned, or just reset). Returns the ones left out.
fn submodules(dir: &Path, repo: &str, scope: &str, token: Option<&str>) -> Result<Vec<String>, GuardError> {
    let mut all = Submodules { dir, token, scope, checkout: true, taken: 0, files: Vec::new(), skipped: Vec::new() };
    all.walk("", "HEAD", repo, 0)?;
    Ok(all.skipped)
}

/// True when the clone still has a submodule inside `scope` whose files are not in it.
fn has_unread_submodules(dir: &Path, scope: &str) -> bool {
    let Ok(index) = git(&["ls-files", "-s", "-z"], Some(dir), None) else { return false };
    index.split('\0').any(|record| {
        record.split_once('\t').is_some_and(|(meta, path)| meta.starts_with("160000 ") && !path.split('/').any(is_hidden) && in_scope(path, scope))
    })
}

/// The notes of a clone inside `scope`, each with the id of its text, submodules included.
fn notes(dir: &Path, scope: &str) -> Result<Vec<(String, String)>, GuardError> {
    let scope = if scope.is_empty() { "." } else { scope };
    let index = git(&["ls-files", "-s", "-z", "--", scope], Some(dir), None)?;
    let mut notes = Vec::new();
    for record in index.split('\0') {
        // "<mode> <id> <stage>\t<path>"
        let Some((meta, path)) = record.split_once('\t') else { continue };
        if is_md(path) && !meta.starts_with("160000 ") {
            notes.push((path.to_string(), meta.split(' ').nth(1).unwrap_or("").to_string()));
        }
    }
    Ok(notes)
}

/// One folder of a repository and how many notes are in it, sub-folders included.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FolderCount {
    pub path: String,
    pub count: usize,
}

/// What the page shows to choose folders from. `direct` means the address already names one
/// folder or one file, so there is nothing to choose.
#[derive(Debug, Serialize)]
pub struct Listing {
    pub direct: bool,
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub total: usize,
    pub folders: Vec<FolderCount>,
    pub truncated: bool,
    /// Submodules that could not be read: their notes are not counted.
    pub skipped: Vec<String>,
}

const MAX_FOLDERS: usize = 1000;

/// Counts the notes below every folder, from the paths of all files in a repository. Hidden
/// folders and `node_modules` are left out, as in the list of notes; so is a folder whose name
/// could not be downloaded on its own.
pub fn folder_counts<'a>(paths: impl Iterator<Item = &'a str>) -> (usize, Vec<FolderCount>, bool) {
    let mut counts: std::collections::BTreeMap<Vec<&str>, usize> = std::collections::BTreeMap::new();
    let mut total = 0;
    for path in paths.filter(|p| is_md(p)) {
        let parts: Vec<&str> = path.split('/').collect();
        if parts.iter().any(|p| p.starts_with('.') || *p == "node_modules") {
            continue;
        }
        total += 1;
        for depth in 1..parts.len() {
            if !is_segment(parts[depth - 1]) {
                break;
            }
            *counts.entry(parts[..depth].to_vec()).or_default() += 1;
        }
    }
    let truncated = counts.len() > MAX_FOLDERS;
    let mut listed: Vec<(Vec<&str>, usize)> = counts.into_iter().collect();
    listed.sort_by(|(a, _), (b, _)| {
        let by_name = a.iter().zip(b.iter()).map(|(x, y)| natural_order(x, y)).find(|o| o.is_ne());
        by_name.unwrap_or_else(|| a.len().cmp(&b.len()))
    });
    let folders = listed.into_iter().take(MAX_FOLDERS).map(|(parts, count)| FolderCount { path: parts.join("/"), count }).collect();
    (total, folders, truncated)
}

/// Order of two folder names as a reader expects it: letters without regard to case, runs of
/// digits by their value ("week 2" before "week 10"). The web version lists them the same way.
fn natural_order(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (x, y): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let (mut i, mut j) = (0, 0);
    while i < x.len() && j < y.len() {
        if x[i].is_ascii_digit() && y[j].is_ascii_digit() {
            let run = |text: &[char], from: usize| text[from..].iter().take_while(|c| c.is_ascii_digit()).count();
            let (n, m) = (run(&x, i), run(&y, j));
            let digits = |text: &[char], from: usize, len: usize| text[from..from + len].iter().skip_while(|c| **c == '0').collect::<String>();
            let (p, q) = (digits(&x, i, n), digits(&y, j, m));
            let by = p.len().cmp(&q.len()).then_with(|| p.cmp(&q));
            if by != Ordering::Equal {
                return by;
            }
            i += n;
            j += m;
        } else {
            let by = x[i].to_lowercase().cmp(y[j].to_lowercase());
            if by != Ordering::Equal {
                return by;
            }
            i += 1;
            j += 1;
        }
    }
    (x.len() - i).cmp(&(y.len() - j)).then_with(|| a.cmp(b))
}

/// The folders of a repository that hold notes. Only the list of file names is downloaded
/// (a clone without files), into a folder that is removed again.
pub fn folders(spec: &Spec, config_file: &Path) -> Result<Listing, GuardError> {
    let repo = format!("{}/{}", spec.owner, spec.repo);
    if spec.kind == SourceKind::File || !spec.sub.is_empty() {
        return Ok(Listing { direct: true, repo, git_ref: spec.git_ref.clone(), total: 0, folders: Vec::new(), truncated: false, skipped: Vec::new() });
    }
    let token = read_token(config_file);
    let token = token.as_deref();
    let dir = listing_dir(spec);
    // What a listing left behind when the app was closed in the middle of it.
    let ours = format!("list-{}-", std::process::id());
    for entry in dir.parent().and_then(|p| fs::read_dir(p).ok()).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("list-") && !name.starts_with(&ours) {
            remove_dir(&entry.path());
        }
    }
    if dir.parent().map(fs::create_dir_all).and_then(Result::ok).is_none() {
        return fail(Kind::BadRequest, "The folder for downloads could not be made.");
    }
    let dir_text = dir.to_string_lossy().into_owned();
    let url = format!("https://github.com/{}/{}.git", spec.owner, spec.repo);
    let run = || -> Result<Listing, GuardError> {
        let mut args = vec!["clone", "--quiet", "--depth", "1", "--single-branch", "--no-tags", "--filter=blob:none", "--no-checkout"];
        if !spec.git_ref.is_empty() {
            args.extend(["--branch", &spec.git_ref]);
        }
        args.extend(["--", &url, &dir_text]);
        git(&args, None, token)?;
        let mut all = Submodules { dir: &dir, token, scope: "", checkout: false, taken: 0, files: Vec::new(), skipped: Vec::new() };
        all.walk("", "HEAD", &repo, 0)?;
        let git_ref = if spec.git_ref.is_empty() {
            git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(&dir), None)?.trim().to_string()
        } else {
            spec.git_ref.clone()
        };
        let (total, folders, truncated) = folder_counts(all.files.iter().map(String::as_str));
        Ok(Listing { direct: false, repo: repo.clone(), git_ref, total, folders, truncated, skipped: all.skipped })
    };
    let result = run();
    remove_dir(&dir);
    result
}

/// The notes that an update brought, with paths relative to the source.
#[derive(Debug, Default, Serialize)]
pub struct Changes {
    pub added: Vec<String>,
    pub changed: Vec<String>,
    pub removed: Vec<String>,
    /// Submodules inside the source that could not be read.
    pub skipped: Vec<String>,
}

/// What differs between two lists of notes (`notes`). `folder` is where the source's own paths
/// start: it is cut off.
fn changes(before: &[(String, String)], after: &[(String, String)], folder: &str) -> Changes {
    let rel = |path: &str| path.strip_prefix(&format!("{folder}/")).filter(|_| !folder.is_empty()).unwrap_or(path).to_string();
    let find = |list: &[(String, String)], path: &str| list.iter().find(|(p, _)| p == path).map(|(_, id)| id.clone());
    let mut result = Changes::default();
    for (path, id) in after {
        match find(before, path) {
            None => result.added.push(rel(path)),
            Some(old) if old != *id => result.changed.push(rel(path)),
            Some(_) => {}
        }
    }
    result.removed = before.iter().filter(|(path, _)| find(after, path).is_none()).map(|(path, _)| rel(path)).collect();
    result
}

/// Brings a downloaded source up to date.
pub fn update(root: &Root, config_file: &Path) -> Result<Changes, GuardError> {
    let Some(g) = root.github.as_ref().filter(|g| is_clone_dir(Path::new(&g.dir)) && is_ref(&g.git_ref, true)) else {
        return fail(Kind::BadRequest, "This source was not downloaded from GitHub.");
    };
    let dir = Path::new(&g.dir);
    if !dir.join(".git").exists() {
        return fail(Kind::NotFound, "The downloaded copy is missing. Remove this source and add it again.");
    }
    let token = read_token(config_file);
    update_copy(dir, g, root.kind, token.as_deref())
}

fn update_copy(dir: &Path, g: &Github, kind: SourceKind, token: Option<&str>) -> Result<Changes, GuardError> {
    let old = notes(dir, &g.sub)?;
    let before = git(&["rev-parse", "HEAD"], Some(dir), None)?.trim().to_string();
    git(&["fetch", "--quiet", "--depth", "1", "--no-tags", "origin", &g.git_ref], Some(dir), token)?;
    let after = git(&["rev-parse", "FETCH_HEAD"], Some(dir), None)?.trim().to_string();
    let folder = kind == SourceKind::Folder;
    // Nothing new on GitHub. A submodule that was left out before is tried again.
    if before == after && !(folder && has_unread_submodules(dir, &g.sub)) {
        return Ok(Changes::default());
    }
    // The copy only ever follows the repository: local changes to it are not kept. The reset
    // also takes the files of submodules out again; they are put back as the new commit has them.
    git(&["reset", "--quiet", "--hard", &after], Some(dir), token)?;
    let skipped = if folder { submodules(dir, &g.repo, &g.sub, token)? } else { Vec::new() };
    let mut result = changes(&old, &notes(dir, &g.sub)?, &sparse_folder(kind, &g.sub));
    result.skipped = skipped;
    Ok(result)
}

/// Deletes the downloaded copy of a removed source.
pub fn discard(root: &Root) {
    if let Some(github) = &root.github {
        discard_copy(github);
    }
}

pub fn discard_copy(github: &Github) {
    remove_dir(Path::new(&github.dir));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(owner: &str, repo: &str, git_ref: &str, sub: &str, kind: SourceKind) -> Spec {
        Spec { owner: owner.into(), repo: repo.into(), git_ref: git_ref.into(), sub: sub.into(), kind }
    }

    #[test]
    fn reads_repository_folder_and_file_addresses() {
        let whole = spec("octo", "notes", "", "", SourceKind::Folder);
        for address in [
            "https://github.com/octo/notes",
            "https://github.com/octo/notes/",
            "https://github.com/octo/notes.git",
            "github.com/octo/notes",
            "git@github.com:octo/notes.git",
            "octo/notes",
            "  https://www.github.com/octo/notes?tab=readme#top ",
        ] {
            assert_eq!(parse_github_url(address).unwrap(), whole, "{address}");
        }
        assert_eq!(
            parse_github_url("https://github.com/octo/notes/tree/main/docs/week%201").unwrap(),
            spec("octo", "notes", "main", "docs/week 1", SourceKind::Folder)
        );
        assert_eq!(
            parse_github_url("https://github.com/octo/notes/tree/v1.2").unwrap(),
            spec("octo", "notes", "v1.2", "", SourceKind::Folder)
        );
        assert_eq!(
            parse_github_url("https://github.com/octo/notes/blob/main/docs/a.MD").unwrap(),
            spec("octo", "notes", "main", "docs/a.MD", SourceKind::File)
        );
    }

    #[test]
    fn refuses_other_hosts_other_file_types_and_unsafe_paths() {
        let kind = |address: &str| parse_github_url(address).expect_err(address).kind;
        for address in [
            "",
            "octo",
            "https://gitlab.com/octo/notes",
            "http://github.com/octo/notes",
            "https://github.com.evil.test/octo/notes",
            "https://user:pw@github.com/octo/notes",
            "https://github.com/octo/notes/issues/3",
            "https://github.com/octo/notes/tree/main/../../etc",
            "https://github.com/octo/notes/tree/main/a/%2e%2e/b",
            "https://github.com/octo/notes/tree/--upload-pack=x/docs",
            "https://github.com/octo/notes/tree/main/-rf",
            "https://github.com/octo/notes/tree/main/a*b",
            "https://github.com/-octo/notes",
            "https://github.com/octo/..",
        ] {
            assert_eq!(kind(address), Kind::BadRequest, "{address}");
        }
        assert_eq!(kind("https://github.com/octo/notes/blob/main/docs/a.pdf"), Kind::Forbidden);
        assert_eq!(kind("https://github.com/octo/notes/blob/main"), Kind::Forbidden);
    }

    #[test]
    fn folders_are_counted_with_their_sub_folders() {
        let paths = ["week 10/a.md", "week 2/a.md", "Zeta/a.md", "README.md", "docs/a.md", "docs/deep/b.md", "docs/deep/c.MD", "docs/pic.svg", "src/main.rs",
            ".github/x.md", "node_modules/p/README.md", "odd[1]/in/d.md", "notes/-x/e.md"];
        let (total, folders, truncated) = folder_counts(paths.into_iter());
        assert_eq!(total, 9);
        assert!(!truncated);
        let got: Vec<(&str, usize)> = folders.iter().map(|f| (f.path.as_str(), f.count)).collect();
        assert_eq!(got, [("docs", 3), ("docs/deep", 2), ("notes", 1), ("week 2", 1), ("week 10", 1), ("Zeta", 1)]);
    }

    #[test]
    fn a_chosen_folder_is_checked_like_an_address() {
        let whole = || spec("octo", "notes", "", "", SourceKind::Folder);
        assert_eq!(with_folder(whole(), "docs/week 1").unwrap().sub, "docs/week 1");
        for bad in ["", "..", "docs/..", "docs//a", "/docs", "docs/", "-x", "a/-x", "a*", "a\\b", "a\nb"] {
            assert!(with_folder(whole(), bad).is_err(), "{bad:?}");
        }
        assert!(with_folder(spec("octo", "notes", "main", "docs", SourceKind::Folder), "more").is_err());
        assert!(with_folder(spec("octo", "notes", "main", "a.md", SourceKind::File), "more").is_err());
    }

    #[test]
    fn the_download_folder_keeps_its_name_across_versions() {
        let dir = clone_dir(&spec("octo", "notes", "main", "docs", SourceKind::Folder));
        assert_eq!(dir, repos_dir().join("octo").join("notes").join("22f63808a1"));
    }

    #[test]
    fn only_folders_made_for_clones_are_ever_deleted() {
        let repos = repos_dir();
        assert!(is_clone_dir(&repos.join("octo").join("notes").join("0123456789")));
        assert!(!is_clone_dir(&repos));
        assert!(!is_clone_dir(&repos.join("octo")));
        assert!(!is_clone_dir(&repos.join("octo").join("notes")));
        assert!(!is_clone_dir(&repos.join("octo").join("notes").join("k").join("deeper")));
        assert!(!is_clone_dir(&repos.join("octo").join("..").join("..").join("x")));
        assert!(!is_clone_dir(Path::new("/home")));
    }

    #[test]
    fn the_token_is_checked_kept_private_and_never_echoed() {
        let dir = std::env::temp_dir().join(format!("mdr-token-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let config = dir.join("config.json");
        assert!(!has_token(&config));
        assert_eq!(save_token(&config, "short").expect_err("refused").kind, Kind::BadRequest);
        assert_eq!(save_token(&config, "ghp_has spaces and $(things) in it 123").expect_err("refused").kind, Kind::BadRequest);
        save_token(&config, " ghp_abcdefghijklmnopqrstuvwxyz0123456789 \n").unwrap();
        assert!(has_token(&config));
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(dir.join("github-token")).unwrap().permissions()) & 0o777, 0o600);
        assert_eq!(base64(b"x-access-token:abc"), "eC1hY2Nlc3MtdG9rZW46YWJj");
        assert_eq!(base64(b"ab"), "YWI=");
        let error = git_error("fatal: Authentication failed for 'https://github.com/octo/private.git/'", true);
        assert_eq!(error.kind, Kind::NotFound);
        assert!(!error.message.contains("ghp_"));
        clear_token(&config);
        assert!(!has_token(&config));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_submodule_address_must_name_a_github_repository() {
        let lib = Some(("octo".to_string(), "lib".to_string()));
        for address in [
            "https://github.com/octo/lib",
            "https://github.com/octo/lib.git",
            "https://GitHub.com/octo/lib.git/",
            "https://www.github.com/octo/lib",
            "git@github.com:octo/lib.git",
            "ssh://git@github.com/octo/lib.git",
            "git://github.com/octo/lib",
            "../lib",
            "../lib.git",
            "../../octo/lib.git",
            "  ../lib\n",
        ] {
            assert_eq!(submodule_repo("octo/notes", address), lib, "{address}");
        }
        assert_eq!(submodule_repo("octo/notes", "../../other/lib"), Some(("other".to_string(), "lib".to_string())));
        for address in [
            "",
            "octo/lib",
            "lib",
            "./lib",
            "../",
            "../..",
            "../../lib",
            "../../../octo/lib",
            "../lib/more",
            "/srv/git/lib.git",
            "file:///srv/git/lib.git",
            "https://gitlab.com/octo/lib.git",
            "http://github.com/octo/lib",
            "https://github.com.evil.test/octo/lib",
            "https://user:pw@github.com/octo/lib",
            "https://github.com/octo",
            "https://github.com/octo/lib/tree/main",
            "https://github.com/octo/lib?x=1",
            "https://github.com/-octo/lib",
            "https://github.com/octo/..",
            "../-lib/../lib x",
            "--upload-pack=touch /tmp/x",
            "ext::sh -c touch% /tmp/x",
        ] {
            assert_eq!(submodule_repo("octo/notes", address), None, "{address}");
        }
        assert_eq!(submodule_repo("not a repository", "../lib"), None);
    }

    #[test]
    fn a_submodule_is_read_when_it_touches_the_folder_of_the_source() {
        for (path, scope) in [("lib", ""), ("docs/lib", "docs"), ("docs", "docs"), ("docs", "docs/deep")] {
            assert!(in_scope(path, scope), "{path} in {scope}");
        }
        for (path, scope) in [("other", "docs"), ("docs2", "docs"), ("doc", "docs"), ("docs/a", "docs/b")] {
            assert!(!in_scope(path, scope), "{path} in {scope}");
        }
    }

    #[test]
    fn an_update_names_the_notes_that_are_new_changed_or_gone() {
        let list = |notes: &[(&str, &str)]| notes.iter().map(|(p, id)| (p.to_string(), id.to_string())).collect::<Vec<_>>();
        let before = list(&[("docs/a.md", "1"), ("docs/b.md", "2"), ("docs/lib/old.md", "3")]);
        let after = list(&[("docs/a.md", "1"), ("docs/b.md", "9"), ("docs/lib/new.md", "4")]);
        let got = changes(&before, &after, "docs");
        assert_eq!((got.added, got.changed, got.removed), (vec!["lib/new.md".to_string()], vec!["b.md".to_string()], vec!["lib/old.md".to_string()]));
        assert_eq!(changes(&before, &before, "").added.len() + changes(&before, &before, "").removed.len(), 0);
        assert_eq!(changes(&[], &before, "").added, ["docs/a.md", "docs/b.md", "docs/lib/old.md"]);
    }

    /// Runs `git` for a test and returns what it printed.
    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Repositories on disk that stand in for GitHub: `octo/notes` with two submodules on
    /// `octo/lib` (one in `docs`, one outside it) and one that is not on GitHub; `octo/lib` with
    /// a submodule of its own, `octo/inner`, given by a relative address.
    struct Hub {
        base: PathBuf,
    }

    impl Drop for Hub {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    impl Hub {
        fn new(name: &str) -> Hub {
            let base = std::env::temp_dir().join(format!("mdr-hub-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            let hub = Hub { base };
            hub.make("inner", &[("deep.md", "# deep")]);
            hub.make("lib", &[("README.md", "# lib"), ("docs/guide.md", "# guide"), ("img/p.svg", "<svg/>"), ("code.rs", "x"),
                (".gitmodules", "[submodule \"in\"]\n\tpath = nested\n\turl = ../inner.git\n")]);
            hub.link("lib", "nested", "inner");
            hub.make("notes", &[("README.md", "# top"), ("docs/a.md", "# a"), (".gitmodules", concat!(
                "[submodule \"lib\"]\n\tpath = docs/lib\n\turl = https://github.com/octo/lib.git\n",
                "[submodule \"away\"]\n\tpath = docs/away\n\turl = https://gitlab.com/octo/lib.git\n",
                "[submodule \"other\"]\n\tpath = other\n\turl = git@github.com:octo/lib.git\n",
            ))]);
            for path in ["docs/lib", "docs/away", "other"] {
                hub.link("notes", path, "lib");
            }
            hub
        }

        fn repo(&self, name: &str) -> PathBuf {
            self.base.join("remotes").join("octo").join(format!("{name}.git"))
        }

        fn write(&self, name: &str, files: &[(&str, &str)]) {
            for (file, text) in files {
                let path = self.repo(name).join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, text).unwrap();
                sh(&self.repo(name), &["add", "--", file]);
            }
            sh(&self.repo(name), &["commit", "-q", "-m", "files"]);
        }

        fn make(&self, name: &str, files: &[(&str, &str)]) {
            fs::create_dir_all(self.repo(name)).unwrap();
            sh(&self.repo(name), &["init", "-q", "-b", "main"]);
            for key in ["uploadpack.allowFilter", "uploadpack.allowAnySHA1InWant"] {
                sh(&self.repo(name), &["config", key, "true"]);
            }
            self.write(name, files);
        }

        /// Makes `path` of `name` a submodule at the newest commit of `of`.
        fn link(&self, name: &str, path: &str, of: &str) {
            let id = sh(&self.repo(of), &["rev-parse", "HEAD"]);
            sh(&self.repo(name), &["update-index", "--add", "--cacheinfo", &format!("160000,{id},{path}")]);
            sh(&self.repo(name), &["commit", "-q", "-m", "submodule"]);
        }

        /// A clone of `octo/notes` as `download` makes it, in which github.com is this hub.
        fn clone(&self, to: &str, how: &[&str], folder: &str) -> PathBuf {
            let dir = self.base.join(to);
            let url = format!("file://{}", self.repo("notes").display());
            let mut args = vec!["clone", "--quiet", "--depth", "1", "--single-branch", "--no-tags", "--filter=blob:none"];
            args.extend(how);
            args.extend(["--", &url, to]);
            sh(&self.base, &args);
            sh(&dir, &["config", &format!("url.file://{}/remotes/.insteadOf", self.base.display()), "https://github.com/"]);
            if !folder.is_empty() {
                sh(&dir, &["sparse-checkout", "set", "--cone", "--", folder]);
            }
            dir
        }
    }

    #[test]
    fn submodules_inside_the_folder_are_downloaded_and_follow_updates() {
        let hub = Hub::new("update");
        let dir = hub.clone("copy", &["--sparse"], "docs");
        assert_eq!(submodules(&dir, "octo/notes", "docs", None).unwrap(), ["docs/away"]);
        for file in ["docs/a.md", "docs/lib/README.md", "docs/lib/docs/guide.md", "docs/lib/img/p.svg", "docs/lib/nested/deep.md"] {
            assert!(dir.join(file).is_file(), "{file}");
        }
        // Plain files only: nothing in the copy is a repository of its own, and what lies
        // outside the folder that was added is not fetched.
        assert!(!dir.join("docs/lib/.git").exists() && !dir.join("docs/lib/nested/.git").exists());
        assert!(!dir.join("other/README.md").exists());
        assert!(!dir.join("docs/away/README.md").exists());
        let config = fs::read_to_string(dir.join(".git").join("config")).unwrap();
        assert!(!config.contains("submodule") && !config.contains("octo/lib"), "{config}");

        // GitHub moves on: the submodule gets a note and loses one, the repository changes one.
        hub.write("lib", &[("docs/new.md", "# new")]);
        sh(&hub.repo("lib"), &["rm", "-q", "docs/guide.md"]);
        hub.write("lib", &[]);
        hub.link("notes", "docs/lib", "lib");
        hub.write("notes", &[("docs/a.md", "# a, again")]);
        let g = Github { repo: "octo/notes".into(), git_ref: "main".into(), sub: "docs".into(), dir: dir.to_string_lossy().into_owned() };
        let got = update_copy(&dir, &g, SourceKind::Folder, None).unwrap();
        assert_eq!(got.added, ["lib/docs/new.md"]);
        assert_eq!(got.changed, ["a.md"]);
        assert_eq!(got.removed, ["lib/docs/guide.md"]);
        assert_eq!(got.skipped, ["docs/away"]);
        assert!(dir.join("docs/lib/docs/new.md").is_file() && !dir.join("docs/lib/docs/guide.md").exists());
        assert!(dir.join("docs/lib/nested/deep.md").is_file());

        // Nothing new: no note is named, and the one left out is tried again.
        let got = update_copy(&dir, &g, SourceKind::Folder, None).unwrap();
        assert!(got.added.is_empty() && got.changed.is_empty() && got.removed.is_empty());
        assert_eq!(got.skipped, ["docs/away"]);
        assert!(dir.join("docs/lib/README.md").is_file());

        // The submodules are taken out of the repository: their notes go.
        sh(&hub.repo("notes"), &["rm", "-q", "--cached", "docs/lib", "docs/away"]);
        hub.write("notes", &[]);
        let got = update_copy(&dir, &g, SourceKind::Folder, None).unwrap();
        assert_eq!(got.removed, ["lib/README.md", "lib/docs/new.md", "lib/nested/deep.md"]);
        assert!(got.skipped.is_empty());
        assert!(!dir.join("docs/lib/README.md").exists() && dir.join("docs/a.md").is_file());
        let got = update_copy(&dir, &g, SourceKind::Folder, None).unwrap();
        assert!(got.added.is_empty() && got.removed.is_empty() && got.skipped.is_empty());
    }

    #[test]
    fn a_folder_inside_a_submodule_can_be_the_source() {
        let hub = Hub::new("inside");
        let dir = hub.clone("copy", &["--sparse"], "docs/lib/docs");
        assert!(submodules(&dir, "octo/notes", "docs/lib/docs", None).unwrap().is_empty());
        assert!(dir.join("docs/lib/docs/guide.md").is_file());
        assert!(!dir.join("docs/lib/img/p.svg").exists(), "only the folder that was asked for is written out");
        assert!(!dir.join("docs/lib/nested/deep.md").exists());
        let found: Vec<String> = notes(&dir, "docs/lib/docs").unwrap().into_iter().map(|(path, _)| path).collect();
        assert_eq!(found, ["docs/lib/docs/guide.md"]);
    }

    #[test]
    fn the_list_of_folders_counts_the_notes_of_submodules() {
        let hub = Hub::new("list");
        let dir = hub.clone("list", &["--no-checkout"], "");
        let mut all = Submodules { dir: &dir, token: None, scope: "", checkout: false, taken: 0, files: Vec::new(), skipped: Vec::new() };
        all.walk("", "HEAD", "octo/notes", 0).unwrap();
        assert_eq!(all.skipped, ["docs/away"]);
        let (total, folders, _) = folder_counts(all.files.iter().map(String::as_str));
        assert_eq!(total, 8);
        let got: Vec<(&str, usize)> = folders.iter().map(|f| (f.path.as_str(), f.count)).collect();
        assert_eq!(got, [("docs", 4), ("docs/lib", 3), ("docs/lib/docs", 1), ("docs/lib/nested", 1), ("other", 3), ("other/docs", 1), ("other/nested", 1)]);
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| e.file_name() == ".git"), "nothing is written out for a list");
    }

    /// Needs the network and `git`: `XDG_DATA_HOME=<scratch> cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn downloads_updates_and_discards_a_public_folder() {
        assert!(std::env::var_os("XDG_DATA_HOME").is_some(), "set XDG_DATA_HOME to a scratch folder");
        let config = data_dir().join("config.json");
        let folder = parse_github_url("https://github.com/markdown-it/markdown-it/tree/master/docs").unwrap();
        let got = download(&folder, &config).unwrap();
        assert!(got.target.join("architecture.md").is_file());
        assert_eq!(got.github.git_ref, "master");
        let config_text = fs::read_to_string(Path::new(&got.github.dir).join(".git").join("config")).unwrap();
        assert!(!config_text.to_ascii_lowercase().contains("authorization"));
        let root = Root { id: "x".into(), path: got.target.clone(), kind: SourceKind::Folder, github: Some(got.github.clone()) };
        let changes = update(&root, &config).unwrap();
        assert!(changes.added.is_empty() && changes.changed.is_empty() && changes.removed.is_empty());
        discard(&root);
        assert!(!Path::new(&got.github.dir).exists());

        let file = parse_github_url("https://github.com/markdown-it/markdown-it/blob/master/README.md").unwrap();
        let got = download(&file, &config).unwrap();
        assert!(got.target.is_file());
        assert!(!Path::new(&got.github.dir).join("docs").exists(), "only the top of the repository is checked out");
        discard_copy(&got.github);

        let whole = parse_github_url("markdown-it/markdown-it").unwrap();
        let listing = folders(&whole, &config).unwrap();
        assert_eq!(listing.git_ref, "master");
        assert!(listing.folders.iter().any(|f| f.path == "docs" && f.count >= 5), "{:?}", listing.folders);
        assert!(listing.total > listing.folders[0].count);
        let left: Vec<_> = fs::read_dir(repos_dir().join("markdown-it").join("markdown-it")).map(|d| d.flatten().collect()).unwrap_or_default();
        assert!(left.iter().all(|e| !e.file_name().to_string_lossy().starts_with("list-")), "the listing clone is removed");
        let chosen = with_folder(whole, "docs").unwrap();
        assert!(download(&chosen, &config).unwrap().target.join("architecture.md").is_file());

        let missing = parse_github_url("https://github.com/markdown-it/markdown-it/tree/master/nofolder").unwrap();
        assert_eq!(download(&missing, &config).err().unwrap().kind, Kind::NotFound);

        // A repository with a submodule (lib/tmux-test): its notes are counted and downloaded.
        let tpm = parse_github_url("tmux-plugins/tpm").unwrap();
        let listing = folders(&tpm, &config).unwrap();
        assert!(listing.skipped.is_empty(), "{:?}", listing.skipped);
        assert!(listing.folders.iter().any(|f| f.path == "lib/tmux-test" && f.count >= 1), "{:?}", listing.folders);
        let got = download(&with_folder(tpm, "lib").unwrap(), &config).unwrap();
        assert!(got.skipped.is_empty(), "{:?}", got.skipped);
        assert!(got.target.join("tmux-test").join("README.md").is_file());
        assert!(!got.target.join("tmux-test").join(".git").exists());
        let root = Root { id: "x".into(), path: got.target.clone(), kind: SourceKind::Folder, github: Some(got.github.clone()) };
        let changes = update(&root, &config).unwrap();
        assert!(changes.added.is_empty() && changes.removed.is_empty() && changes.skipped.is_empty());
        assert!(got.target.join("tmux-test").join("README.md").is_file());
        discard(&root);
    }
}

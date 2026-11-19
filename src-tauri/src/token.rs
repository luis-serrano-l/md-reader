//! The GitHub token for private repositories, kept in its own file (mode 0600) next to the
//! config file. The page saves it, forgets it and reads it (`public/web-backend.js` sends it to
//! `api.github.com` with its requests); no error message contains it.

use crate::roots::{GuardError, Kind};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn fail<T>(kind: Kind, message: &str) -> Result<T, GuardError> {
    Err(GuardError { kind, message: message.to_string() })
}

fn is_token(text: &str) -> bool {
    (20..=255).contains(&text.len()) && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn token_file(config_file: &Path) -> PathBuf {
    config_file.parent().unwrap_or_else(|| Path::new("/")).join("github-token")
}

pub fn read_token(config_file: &Path) -> Option<String> {
    let token = fs::read_to_string(token_file(config_file)).ok()?.trim().to_string();
    is_token(&token).then_some(token)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_checked_kept_private_and_never_echoed() {
        let dir = std::env::temp_dir().join(format!("mdr-token-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let config = dir.join("config.json");
        assert_eq!(read_token(&config), None);
        let refused = save_token(&config, "short").expect_err("refused");
        assert_eq!(refused.kind, Kind::BadRequest);
        assert!(!refused.message.contains("short"));
        assert_eq!(save_token(&config, "ghp_has spaces and $(things) in it 123").expect_err("refused").kind, Kind::BadRequest);
        save_token(&config, " ghp_abcdefghijklmnopqrstuvwxyz0123456789 \n").unwrap();
        assert_eq!(read_token(&config).as_deref(), Some("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(dir.join("github-token")).unwrap().permissions()) & 0o777, 0o600);
        // A file that holds something else is not handed on.
        fs::write(dir.join("github-token"), "not a token\n").unwrap();
        assert_eq!(read_token(&config), None);
        clear_token(&config);
        assert_eq!(read_token(&config), None);
        let _ = fs::remove_dir_all(&dir);
    }
}

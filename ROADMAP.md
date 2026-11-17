# Roadmap

Built so far: the browser version (localhost), the desktop app (Tauri, never Electron), the
fonts and colours panel, printing to paper or PDF, continuous view and pages view, the four
kinds of source side by side (local folder, local file, GitHub folder, GitHub file) with Update
and a saved token for private repositories, and the hosted version as a static, installable
page (PWA), published with GitHub Pages at <https://luis-serrano-l.github.io/md-reader/>.

## Still open

**Try the hosted version on a phone or tablet**: installing, a private repository with a
token, reading offline. So far it was tried in desktop Chrome only.

**Sign-in for the hosted version instead of a pasted token.** GitHub's sign-in for a page
without a server needs a GitHub App and a small token-exchange service. Google Apps Script
could be that service; it cannot host the page itself, because an Apps Script web app is shown
inside Google's own frame and cannot serve a manifest or a service worker.

**Desktop packages for macOS and Windows.** They have to be built on those systems. The token
file's "only my user" permission is set on Linux and macOS only; Windows needs its own way.

**Remove the Node server** once the browser version is no longer wanted.

## Not tried yet

- A private repository with a real token (browser, desktop and hosted versions).
- The hosted version with no network at all, and installed on a phone.
- Adding from GitHub by typing in the desktop window (the same Rust code is covered by a test
  that downloads a public repository).
- Reloading a note in pages view when its file changes, and printing from the desktop window.

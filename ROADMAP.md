# Roadmap

Built so far: the desktop app (Tauri, never Electron) and the web version, a static page that
installs as an app (PWA), published with GitHub Pages at
<https://luis-serrano-l.github.io/md-reader/>. Both have the view, fonts and colours panel,
printing to paper or PDF, continuous view and pages view. The desktop app reads local folders,
single local files and GitHub folders or files side by side, with Update and a saved token for
private repositories; the web version reads GitHub. Both read the submodules inside a GitHub
folder.

The Node server that once served the page on localhost is gone: the desktop app is the only
code that reads the disk. So is the desktop app's own GitHub code, which cloned with `git`:
both versions now read GitHub through `public/web-backend.js`, and Rust keeps local sources,
the config file and the token file.

## Still open

**Sign-in for the web version instead of a pasted token.** GitHub's sign-in for a page
without a server needs a GitHub App and a small token-exchange service. Google Apps Script
could be that service; it cannot host the page itself, because an Apps Script web app is shown
inside Google's own frame and cannot serve a manifest or a service worker.

**Desktop packages for macOS and Windows.** They have to be built on those systems. The token
file's "only my user" permission is set on Linux and macOS only; Windows needs its own way.

**An app for iPhone and iPad from the App Store.** The only way to hide the row with the clock
on an iPhone and to read truly edge to edge. Tauri can build it, but it needs a Mac, Xcode and
an Apple developer account.

**Local folders in a browser**, if ever wanted again: a "serve on localhost" mode of the
desktop program, not a second back end.

## Not tried yet

- Submodules against GitHub itself (tried in Chrome against a made-up GitHub, and in the
  tests), and a private submodule with a real token.
- A private repository with a real token, in the desktop app. Its images, which the page
  fetches itself there, were tried in Chrome against a made-up GitHub, in both views.
- The web version with no network at all, and the desktop app without one (it should list the
  GitHub sources and say that GitHub could not be reached when a note is opened).
- Adding, updating and removing a GitHub source in the desktop window itself. The window was
  tried with a source already in a scratch config: it listed it and opened a note of a public
  repository from GitHub. The dialogs were tried in Chrome with a stand-in for Tauri, against
  GitHub itself.
- Full screen, book mode and the page under the clock on a real iPhone or iPad (tried in
  Chrome with device emulation only).
- Reloading a note in pages view when its file changes, and printing from the desktop window.

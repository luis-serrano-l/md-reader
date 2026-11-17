# Roadmap

Not built yet. Listed in the order they were asked for, not in priority order.

## Choose fonts and colours

A settings panel to pick the body, heading and code fonts, the text size, and the paper, text,
heading and accent colours. Presets: the current "study" look, a dark one, a plain white one.
Saved in `~/.config/md-reader/config.json`.

Already prepared: `public/study.css` defines every font and colour once, as CSS custom properties
on `.sheet` (`--paper`, `--ink`, `--h1`, `--h2`, `--h3`, `--accent`, `--code-bg`, `--font-body`,
`--font-head`, `--font-mono`, `--size-body`, ...). The panel only has to set those variables.

## Import a folder from a GitHub repository

Give a GitHub URL (a repository, or one folder inside it) and md-reader downloads it and keeps a
local copy, so the notes are readable offline like any other added folder.

- Stored under the app's own data folder (`~/.local/share/md-reader/repos/<owner>/<repo>`), then
  added to the folder list with a mark showing it came from GitHub and from which branch.
- Only one folder wanted: `git clone --filter=blob:none --sparse` plus `git sparse-checkout set
  <folder>`, so the rest of the repository is not downloaded.
- **Update after import**: an "Update" button on the imported folder runs `git pull --ff-only`
  and shows what changed (new, changed and removed notes). The open note reloads by itself, as it
  already does when a file changes on disk.
- The copy is read-only from the app's side: md-reader never commits or pushes.
- Private repositories: use the credentials `git` already has on this machine; the app stores no
  token.
- The `.md`-only rule and the path guard apply to imported folders exactly as to local ones.

## Hosted version, opened as a PWA (possibly with Google Apps Script)

Publish md-reader online so a GitHub repository's notes can be opened from any device (phone,
tablet) as an installable PWA, without the local server.

- The hosted app reads the `.md` files and images of a repository through the GitHub API and
  renders them with the same `study.css`. The Markdown rendering moves to the browser
  (markdown-it runs there unchanged).
- PWA parts: a web manifest, an icon, and a service worker that caches the app and the notes
  already opened, so they are readable offline.
- Hosting with Google Apps Script is the first idea to try. To check before building: an Apps
  Script web app is shown inside a Google iframe on `script.google.com`, and a PWA needs to serve
  its own manifest and service worker from its own address, so it may not be installable that
  way. If it is not, Apps Script can still be the small back end (fetching the repository,
  holding the GitHub token for private ones) while the pages themselves are on a static host
  such as GitHub Pages.
- Private repositories need a sign-in; the token must never be in the page's code.
- The `.md`-only rule stays: the hosted app lists and opens Markdown files only.

## Desktop app (Tauri, never Electron)

Electron is ruled out: it bundles Chromium and is heavy on RAM. Tauri uses the system WebKitGTK
webview, so the app is a few MB.

- Load the same `public/` front end.
- Replace the "Add folder" browse dialog with the native folder dialog.
- Port the server routes (`roots`, `tree`, `doc`, `asset`, `watch`) to Rust commands, so no Node
  process runs.

## Print / export to PDF

A print stylesheet with Letter pages and the PDF's margins, for the rare case a PDF is wanted
again. `.diagram-block` already keeps a diagram with the paragraph that introduces it.

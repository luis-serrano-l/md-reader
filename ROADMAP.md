# Roadmap

Not built yet. Listed in the order they were asked for, not in priority order.

Built so far: the browser version (localhost), the desktop app (Tauri, never Electron), the
fonts and colours panel, printing to paper or PDF, and the choice between continuous view and
pages view.
Still open for the desktop app: packages for macOS and Windows, and removing the Node server
once the browser version is no longer wanted.

## Four kinds of source, side by side

The list on the left should hold any mix of these at the same time:

| Source | What is added | Status |
|---|---|---|
| Local folder | A folder on this machine; all its `.md` files, sub-folders included | Built |
| Local file | One specific `.md` file, without giving access to the rest of its folder | To build |
| GitHub folder | A repository, or one folder inside it | To build |
| GitHub file | One specific `.md` file of a repository | To build |

Each entry shows what kind it is (an icon and, for GitHub, the repository and branch). Removing
one never touches the others.

**Local file.** "Add file" opens the system's file dialog limited to `.md`. Only that file is
readable, plus the images it links to that sit in its own folder or below. The path guard gets a
second kind of entry (a single allowed file) next to the folder entries; the `.md`-only rule is
unchanged.

**GitHub folder or file.** Give a GitHub URL and md-reader downloads it and keeps a local copy,
so the notes are readable offline like any local source.

- Stored under the app's own data folder (`~/.local/share/md-reader/repos/<owner>/<repo>`).
- Only one folder wanted: `git clone --filter=blob:none --sparse` plus `git sparse-checkout set
  <folder>`, so the rest of the repository is not downloaded. One file: the same, narrowed to
  the file and the images it links.
- **Update after import**: an "Update" button on the entry runs `git pull --ff-only` and shows
  what changed (new, changed and removed notes). The open note reloads by itself, as it already
  does when a file changes on disk.
- The copy is read-only from the app's side: md-reader never commits or pushes.
- Private repositories: use the credentials `git` already has on this machine; the app stores no
  token.
- The `.md`-only rule and the path guard apply to imported sources exactly as to local ones.

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

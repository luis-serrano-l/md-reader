# md-reader

Read Markdown notes with the look of a typeset study PDF, without building the PDF. You choose
what the app may read (folders, single files, GitHub repositories), and it opens `.md` files
only. It runs as a desktop app (Tauri), in the browser on localhost, or as a hosted page that
installs as a PWA; all three show the same front end.

| Version | Where it runs | What it can read | Start |
|---|---|---|---|
| Hosted (PWA) | Any browser, phone or tablet | GitHub repositories | Open <https://luis-serrano-l.github.io/md-reader/> |
| Browser | This computer, on localhost | Local folders and files, GitHub | `npm start` |
| Desktop app | Linux (Tauri) | Local folders and files, GitHub | `npm run desktop` |

Contents: [iPad or phone](#on-an-ipad-or-phone) · [Browser](#run-in-the-browser) ·
[Desktop](#run-as-a-desktop-app) · [Use](#use) · [GitHub sources](#github-sources) ·
[What the app can read](#what-the-app-can-read) · [Hosted version](#hosted-version-pwa) ·
[The look](#the-look) · [Layout](#layout) · [Test](#test) · [License](#license)

## On an iPad or phone

Nothing to install from a store, nothing to pay.

1. Put the notes in a GitHub repository (public or private).
2. Open <https://luis-serrano-l.github.io/md-reader/> in Safari (iPad, iPhone) or Chrome
   (Android).
3. Safari: **Share → Add to Home Screen**. Chrome: **⋮ → Install app**. Open the app from its
   icon from then on; a plain Safari tab can lose its saved notes after a week without use.
4. **Add… → From GitHub**, paste the address of the repository, a folder or one `.md` file.
5. Private repository: paste a token in the same dialog and press **Save token** first. Make
   it at GitHub → Settings → Developer settings → Fine-grained tokens, with access to that one
   repository and the permission **Contents: Read-only**.

Notes that were opened once can be read again without a network. **↻** fetches new versions.

## Run in the browser

Needs Node 20 or newer. Nothing to install: the server uses only Node's own modules.

```sh
npm start          # http://localhost:4747
```

Use another port with `PORT=4748 npm start`.

## Run as a desktop app

Needs Rust and, on Linux, the WebKitGTK development packages
(`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`). No Node process runs in the desktop app.

```sh
npm install              # the Tauri command-line tool
npm run desktop          # run from source
npm run desktop:build    # release build
```

The release build writes the program to `src-tauri/target/release/md-reader` and a package to
`src-tauri/target/release/bundle/deb/md-reader_0.1.0_amd64.deb` (about 2 MB). Install it with
`sudo apt install ./src-tauri/target/release/bundle/deb/md-reader_0.1.0_amd64.deb`.

The desktop app and the browser version share the list of sources.

## Use

1. Click **Add…** and pick a kind of source. Any mix of them can be in the list at once.

   | Source | What is added |
   |---|---|
   | Folder on this computer | All its `.md` files, sub-folders included |
   | One file on this computer | Only that `.md` file; the rest of its folder stays closed |
   | From GitHub | A repository, a folder in it, or one `.md` file, downloaded to read |

   For a folder or file, the desktop app opens the system's dialog; in the browser, browse to
   it or paste its path and press Go.
2. Click a note to read it.
3. Remove a source with the **×** next to its name. Local files stay on disk; for a GitHub
   source the downloaded copy is deleted and the repository is not touched.

### GitHub sources

Paste an address in **Add… → From GitHub**. Needs `git` (2.27 or newer) on the machine.

| Address | Adds |
|---|---|
| `https://github.com/owner/repo` or `owner/repo` | The whole repository, default branch |
| `https://github.com/owner/repo/tree/main/notes` | The folder `notes` on branch `main` |
| `https://github.com/owner/repo/blob/main/notes/a.md` | That one file |

- Only what is asked for is downloaded (a shallow, sparse clone), into
  `~/.local/share/md-reader/repos/`. The notes are then readable offline.
- **↻** on the entry updates the copy and lists the notes that are new, changed or removed.
- The copy is read-only from the app's side: md-reader never commits or pushes. A branch name
  with a `/` in it cannot be given in an address.
- **Private repositories**: paste a GitHub token in the same dialog and press **Save token**.
  A fine-grained token with read-only "Contents" access to the repositories is enough. It is
  saved in `~/.config/md-reader/github-token`, readable by your user only. The app can replace
  or forget it but never shows it again, and hands it to `git` for one command at a time: it is
  not written into the copy or its settings. Without a saved token, `git`'s own sign-in is used.

| Control | What it does |
|---|---|
| ☰ | Show or hide the folder list |
| − 100% + | Zoom the note |
| ⎙ | Print the note, or save it as a PDF from the print dialog |
| ⚙ | View (continuous or pages), fonts and colours. In pages view `Page Up` / `Page Down` move one page |
| ⛶ or `F` | Full screen on or off (`Esc` also leaves; `F11` too in the desktop app). On an iPad or iPhone, which have no full screen for pages, the note takes the whole window and **✕** brings the panels back |
| ≡ | Show or hide the outline |

The open note reloads by itself when the file changes on disk and keeps its scroll position.
Links to other `.md` files open inside the app; web links open in a new tab (in the
desktop app, in your browser).

## What the app can read

- Nothing until a source is added. The list is saved in `~/.config/md-reader/config.json`
  (override with the `MD_READER_CONFIG` environment variable; downloads from GitHub then go
  next to that file instead).
- Documents: `.md` only.
- Images linked from a note (`.svg .png .jpg .jpeg .gif .webp`), and only from inside an added
  folder.
- A single file: that file only, plus the images in its own folder or below. A file that sits
  directly in the home folder or at the top of the disk shows no images.
- Paths with `..` and symlinks that lead outside an added folder are refused. A GitHub source
  never reads outside its downloaded copy, whatever links the repository holds.
- Raw HTML inside a note is shown as text, not run.
- Browser version: the server listens on `127.0.0.1` only and refuses requests that come from
  other sites.
- Desktop app: the page can call only the app's own commands; it has no general file access.

## Hosted version (PWA)

`public/` is also a complete static site. Served from any address that is not this computer,
the page runs without a server: sources are GitHub repositories only, read through GitHub's API,
and the page installs as an app on a phone or tablet.

- **Published** at <https://luis-serrano-l.github.io/md-reader/> by
  `.github/workflows/pages.yml`, which uploads `public/` on every push to `main`.
- **Your own copy**: fork the repository and turn on Pages (Settings → Pages → Source: GitHub
  Actions), or copy `public/` to any static HTTPS host. Nothing to build. It works below a
  sub-path too.
- **What leaves the device**: requests to GitHub for the repositories you add, and nothing
  else. The site has no server of its own, no account and no tracking.
- **Offline**: the app itself and every note and image already opened are kept on the device.
- **Private repositories**: the same token field. In this version the token is kept in the
  browser's storage on that device and sent to `api.github.com` only; anyone who can use that
  browser profile can use it, so give it read-only access to the few repositories you need.
- Without a token GitHub allows 60 list requests an hour per address (adding a source and ↻
  each use one or two). Opening notes does not count.
- Forgetting the token, or removing the last source of a repository, also deletes the notes
  kept from it for offline reading.
- Not there: local folders and files, reloading when a file changes (use ↻).

## The look

The ⚙ button opens **View, fonts and colours**: continuous or pages view, three looks (Study,
Plain white, Dark with true black for OLED screens), the fonts of the text, headings and code,
the text size, and four colours (paper, text, headings, accent). Looks, fonts and colours are
saved with the list of sources and shared by the browser version and the desktop app; the view
is remembered by each of them separately.

On a tablet held upright or a phone, the list of sources lies over the note and a tap on the
note puts it away; the page margins shrink so the text keeps its width.

Printing uses Letter pages with the study PDF's margins. A table row, a code block or a diagram
with its lead-in paragraph is not cut in two when it fits on a page.

`public/study.css` is a screen version of the stylesheet used for the study PDFs: warm paper,
serif body text, blue sans-serif headings, striped tables, full-width diagrams. Every font and
colour is a CSS variable at the top of that file.

The note is shown as one continuous sheet, or, in pages view, cut into Letter pages like the
PDF, with a page number on each and "page 3 of 32" in the top bar. A page is never cut through
a table row or a diagram with its lead-in paragraph, a heading is never left alone at the bottom
of a page, and a table that continues on the next page repeats its header row. The view is
remembered, and switching keeps the place being read.

## Layout

| Path | Role |
|---|---|
| `public/` | Front end: plain HTML, CSS and JavaScript, no build step |
| `public/render.js` | Markdown to HTML, in the page |
| `public/pages.js` | Pages view: cuts the rendered note into Letter pages |
| `public/settings.js` | Fonts and colours: the looks, the font lists, checking of stored values |
| `public/backend.js` | The one place that talks to the server, the desktop app or GitHub |
| `public/web-backend.js`, `sw.js`, `manifest.webmanifest`, `icons/` | Hosted version: GitHub reader, offline cache, install data |
| `public/github-url.js` | Reads a GitHub address (shared by the server and the hosted version) |
| `public/vendor/` | Browser builds of markdown-it and highlight.js (`npm run vendor` refreshes them) |
| `server/index.js` | Browser version: HTTP server, routes, request checks |
| `server/roots.js` | Browser version: list of sources and the path guard |
| `server/github.js` | Browser version: download and update with `git`, the saved token |
| `src-tauri/src/lib.rs` | Desktop app: commands, image protocol, file watching |
| `src-tauri/src/roots.rs` | Desktop app: list of sources and the path guard, with its tests |
| `src-tauri/src/github.rs` | Desktop app: download and update with `git`, the saved token |
| `test/` | Tests for the Node path guard, the GitHub code, the hosted guard, the settings and the renderer |
| `.github/workflows/pages.yml` | Publishes `public/` to GitHub Pages |
| `ROADMAP.md` | Planned work |
| `CLAUDE.md` | Rules and map of the code for contributors (human or AI) |

## Test

```sh
npm install                      # once, for the renderer tests
npm test                         # Node path guard and renderer
(cd src-tauri && cargo test)     # Rust path guard and GitHub code
# A real download from GitHub through the Rust code (needs the network):
(cd src-tauri && XDG_DATA_HOME=/some/tmp cargo test -- --ignored)
```

## Roadmap

See [ROADMAP.md](ROADMAP.md): sign-in for the hosted version, and packages for macOS and
Windows.

## License

[MIT](LICENSE). The libraries in `public/vendor/` keep their own licences:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

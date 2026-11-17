# md-reader

Read Markdown notes with the look of a typeset study PDF, without building the PDF. You choose
which folders the app may read, and it opens `.md` files only. It runs as a desktop app (Tauri)
or in the browser on localhost; both show the same front end.

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

The desktop app and the browser version share the folder list.

## Use

1. Click **Add folder**. The desktop app opens the system's folder dialog. In the browser,
   browse to a folder (or paste its path and press Go), then **Add this folder**. Its `.md` files appear in the list on the left, sub-folders included.
2. Click a note to read it.
3. Remove a folder with the **×** next to its name. The files stay on disk.

| Control | What it does |
|---|---|
| ☰ | Show or hide the folder list |
| ▤ | Pages view or continuous view (`Page Up` / `Page Down` move one page in pages view) |
| − 100% + | Zoom the note |
| ⎙ | Print the note, or save it as a PDF from the print dialog |
| ⚙ | Fonts and colours |
| ⛶ or `F` | Full screen on or off (`Esc` also leaves; `F11` too in the desktop app) |
| ≡ | Show or hide the outline |

The open note reloads by itself when the file changes on disk and keeps its scroll position.
Links to other `.md` files open inside the app; web links open in a new tab (in the
desktop app, in your browser).

## What the app can read

- Nothing until a folder is added. The list is saved in `~/.config/md-reader/config.json`
  (override with the `MD_READER_CONFIG` environment variable).
- Documents: `.md` only.
- Images linked from a note (`.svg .png .jpg .jpeg .gif .webp`), and only from inside an added
  folder.
- Paths with `..` and symlinks that lead outside an added folder are refused.
- Raw HTML inside a note is shown as text, not run.
- Browser version: the server listens on `127.0.0.1` only and refuses requests that come from
  other sites.
- Desktop app: the page can call only the app's own commands; it has no general file access.

## The look

The ⚙ button opens **Fonts and colours**: three looks (Study, Plain white, Dark), the fonts of
the text, headings and code, the text size, and four colours (paper, text, headings, accent).
The choice is saved with the folder list and shared by the browser version and the desktop app.

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
| `public/backend.js` | The one place that talks to the server or to the desktop app |
| `public/vendor/` | Browser builds of markdown-it and highlight.js (`npm run vendor` refreshes them) |
| `server/index.js` | Browser version: HTTP server, routes, request checks |
| `server/roots.js` | Browser version: folder list and the path guard |
| `src-tauri/src/lib.rs` | Desktop app: commands, image protocol, file watching |
| `src-tauri/src/roots.rs` | Desktop app: folder list and the path guard, with its tests |
| `test/` | Tests for the Node path guard and the renderer |
| `ROADMAP.md` | Planned work |

## Test

```sh
npm install                      # once, for the renderer tests
npm test                         # Node path guard and renderer
(cd src-tauri && cargo test)     # Rust path guard
```

## Roadmap

See [ROADMAP.md](ROADMAP.md): single files and GitHub
folders or files as sources, and a hosted PWA version.

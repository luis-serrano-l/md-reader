# md-reader

Read Markdown notes in the browser with the look of a typeset study PDF, without building the
PDF. You choose which folders the app may read, and it opens `.md` files only.

## Run

Needs Node 20 or newer.

```sh
npm install
npm start          # http://localhost:4747
```

Use another port with `PORT=4748 npm start`.

## Use

1. Click **Add folder**, browse to a folder (or paste its path and press Go), then **Add this
   folder**. Its `.md` files appear in the list on the left, sub-folders included.
2. Click a note to read it.
3. Remove a folder with the **×** next to its name. The files stay on disk.

| Control | What it does |
|---|---|
| ☰ | Show or hide the folder list |
| − 100% + | Zoom the note |
| ⛶ or `F` | Full screen on or off (`Esc` also leaves) |
| ≡ | Show or hide the outline |

The open note reloads by itself when the file changes on disk and keeps its scroll position.
Links to other `.md` files open inside the app; web links open in a new tab.

## What the app can read

- Nothing until a folder is added. The list is saved in `~/.config/md-reader/config.json`
  (override with the `MD_READER_CONFIG` environment variable).
- Documents: `.md` only.
- Images linked from a note (`.svg .png .jpg .jpeg .gif .webp`), and only from inside an added
  folder.
- Paths with `..` and symlinks that lead outside an added folder are refused.
- Raw HTML inside a note is shown as text, not run.
- The server listens on `127.0.0.1` only and refuses requests that come from other sites.

## The look

`public/study.css` is a screen version of the stylesheet used for the study PDFs: warm paper,
serif body text, blue sans-serif headings, striped tables, full-width diagrams. The note is one
continuous sheet instead of separate pages. Every font and colour is a CSS variable at the top of
that file.

## Layout

| Path | Role |
|---|---|
| `server/index.js` | HTTP server, routes, request checks |
| `server/roots.js` | Folder list and the path guard |
| `server/render.js` | Markdown to HTML |
| `public/` | Front end: plain HTML, CSS and JavaScript, no build step |
| `test/` | Tests for the path guard and the renderer |
| `ROADMAP.md` | Planned work |

## Test

```sh
npm test
```

## Roadmap

See [ROADMAP.md](ROADMAP.md): font and colour settings, importing a GitHub repository folder, a
hosted PWA version, a Tauri desktop app, and print to PDF.

# md-reader

Read Markdown notes with the look of a typeset study PDF, without building the PDF. You choose
what the app may read (folders, single files, GitHub repositories), and it opens `.md` files
only. It runs as a desktop app (Tauri) or as a web page that installs as an app (PWA); both
show the same front end.

| Version | Where it runs | What it can read | Start |
|---|---|---|---|
| Web (PWA) | Any browser, phone or tablet | GitHub repositories | Open <https://luis-serrano-l.github.io/md-reader/> |
| Desktop app | Linux (Tauri) | Local folders and files, GitHub | `npm run desktop` |

Contents: [iPad or phone](#on-an-ipad-or-phone) ·
[Desktop](#run-as-a-desktop-app) · [Use](#use) · [GitHub sources](#github-sources) ·
[What the app can read](#what-the-app-can-read) · [Web version](#web-version-pwa) ·
[The look](#the-look) · [Layout](#layout) · [Test](#test) · [License](#license)

## On an iPad or phone

Nothing to install from a store, nothing to pay.

1. Put the notes in a GitHub repository (public or private).
2. Open <https://luis-serrano-l.github.io/md-reader/> in Safari (iPad, iPhone) or Chrome
   (Android).
3. Safari: **Share → Add to Home Screen**. Chrome: **⋮ → Install app**. Open the app from its
   icon from then on; a plain Safari tab can lose its saved notes after a week without use.
4. **Add → From GitHub**, type `owner/repository`, press **Next** and tick the folders to
   add.
5. Private repositories: paste a token in the same dialog and press **Save token** first. It
   is saved once and used for every repository added later. Make it at GitHub → Settings →
   Developer settings → Fine-grained tokens, with access to the repositories to read and the
   permission **Contents: Read-only**.

Notes that were opened once can be read again without a network. The update button of a
source (two arrows in a circle) fetches new versions.

A tap on the middle of a note gives it the whole screen; in pages view the pages then turn
sideways, like a book (see [Reading full screen](#reading-full-screen)). Opened from the Home
Screen icon, the page reaches the top edge of the screen. The row with the clock stays on an
iPhone: a web page cannot hide it, only an app from the App Store can.

## Run as a desktop app

Needs Rust and, on Linux, the WebKitGTK development packages
(`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`), plus Node 20 or newer for the build tool
only: no Node process runs in the app.

```sh
npm install              # the Tauri command-line tool
npm run desktop          # run from source
npm run desktop:build    # release build
```

The release build writes the program to `src-tauri/target/release/md-reader` and a package to
`src-tauri/target/release/bundle/deb/md-reader_0.1.0_amd64.deb` (about 2 MB). Install it with
`sudo apt install ./src-tauri/target/release/bundle/deb/md-reader_0.1.0_amd64.deb`.

## Use

1. Click **Add** (the folder with a plus, above the list) and pick a kind of source. Any mix of them can be in the list at once.

   | Source | What is added |
   |---|---|
   | Folder on this computer | All its `.md` files, sub-folders included |
   | One file on this computer | Only that `.md` file; the rest of its folder stays closed |
   | From GitHub | A repository, a folder in it, or one `.md` file, downloaded to read |

   Folders and files on this computer are for the desktop app, which opens the system's
   dialog. The web version offers GitHub only.
2. Click a note to read it.
3. Remove a source with the bin button next to its name. Local files stay on disk; for a GitHub
   source the downloaded copy is deleted and the repository is not touched.

### GitHub sources

Type an address in **Add → From GitHub** and press **Next**. The desktop app needs `git`
(2.27 or newer) on the machine.

| Address | What happens |
|---|---|
| `https://github.com/owner/repo` or `owner/repo` | The folders that hold notes are listed, each with its number of notes. Tick the whole repository or any folders |
| `https://github.com/owner/repo/tree/main` | The same, for branch `main` |
| `https://github.com/owner/repo/tree/main/notes` | Adds the folder `notes` on branch `main` at once |
| `https://github.com/owner/repo/blob/main/notes/a.md` | Adds that one file at once |

- Each ticked folder becomes its own entry in the list, with its sub-folders, and is updated
  or removed on its own. A folder inside a ticked one comes with it.
- The folder button on such an entry opens the list of folders again, with the ones you have
  ticked: tick another to add it, untick one to remove it.

- Only what is asked for is downloaded (a shallow, sparse clone), into
  `~/.local/share/md-reader/repos/`. The notes are then readable offline.
- The update button on the entry (two arrows in a circle) updates the copy and lists the notes that are new, changed or removed.
- The copy is read-only from the app's side: md-reader never commits or pushes. A branch name
  with a `/` in it cannot be given in an address.
- **Private repositories**: paste a GitHub token in the same dialog and press **Save token**,
  once; it is then used for every repository. A fine-grained token with read-only "Contents"
  access to the repositories is enough. The web version asks GitHub at once whether the token
  is accepted. It is
  saved in `~/.config/md-reader/github-token`, readable by your user only. The app can replace
  or forget it but never shows it again, and hands it to `git` for one command at a time: it is
  not written into the copy or its settings. Without a saved token, `git`'s own sign-in is used.

| Control | What it does |
|---|---|
| Panel, left edge of the bar | Show or hide the list of notes |
| − 100% + | Zoom the note, in full screen too (`Ctrl` with `+`, `-` or `0` in the desktop app) |
| Printer | Print the note, or save it as a PDF from the print dialog |
| Sliders | View (continuous or pages), fonts and colours. In pages view `Page Up` / `Page Down` move one page |
| Four corners, or `F` | Full screen on or off (`Esc` also leaves; `F11` too in the desktop app) |
| Two sheets, top right of a code block | Copy the code (shown when the pointer is on the block; not printed) |
| Panel, right edge of the bar | Show or hide the outline. Below 1400px of width it lies over the note |

### Reading full screen

Full screen shows the note and nothing else. A tap or a click on the note shows the top bar
over it (to print, change the view or leave) and again hides it. The name of the note in the
bar is a button: it brings the list of notes, to open another without leaving full screen. On a touch
screen a tap on the middle of a note also enters full screen.

In pages view full screen is a book: each page has the size of the screen, one at a
time, and the pages turn sideways. Swipe, tap or click in the
outer fifth of the screen on either side, or use `←` `→`, `Page Up` `Page Down` or the space bar. Turning the
device keeps your place. Continuous view stays one sheet that scrolls down.

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
- Desktop app: the page can call only the app's own commands; it has no general file access.

## Web version (PWA)

`public/` is a complete static site. Opened in a browser, the page runs without a server: sources are GitHub repositories only, read through GitHub's API,
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
- Without a token GitHub allows 60 list requests an hour per address (adding a source and updating
  each use one or two). Opening notes does not count.
- Forgetting the token, or removing the last source of a repository, also deletes the notes
  kept from it for offline reading.
- Not there: local folders and files, reloading when a file changes (use the update button).

## The look

The sliders button opens **View, fonts and colours**: continuous or pages view, three looks
(Study, Plain white, and Dark: warm charcoal paper with light headings, made for reading at night), the fonts of the text, headings and code,
the text size, and four colours (paper, text, headings, accent). Everything is remembered.

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
| `public/icons.js` | The icons of the buttons, drawn as SVG |
| `public/settings.js` | Fonts and colours: the looks, the font lists, checking of stored values |
| `public/backend.js` | The one place that talks to the desktop app or to GitHub |
| `public/web-backend.js`, `sw.js`, `manifest.webmanifest`, `icons/` | Web version: GitHub reader, offline cache, install data |
| `public/github-url.js` | Reads a GitHub address (web version; the desktop app has the same rules in Rust) |
| `public/vendor/` | Browser builds of markdown-it and highlight.js (`npm run vendor` refreshes them) |
| `src-tauri/src/lib.rs` | Desktop app: commands, image protocol, file watching |
| `src-tauri/src/roots.rs` | Desktop app: list of sources and the path guard, with its tests |
| `src-tauri/src/github.rs` | Desktop app: download and update with `git`, the saved token |
| `test/` | Tests for the renderer, the settings, GitHub addresses and the web version's guard |
| `.github/workflows/pages.yml` | Publishes `public/` to GitHub Pages |
| `ROADMAP.md` | Planned work |
| `CLAUDE.md` | Rules and map of the code for contributors (human or AI) |

## Test

```sh
npm install                      # once, for the renderer tests
npm test                         # renderer, settings, web version
(cd src-tauri && cargo test)     # desktop app: path guard and GitHub code
npm run web                      # the web version on http://localhost:4747, to try a change
# A real download from GitHub through the Rust code (needs the network):
(cd src-tauri && XDG_DATA_HOME=/some/tmp cargo test -- --ignored)
```

## Roadmap

See [ROADMAP.md](ROADMAP.md): sign-in for the web version, and packages for macOS and
Windows.

## License

[MIT](LICENSE). The libraries in `public/vendor/` keep their own licences:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

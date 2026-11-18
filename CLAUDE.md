# md-reader

App that renders `.md` files from user-chosen sources (local folders, single local files,
GitHub folders or files) with the "study PDF" look. One no-build front end (`public/`) with
two back ends: a Tauri app (`src-tauri/`, desktop version, the only code that reads the disk)
and GitHub's API (`public/web-backend.js`: the web version, a static site and PWA, wherever
`public/` is opened in a browser). There is no server. See `README.md` for usage and
`ROADMAP.md` for what is open.

## Commands

```sh
npm run web                # the web version on http://localhost:4747 (python3 http.server)
npm test                   # node --test, no extra tooling
node --check public/app.js # syntax check for the front end
npm run desktop            # desktop app from source (tauri dev)
npm run desktop:build      # release binary + .deb under src-tauri/target/release
(cd src-tauri && cargo test)   # path guard and GitHub code
npm run vendor             # refresh public/vendor/ from node_modules
```

For manual testing of the desktop app, use a scratch list of sources so the owner's real one
is untouched: `MD_READER_CONFIG=/some/tmp/config.json src-tauri/target/debug/md-reader`. With
it set, GitHub downloads and the token file also go next to that file
(`md-reader-data/`, `github-token`), not to the owner's.
`(cd src-tauri && XDG_DATA_HOME=/some/tmp cargo test -- --ignored)` runs a real download. Close the desktop app before `npm run desktop:build`, or packaging fails with "Text
file busy".

## Rules that must not be broken

- **`.md` only.** Documents are `.md`; the only other files served are images linked from a
  note. Do not add routes that serve other file types.
- **One path guard per back end.** Desktop: every command and the `mdr` image protocol go
  through `RootStore::resolve_inside` in `src-tauri/src/roots.rs`. Never build a file path from
  request input anywhere else; a change to the guard comes with a test in the `tests` module
  of `roots.rs`. Web: `resolveInside` in `public/web-backend.js`, tested in `test/web.test.js`.
  The two follow the same rules; keep them so.
- **Sources.** A config entry is a string (local folder) or `{ path, kind: "folder" | "file",
  github? }`. A single file opens only itself, plus images in its folder or below (none when
  that folder is the home folder or `/`). A source with `github` must resolve inside
  `github.dir`; the guard checks it on every read, because a repository can hold links.
- **GitHub code** (`src-tauri/src/github.rs`). The one
  exception to "no path from request input": the download folder
  `repos/<owner>/<repo>/<key>` is built from an address that `parse_github_url` has checked part
  by part. Keep it so: no `..`, no leading `-`, nothing `git` could read as an option; always
  `--` before addresses and paths. A folder chosen in the dialog (`sub` of `add_github`) is
  checked by the same segment rule (`with_folder`; `isFolderPath` in the web version). Only
  folders exactly three levels below `repos/` are ever deleted (the short-lived `list-…` clone
  that `folders` reads file names from is one of them). The app only clones, fetches and resets: never a commit or a push.
- **The token is write-only.** Saved in `github-token` (mode 0600) next to the config file;
  no route or command returns it, no error message contains it, and it reaches `git` only
  through `GIT_CONFIG_*` environment variables of one command (never the URL, never
  `.git/config`). In the web version it is in the browser's Cache storage (`mdr-private`),
  read by `web-backend.js` and `sw.js`, and sent to `api.github.com` only.
- **Nothing is readable until the user adds a source.** Do not pre-add any, and do not write
  the owner's `~/.config/md-reader/config.json`, `github-token` or
  `~/.local/share/md-reader/` from code or during testing.
- **The desktop page gets no plugin permissions.** `src-tauri/capabilities/default.json` grants
  `core:default` only. The folder dialog and the link opener are called from Rust commands
  (`pick_folder`, `open_external`), never from the page.
- **No server.** Nothing in this project listens on a port. Do not add one without asking.
- **No raw HTML from notes.** markdown-it runs with `html: false`; the front end assigns the
  rendered HTML with `innerHTML` and relies on that.
- **No inline styles or inline scripts.** The page's Content-Security-Policy forbids them (set
  in `src-tauri/tauri.conf.json` for the desktop app; the web version adds its own as a
  `<meta>` from `web-backend.js`, since a static host sends none; keep the two in step). Table
  alignment is a class (`align-right`), not a `style` attribute. Setting `element.style` from
  JavaScript is fine.
- **No Electron, ever** (owner's rule: too heavy on RAM). The desktop app, when built, is Tauri.
- **Keep it light.** No bundler, no framework, no build step. The page uses three libraries, committed as browser builds in `public/vendor/`:
  `markdown-it`, `markdown-it-task-lists`, `highlight.js`. Rust crates: `tauri`,
  `tauri-plugin-dialog`, `tauri-plugin-opener`, `notify`, `serde`, `serde_json`,
  `percent-encoding`. GitHub sources run the `git` program; there is no git or HTTP library. Development only (npm): `@tauri-apps/cli` (builds the desktop app) and
  `@highlightjs/cdn-assets` (the browser build of highlight.js copied into `public/vendor/`).
  Ask before adding another to any of these lists.

## Where things are

- `public/render.js`: markdown-it setup, run in the page and imported by the tests. It imports
  nothing; the libraries are passed to `createRenderer()`. Core rules add heading ids and the
  outline, rewrite relative images to asset URLs and relative `.md` links to in-app links, and
  wrap a `.svg` diagram with the paragraph that introduces it (`.diagram-block`).
- `public/pages.js`: pages view. `paginate(sheet)` moves the rendered blocks into
  `<section class="page">` elements, measuring as it goes; a block that does not fit is split
  (text between lines, lists between items, tables between rows) or starts the next page. The
  second half of a split block has class `cont`. `app.js` always lays the note out again from
  the rendered HTML (`layout()`), so a view change, a font change or printing never works on
  already-cut pages. It needs a real browser layout, so it has no unit test.
- `public/icons.js`: the icons of the shell, as SVG path data. `icon(name)` builds the element
  with DOM calls (no inline style); a button in `index.html` names its icon with `data-icon`.
- `public/settings.js`: fonts and colours. Pure data and functions, tested in
  `test/settings.test.js`. A setting only ever becomes a CSS custom property; `normalize()`
  drops anything that is not a known look, a listed font, a size in range or a `#rrggbb`
  colour. The desktop app stores them under `settings` in the config file, written one key
  at a time (`write()`), keeping the rest as it is on disk; the web version uses `localStorage`.
- `public/backend.js`: the only file that knows which back end is there. `window.__TAURI__`
  present: Tauri commands; otherwise the web version. New back-end calls go here, with both
  implementations where both can have them.
- `public/web-backend.js`: the web back end. Sources and settings in `localStorage`, notes
  from `raw.githubusercontent.com` (or the API with a token), the list of notes from the git
  trees API. It also registers `sw.js` and adds the manifest link, so the desktop app never
  has a service worker. `public/sw.js`: keeps the app and opened notes for offline use and
  answers `gh-asset?...` (images of private repositories, as images only). A file added to
  `public/` must be added to `FILES` in `sw.js`. All URLs in the page are relative, so the site works below a sub-path.
- `.github/workflows/pages.yml`: publishes `public/` to GitHub Pages on a push to `main`.
  The repository is public: never commit a token, a personal address or a private path.
- `public/github-url.js`: `parseGithubUrl`, pure, used by `web-backend.js`. `github.rs` has
  the same rules; the tests in `test/github.test.js` and in
  `github.rs` use the same lists of good and bad addresses.
- `src-tauri/src/lib.rs`: the desktop back end. Commands `list_roots`,
  `add_root`, `add_file`, `github_folders`, `add_github`, `update_github`, `github_token_status`,
  `set_github_token`, `clear_github_token`, `remove_root`, `tree`, `read_doc`, `watch_doc`,
  `pick_folder`, `pick_file`, `open_external`, `set_fullscreen` (`git` runs through
  `blocking()`, off the async workers, with the store unlocked); the `mdr://` protocol serves images; a `doc-changed` event tells the page that the open note changed on disk.
- `src-tauri/src/roots.rs`: the list of sources (load/save of the config file), the path
  guard, the file tree. `src-tauri/src/github.rs`: `download`, `update`, `discard`, the token
  file, and running `git` (timeout, own process group, token through the environment).
- `public/study.css`: the look of the note. A port of the stylesheet behind the study PDFs
  (`~/notes/middle-term-exam-prep/readme-study.css`). Every font and colour is a
  CSS custom property on `.sheet`; add new ones there instead of hard-coding values, because the
  settings panel only sets these variables (the shell's own colours are variables on `:root` in
  `app.css`, set by the same panel).
- `public/app.css`: the shell (folder list, top bar, desk, outline, picker). The three panels
  have fixed grid columns; a hidden panel must not let another slide into its column. Up to
  1000px wide the list of sources lies over the note (`isNarrow()` in `app.js` uses the same
  query); below 1400px the outline does too (`outlineOverlays()`); touch rules sit under `(hover: none)`
  and `(pointer: coarse)`, short windows (a phone on its side) under `(max-height: 520px)`.
  A look that sets `--ui-bg` also sets `--ui-btn`, `--ui-btn-hover`, `--ui-shadow` and
  `--ui-scrim` (tested).
- Full screen (`app.js`, "Full screen"): `.app.reading` on every platform, panels and bar
  hidden, plus the window's own full screen where there is one (`backend.setFullscreen`).
  `.app.chrome` shows the bar over the note (tap on the note, outside the page-turn strips);
  `.app.list` the list of notes over it (the note's name in the bar is a button). In pages view it is also
  `.app.book` (one page per screen): `fit()` gives the sheet `--book-w`,
  `--book-h` and the reader's zoom (a wide screen gets wider margins, not larger text), the pages are cut for that size and the desk scrolls sideways with
  scroll snap. `readingPlace()`, `showPlace()`, `turnPage()`, `updateSpy()` and
  `updatePageInfo()` each have a book branch; a new helper that scrolls needs one too.
  `.app.reading` rules name every `no-sidebar`/`no-outline` combination to win over them.
- Copy buttons of code blocks (`addCopyButtons()` in `app.js`) are added to the note's DOM, never
  to the rendered HTML, and before `paginate()`: the button floats, so it changes where the
  first lines of code break. Print hides them.
- `public/app.js`: all front-end behaviour. Element ids start with `mdr-`; heading ids in notes
  start with `h-`, so the two never collide.

## Checking a change

- Front-end modules with tests (renderer, settings, GitHub addresses, web guard): `npm test`,
  and add a test for new behaviour. Rust: `cargo test` in `src-tauri/`.
- Desktop app window: run the binary with `GDK_BACKEND=x11` and a scratch `MD_READER_CONFIG`,
  capture it with `xwd -id <window id>` (id from `wmctrl -l`), and click buttons through the
  accessibility interface (`gi.repository.Atspi`, `do_action(0)`). Images are lazy-loaded, so
  wait a few seconds before capturing.
- Look of the note: compare against a real study PDF, for example
  `~/notes/final-exam-prep/notes/p3l1-scheduling-study.pdf`, with a headless Chrome
  screenshot. The page keeps a live-reload connection open, so pass `--timeout=6000` to Chrome
  instead of `--virtual-time-budget`, which never finishes.
- Printing: `Page.printToPDF` through the Chrome DevTools protocol (plain `--print-to-pdf`
  prints before the note is rendered). The page margins are painted by `@page` margin boxes.
- Web version: `npm run web` and open `http://localhost:4747` in Chrome (localhost counts as
  a secure origin, so the service worker runs). For tablet and phone sizes use device emulation
  (`Emulation.setDeviceMetricsOverride` through the DevTools protocol), not the window size.
- Front-end behaviour (clicks, panels, full screen) is not covered by tests. Say so when it was
  not tried in a browser.

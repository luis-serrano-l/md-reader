# md-reader

Local app that renders `.md` files from user-chosen folders with the "study PDF" look.
One no-build front end (`public/`) with two back ends: a Node server on `127.0.0.1` (browser
version) and a Tauri app (`src-tauri/`, desktop version). See `README.md` for usage and
`ROADMAP.md` for planned work.

## Commands

```sh
npm start                  # http://localhost:4747 (PORT=... to change)
npm test                   # node --test, no extra tooling
node --check public/app.js # syntax check for the front end
npm run desktop            # desktop app from source (tauri dev)
npm run desktop:build      # release binary + .deb under src-tauri/target/release
(cd src-tauri && cargo test)   # Rust path guard tests
npm run vendor             # refresh public/vendor/ from node_modules
```

For manual testing, use a scratch folder list so the owner's real one is untouched:
`MD_READER_CONFIG=/some/tmp/config.json PORT=4799 npm start`. The desktop app reads the same
variable. Close the desktop app before `npm run desktop:build`, or packaging fails with "Text
file busy".

## Rules that must not be broken

- **`.md` only.** Documents are `.md`; the only other files served are images linked from a
  note. Do not add routes that serve other file types.
- **One path guard per back end, kept identical.** Node: every route that reads from disk goes
  through `RootStore.resolveInside()` in `server/roots.js`. Rust: every command and the `mdr`
  image protocol go through `RootStore::resolve_inside` in `src-tauri/src/roots.rs`. Never build
  a file path from request input anywhere else. A change to the guard is made in both, with a
  test in `test/roots.test.js` and in the `tests` module of `roots.rs`.
- **Nothing is readable until the user adds a folder.** Do not pre-add folders or write the
  owner's `~/.config/md-reader/config.json` from code or during testing.
- **The desktop page gets no plugin permissions.** `src-tauri/capabilities/default.json` grants
  `core:default` only. The folder dialog and the link opener are called from Rust commands
  (`pick_folder`, `open_external`), never from the page.
- **Local only.** The server binds `127.0.0.1` and `checkCaller()` in `server/index.js` refuses
  foreign `Host`, `Origin` and cross-site requests. Keep both.
- **No raw HTML from notes.** markdown-it runs with `html: false`; the front end assigns the
  rendered HTML with `innerHTML` and relies on that.
- **No inline styles or inline scripts.** The page's Content-Security-Policy forbids them (set
  in `server/index.js` and in `src-tauri/tauri.conf.json`; keep the two in step). Table
  alignment is a class (`align-right`), not a `style` attribute. Setting `element.style` from
  JavaScript is fine.
- **No Electron, ever** (owner's rule: too heavy on RAM). The desktop app, when built, is Tauri.
- **Keep it light.** No bundler, no framework, no build step. The Node server has no runtime
  dependency. The page uses three libraries, committed as browser builds in `public/vendor/`:
  `markdown-it`, `markdown-it-task-lists`, `highlight.js`. Rust crates: `tauri`,
  `tauri-plugin-dialog`, `tauri-plugin-opener`, `notify`, `serde`, `serde_json`,
  `percent-encoding`. Development only (npm): `@tauri-apps/cli` (builds the desktop app) and
  `@highlightjs/cdn-assets` (the browser build of highlight.js copied into `public/vendor/`).
  Ask before adding another to any of these lists.

## Where things are

- `server/roots.js`: folder list (load/save), path guard, file tree, directory browser for the
  "Add folder" dialog.
- `public/render.js`: markdown-it setup, run in the page and imported by the tests. It imports
  nothing; the libraries are passed to `createRenderer()`. Core rules add heading ids and the
  outline, rewrite relative images to asset URLs and relative `.md` links to in-app links, and
  wrap a `.svg` diagram with the paragraph that introduces it (`.diagram-block`).
- `public/settings.js`: fonts and colours. Pure data and functions, tested in
  `test/settings.test.js`. A setting only ever becomes a CSS custom property; `normalize()`
  drops anything that is not a known look, a listed font, a size in range or a `#rrggbb`
  colour. Stored under `settings` in the config file, which both back ends write one key at a
  time (`write()`), keeping the rest as it is on disk.
- `public/backend.js`: the only file that knows which back end is there. `window.__TAURI__`
  present: Tauri commands; otherwise `fetch` to the Node server. New back-end calls go here,
  with both implementations.
- `server/index.js`: routes (`/api/roots`, `/api/browse`, `/api/tree`, `/api/doc`, `/asset`,
  `/api/watch`), `/api/doc` returns the Markdown source, static files from an explicit allow-list (`STATIC`), security headers.
- `src-tauri/src/lib.rs`: the desktop twin of `server/index.js`. Commands `list_roots`,
  `add_root`, `remove_root`, `tree`, `read_doc`, `watch_doc`, `pick_folder`, `open_external`,
  `set_fullscreen`; the `mdr://` protocol serves images; a `doc-changed` event replaces SSE.
- `src-tauri/src/roots.rs`: the desktop twin of `server/roots.js` (same config file and format;
  folder ids differ between the two back ends, so a `?root=` link is not portable).
- `public/study.css`: the look of the note. A port of the stylesheet behind the study PDFs
  (`~/notes/middle-term-exam-prep/readme-study.css`). Every font and colour is a
  CSS custom property on `.sheet`; add new ones there instead of hard-coding values, because the
  settings panel only sets these variables (the shell's own colours are variables on `:root` in
  `app.css`, set by the same panel).
- `public/app.css`: the shell (folder list, top bar, desk, outline, picker). The three panels
  have fixed grid columns; a hidden panel must not let another slide into its column.
- `public/app.js`: all front-end behaviour. Element ids start with `mdr-`; heading ids in notes
  start with `h-`, so the two never collide.

## Checking a change

- Server or renderer: `npm test`, and add a test for new behaviour. Rust: `cargo test` in
  `src-tauri/`.
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
- Front-end behaviour (clicks, panels, full screen) is not covered by tests. Say so when it was
  not tried in a browser.

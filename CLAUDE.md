# md-reader

Local app that renders `.md` files from user-chosen folders with the "study PDF" look.
Node server on `127.0.0.1` plus a no-build front end. See `README.md` for usage and
`ROADMAP.md` for planned work.

## Commands

```sh
npm start                  # http://localhost:4747 (PORT=... to change)
npm test                   # node --test, no extra tooling
node --check public/app.js # syntax check for the front end
```

For manual testing, use a scratch folder list so the owner's real one is untouched:
`MD_READER_CONFIG=/some/tmp/config.json PORT=4799 npm start`.

## Rules that must not be broken

- **`.md` only.** Documents are `.md`; the only other files served are images linked from a
  note. Do not add routes that serve other file types.
- **One path guard.** Every route that reads from disk goes through
  `RootStore.resolveInside()` in `server/roots.js`. Never build a file path from request input
  anywhere else. A change to the guard needs a test in `test/roots.test.js`.
- **Nothing is readable until the user adds a folder.** Do not pre-add folders or write the
  owner's `~/.config/md-reader/config.json` from code or during testing.
- **Local only.** The server binds `127.0.0.1` and `checkCaller()` in `server/index.js` refuses
  foreign `Host`, `Origin` and cross-site requests. Keep both.
- **No raw HTML from notes.** markdown-it runs with `html: false`; the front end assigns the
  rendered HTML with `innerHTML` and relies on that.
- **No inline styles or inline scripts.** The page's Content-Security-Policy forbids them. Table
  alignment is a class (`align-right`), not a `style` attribute. Setting `element.style` from
  JavaScript is fine.
- **No Electron, ever** (owner's rule: too heavy on RAM). The desktop app, when built, is Tauri.
- **Keep it light.** No bundler, no framework, no build step. Three runtime dependencies:
  `markdown-it`, `markdown-it-task-lists`, `highlight.js`. Ask before adding another.

## Where things are

- `server/roots.js`: folder list (load/save), path guard, file tree, directory browser for the
  "Add folder" dialog.
- `server/render.js`: markdown-it setup. Core rules add heading ids and the outline, rewrite
  relative images to `/asset?...` and relative `.md` links to in-app links, and wrap a `.svg`
  diagram with the paragraph that introduces it (`.diagram-block`).
- `server/index.js`: routes (`/api/roots`, `/api/browse`, `/api/tree`, `/api/doc`, `/asset`,
  `/api/watch`), static files from an explicit allow-list (`STATIC`), security headers.
- `public/study.css`: the look of the note. A port of the stylesheet behind the study PDFs
  (`~/notes/middle-term-exam-prep/readme-study.css`). Every font and colour is a
  CSS custom property on `.sheet`; add new ones there instead of hard-coding values, because the
  planned settings panel will only set these variables.
- `public/app.css`: the shell (folder list, top bar, desk, outline, picker). The three panels
  have fixed grid columns; a hidden panel must not let another slide into its column.
- `public/app.js`: all front-end behaviour. Element ids start with `mdr-`; heading ids in notes
  start with `h-`, so the two never collide.

## Checking a change

- Server or renderer: `npm test`, and add a test for new behaviour.
- Look of the note: compare against a real study PDF, for example
  `~/notes/final-exam-prep/notes/p3l1-scheduling-study.pdf`, with a headless Chrome
  screenshot. The page keeps a live-reload connection open, so pass `--timeout=6000` to Chrome
  instead of `--virtual-time-budget`, which never finishes.
- Front-end behaviour (clicks, panels, full screen) is not covered by tests. Say so when it was
  not tried in a browser.

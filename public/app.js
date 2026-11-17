// md-reader front end. Everything that touches the disk goes through backend.js, which is the
// local server in a browser and Tauri commands in the desktop app. Markdown is rendered here.
import { backend } from './backend.js';
import { createRenderer } from './render.js';
import { paginate, currentPage } from './pages.js';
import { PRESETS, FONTS, SIZE, COLORS, DEFAULTS, normalize, variables, shownColor } from './settings.js';

const render = createRenderer({
  MarkdownIt: window.markdownit,
  hljs: window.hljs,
  taskLists: window.markdownitTaskLists,
});
const enc = encodeURIComponent;
// Relative, so the hosted version also works below a sub-path of its site.
const docUrl = (root, path) => `?root=${enc(root)}&path=${enc(path)}`;
const $ = (id) => document.getElementById(id);
const app = $('mdr-app');
const rootsEl = $('mdr-roots');
const desk = $('mdr-desk');
const sheet = $('mdr-sheet');
const notice = $('mdr-notice');
const outline = $('mdr-outline');
const crumb = $('mdr-crumb');

const state = { roots: [], current: null, stopWatch: null, headings: [], html: '', toc: [], paged: false, layoutRun: 0 };

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`mdr:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`mdr:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable: the app works without it */
    }
  },
};

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const shortPath = (p) => p.replace(/^\/home\/[^/]+/, '~');

// ---------- List of sources (folders and single files) ----------

async function loadRoots() {
  state.roots = await backend.listRoots();
  const closed = new Set(store.get('closed', []));
  rootsEl.replaceChildren();
  if (!state.roots.length) {
    rootsEl.append(el('p', { className: 'roots-empty', textContent: 'Nothing added yet. Add a folder or a file to see its Markdown notes here.' }));
    return;
  }
  await Promise.all(
    state.roots.map(async (root) => {
      const body = el('div');
      const details = el('details', { open: !closed.has(root.id) }, [
        el('summary', { title: root.path }, [
          el('span', { className: 'root-name', textContent: root.name }),
          ...(kindLabel(root) ? [el('span', { className: 'root-kind', textContent: kindLabel(root) })] : []),
          el('span', { className: 'root-path', textContent: sourceLine(root) }),
        ]),
        body,
      ]);
      details.addEventListener('toggle', () => {
        const set = new Set(store.get('closed', []));
        details.open ? set.delete(root.id) : set.add(root.id);
        store.set('closed', [...set]);
      });
      const remove = el('button', {
        type: 'button',
        className: 'icon-btn root-remove',
        textContent: '×',
        title: `Remove ${root.name} from md-reader (nothing is deleted from where it came from)`,
      });
      remove.setAttribute('aria-label', `Remove ${root.name}`);
      remove.addEventListener('click', () => removeRoot(root));
      const wrap = el('div', { className: 'root' }, [details, remove]);
      if (root.github) {
        const update = el('button', {
          type: 'button',
          className: 'icon-btn root-remove root-update',
          textContent: '↻',
          title: `Update ${root.name} from GitHub`,
        });
        update.setAttribute('aria-label', `Update ${root.name} from GitHub`);
        update.addEventListener('click', () => updateRoot(root, update));
        wrap.append(update);
      }
      wrap.dataset.root = root.id;
      root.el = wrap;
      try {
        const tree = await backend.tree(root.id);
        if (!tree.nodes.length) body.append(el('p', { className: 'root-note', textContent: 'No .md files in this folder.' }));
        else body.append(renderTree(root.id, tree.nodes));
        if (tree.truncated) body.append(el('p', { className: 'root-note', textContent: 'Large folder: list cut short.' }));
      } catch (err) {
        body.append(el('p', { className: 'root-note', textContent: err.message }));
      }
    }),
  );
  rootsEl.append(...state.roots.map((r) => r.el));
  markActive();
}

// What kind of source an entry is, shown next to its name. A plain folder needs no label.
const kindLabel = (root) => (root.github ? 'GitHub' : root.kind === 'file' ? 'file' : '');
const sourceLine = (root) =>
  root.github ? [root.github.repo, root.github.ref, root.github.sub].filter(Boolean).join(' · ') : shortPath(root.path);

function renderTree(rootId, nodes) {
  const list = el('ul', { className: 'tree' });
  for (const node of nodes) {
    if (node.type === 'dir') {
      list.append(
        el('li', {}, [
          el('details', { className: 'dir', open: true }, [
            el('summary', { textContent: node.name }),
            renderTree(rootId, node.children),
          ]),
        ]),
      );
    } else {
      const stem = node.name.replace(/\.md$/i, '');
      const button = el('button', { type: 'button', className: 'file' }, [
        stem,
        el('span', { className: 'ext', textContent: node.name.slice(stem.length) }),
      ]);
      button.dataset.root = rootId;
      button.dataset.path = node.path;
      button.addEventListener('click', () => {
        openDoc(rootId, node.path, { push: true });
        if (window.innerWidth <= 760) app.classList.add('no-sidebar');
      });
      list.append(el('li', {}, [button]));
    }
  }
  return list;
}

function markActive() {
  for (const button of rootsEl.querySelectorAll('.file')) {
    const active =
      !!state.current && button.dataset.root === state.current.root && button.dataset.path === state.current.path;
    button.classList.toggle('active', active);
    if (active) {
      button.setAttribute('aria-current', 'page');
      for (let d = button.closest('details'); d; d = d.parentElement.closest('details')) d.open = true;
    } else button.removeAttribute('aria-current');
  }
}

async function removeRoot(root) {
  const what = root.github
    ? `${backend.kind === 'web' ? '' : 'The downloaded copy is deleted. '}The repository on GitHub is not touched.`
    : root.kind === 'file' ? 'The file stays on disk.' : 'The folder and its files stay on disk.';
  const yes = await ask(`Remove "${root.name}" from md-reader?`, what, 'Remove');
  if (!yes) return;
  try {
    await backend.removeRoot(root.id);
  } catch (err) {
    await ask('It could not be removed', err.message);
    return;
  }
  if (state.current?.root === root.id) {
    closeDoc();
    history.replaceState(null, '', location.pathname);
  }
  await loadRoots();
  if (!state.current) showWelcome();
}

// A small in-page message box. With okLabel it asks a yes/no question; without, it only informs.
let askQueue = Promise.resolve();
function ask(title, text, okLabel) {
  // One box at a time: a second question waits for the first to close.
  const next = askQueue.then(() => showAsk(title, text, okLabel));
  askQueue = next.catch(() => {});
  return next;
}
function showAsk(title, text, okLabel) {
  const dialog = $('mdr-ask');
  $('mdr-ask-title').textContent = title;
  $('mdr-ask-text').textContent = text;
  $('mdr-ask-ok').textContent = okLabel || 'OK';
  $('mdr-ask-cancel').hidden = !okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}
$('mdr-ask-ok').addEventListener('click', () => $('mdr-ask').close('ok'));
$('mdr-ask-cancel').addEventListener('click', () => $('mdr-ask').close(''));

// ---------- Opening a note ----------

function showNotice(title, text, { error = false, action } = {}) {
  sheet.hidden = true;
  notice.className = error ? 'notice error' : 'notice';
  notice.replaceChildren(el('h2', { textContent: title }), el('p', { textContent: text }));
  if (action) notice.append(action);
}

function showWelcome() {
  if (!state.roots.length) {
    const add = el('button', { type: 'button', className: 'btn primary', textContent: 'Add…' });
    add.addEventListener('click', () => $('mdr-sources').showModal());
    showNotice('Choose what to read', 'md-reader opens only the Markdown (.md) files of the folders and files you add.', { action: add });
  } else showNotice('Pick a note', 'Choose a Markdown file from the list on the left.');
}

function closeDoc() {
  state.stopWatch?.();
  state.stopWatch = null;
  state.current = null;
  state.headings = [];
  state.html = '';
  state.toc = [];
  sheet.hidden = true;
  sheet.replaceChildren();
  sheet.classList.remove('paged');
  updatePageInfo();
  outline.replaceChildren();
  crumb.replaceChildren();
  document.title = 'md-reader';
  markActive();
}

const scrollKey = (root, path) => `scroll:${root}:${path}`;

async function openDoc(root, path, { push = false, hash = '', keepScroll = false } = {}) {
  let doc;
  try {
    const file = await backend.readDoc(root, path);
    doc = {
      path: file.path,
      ...render(file.source, {
        docRel: file.path,
        assetUrl: (rel) => backend.assetUrl(root, rel),
        docUrl: (rel) => docUrl(root, rel),
      }),
    };
  } catch (err) {
    if (keepScroll) return; // a failed live reload leaves the note on screen
    closeDoc();
    showNotice('This note cannot be opened', err.message, { error: true });
    return;
  }
  const sameDoc = state.current?.root === root && state.current?.path === doc.path;
  const place = keepScroll && sameDoc ? readingPlace() : null;
  state.current = { root, path: doc.path };
  state.html = doc.html;
  state.toc = doc.toc;

  sheet.hidden = false;
  notice.replaceChildren();
  document.title = `${doc.title} · md-reader`;
  const rootInfo = state.roots.find((r) => r.id === root);
  // A single file is its own entry: its name is not repeated.
  crumb.replaceChildren(rootInfo && rootInfo.kind !== 'file' ? `${rootInfo.name} / ` : '', el('b', { textContent: doc.path }));
  crumb.title = !rootInfo ? doc.path : rootInfo.kind === 'file' ? rootInfo.path : `${rootInfo.path}/${doc.path}`;
  markActive();
  store.set('last', state.current);

  const url = docUrl(root, doc.path) + hash;
  if (push) history.pushState(null, '', url);
  else if (!keepScroll) history.replaceState(null, '', url);

  await layout({
    after() {
      if (state.html !== doc.html) return; // another note was opened meanwhile
      const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
      if (keepScroll && sameDoc) showPlace(place);
      else if (target) target.scrollIntoView();
      else showPlace(store.get(scrollKey(root, doc.path), null));
    },
  });
  if (state.current?.root !== root || state.current?.path !== doc.path) return;
  if (!sameDoc || !state.stopWatch) watch(root, doc.path);
}

function watch(root, path) {
  state.stopWatch?.();
  state.stopWatch = backend.watch(root, path, () => {
    if (state.current?.root === root && state.current?.path === path) openDoc(root, path, { keepScroll: true });
  });
}

// ---------- Continuous view and pages view ----------
// The note is always laid out from the rendered HTML: as one sheet, or cut into pages.

// The blocks that exist once in both views (the second half of a block cut by a page is `.cont`).
const PLACES = ['p', 'li', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((tag) => `${tag}:not(.cont)`).join(', ') + ', tbody > tr, img';
const places = () => [...sheet.querySelectorAll(PLACES)];

// The first block on screen and how far its top is from the top of the desk, so the same block
// can be shown at the same height after a new layout, in either view. null: the top of the note.
function readingPlace() {
  if (desk.scrollTop < 4) return null;
  const top = desk.getBoundingClientRect().top;
  const all = places();
  const index = all.findIndex((node) => node.getBoundingClientRect().bottom > top + 1);
  return index < 0 ? null : { index, offset: Math.round(all[index].getBoundingClientRect().top - top) };
}

function showPlace(place) {
  if (typeof place === 'number') desk.scrollTop = place; // stored by an older version
  const node = place && typeof place === 'object' && places()[place.index];
  if (!node) {
    if (!place) desk.scrollTop = 0;
    return;
  }
  const box = node.getBoundingClientRect();
  // A long block may have been cut by a page since: never scroll past its own end.
  const offset = Math.max(Number(place.offset) || 0, 24 - box.height);
  desk.scrollTop += box.top - desk.getBoundingClientRect().top - offset;
}

function whenImagesLoaded(within, limit) {
  const images = [...within.querySelectorAll('img')];
  for (const img of images) img.loading = 'eager';
  const loaded = images
    .filter((img) => !img.complete)
    .map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }));
  return Promise.race([Promise.all(loaded), new Promise((resolve) => setTimeout(resolve, limit))]);
}

function showContinuous() {
  // The HTML comes from render.js, which does not pass a note's raw HTML through.
  sheet.innerHTML = state.html;
  sheet.classList.remove('paged');
  renderOutline(state.toc);
}

// Cuts the pages in a copy of the sheet that is laid out but not shown, then swaps them in, so
// the note on screen does not flash while pictures load.
async function showPages() {
  const html = state.html;
  const work = sheet.cloneNode(false);
  work.removeAttribute('id');
  work.hidden = false;
  work.classList.remove('paged');
  work.innerHTML = html;
  const holder = el('div', { className: 'measure' }, [work]);
  desk.append(holder);
  try {
    // A page can only be cut right once the height of every picture is known.
    await whenImagesLoaded(work, 4000);
    if (document.fonts?.status === 'loading') await document.fonts.ready;
    if (state.html !== html) return; // closed, or another note was opened meanwhile
    paginate(work);
    sheet.replaceChildren(...work.childNodes);
    sheet.classList.add('paged');
  } finally {
    holder.remove();
  }
  renderOutline(state.toc);
  // A picture that arrives after the wait above changes the height of its page.
  for (const img of sheet.querySelectorAll('img')) {
    if (!img.complete) img.addEventListener('load', relayoutSoon, { once: true });
  }
}

// One layout at a time. `keepPlace` stays at the block being read; `after` runs once the note
// is on the sheet (to scroll). `paged` can be forced (printing uses one sheet).
let layoutQueue = Promise.resolve();
function layout({ paged = state.paged, keepPlace = false, after } = {}) {
  const task = layoutQueue.then(async () => {
    const place = keepPlace ? readingPlace() : null;
    if (paged && state.html) await showPages();
    else showContinuous();
    if (keepPlace) showPlace(place);
    after?.();
    lastWidth = sheet.getBoundingClientRect().width;
    updateSpy();
    updatePageInfo();
  });
  layoutQueue = task.catch(() => {});
  return task;
}

const relayout = () => (state.current ? layout({ keepPlace: true }) : Promise.resolve());
let relayoutTimer = null;
function relayoutSoon() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => {
    if (sheet.classList.contains('paged')) relayout();
  }, 300);
}

// A narrower or wider sheet (small window, zoom) wraps the text differently: cut the pages again.
let lastWidth = 0;
new ResizeObserver(() => {
  const width = sheet.getBoundingClientRect().width;
  if (!sheet.classList.contains('paged') || Math.abs(width - lastWidth) < 1) return;
  lastWidth = width;
  relayoutSoon();
}).observe(sheet);

function updatePageInfo() {
  const info = $('mdr-page-info');
  const total = sheet.classList.contains('paged') ? sheet.children.length : 0;
  info.hidden = !total;
  if (!total) return;
  const box = desk.getBoundingClientRect();
  info.textContent = `page ${currentPage(sheet, box.top + box.height / 2)} of ${total}`;
}

function setView(paged) {
  state.paged = paged;
  store.set('view', paged ? 'pages' : 'continuous');
  const button = $('mdr-view');
  button.setAttribute('aria-pressed', String(paged));
  button.title = paged ? 'Pages view is on. Click for continuous view.' : 'Continuous view is on. Click for pages view.';
  return relayout();
}
$('mdr-view').addEventListener('click', () => setView(!state.paged));

// Page Up and Page Down move one page at a time in pages view, or one screen when a page is
// taller than the window (large zoom), so no part of a page is skipped.
function turnPage(step) {
  const top = desk.getBoundingClientRect().top + 12;
  const screen = desk.clientHeight - 40;
  const tops = [...sheet.children].map((page) => page.getBoundingClientRect().top);
  if (step > 0) {
    const next = tops.find((t) => t > top + 4);
    desk.scrollTop += next === undefined ? screen : Math.min(screen, next - top);
  } else {
    const previous = tops.findLast((t) => t < top - 4);
    desk.scrollTop -= previous === undefined ? screen : Math.min(screen, top - previous);
  }
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'PageDown' && event.key !== 'PageUp') return;
  if (!sheet.classList.contains('paged') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (document.querySelector('dialog[open]') || event.target.closest?.('input, textarea, select')) return;
  event.preventDefault();
  turnPage(event.key === 'PageDown' ? 1 : -1);
});

// ---------- Outline ----------

function renderOutline(toc) {
  const items = toc.filter((h) => h.level <= 3);
  outline.replaceChildren();
  state.headings = [];
  if (items.length < 2) return;
  outline.append(el('div', { className: 'outline-title', textContent: 'Outline' }));
  for (const h of items) {
    const link = el('a', { href: `#${h.id}`, className: `lvl-${h.level}`, textContent: h.text });
    outline.append(link);
    const target = document.getElementById(h.id);
    if (target) state.headings.push({ target, link });
  }
}

function updateSpy() {
  if (!state.headings.length) return;
  const line = desk.getBoundingClientRect().top + 60;
  let current = state.headings[0];
  for (const h of state.headings) {
    if (h.target.getBoundingClientRect().top <= line) current = h;
    else break;
  }
  for (const h of state.headings) h.link.classList.toggle('current', h === current);
  if (!outline.matches(':hover')) current.link.scrollIntoView({ block: 'nearest' });
}

let scrollTimer = null;
desk.addEventListener(
  'scroll',
  () => {
    updateSpy();
    updatePageInfo();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (state.current) store.set(scrollKey(state.current.root, state.current.path), readingPlace());
    }, 200);
  },
  { passive: true },
);

// Links between notes open in place instead of reloading the app. In the desktop app, web links
// are handed to the system browser.
sheet.addEventListener('click', (event) => {
  if (event.button !== 0) return;
  const link = event.target.closest('a');
  if (!link) return;
  // A browser opens a Ctrl/Shift-click in a new tab; the desktop app has one window.
  const newTab = backend.kind !== 'tauri' && (event.ctrlKey || event.metaKey || event.shiftKey);
  if (link.dataset.doc && !newTab) {
    event.preventDefault();
    openDoc(state.current.root, link.dataset.doc, { push: true, hash: new URL(link.href).hash });
  } else if (link.target === '_blank' && backend.openExternal) {
    event.preventDefault();
    backend.openExternal(link.href).catch((err) => ask('The link could not be opened', err.message));
  }
});

// ---------- Zoom and panels ----------

const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];
function setZoom(value) {
  const zoom = Math.min(2, Math.max(0.7, value));
  sheet.style.zoom = zoom;
  $('mdr-zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
  store.set('zoom', zoom);
  updateSpy();
}
const currentZoom = () => Number(sheet.style.zoom) || 1;
$('mdr-zoom-in').addEventListener('click', () => setZoom(ZOOM_STEPS.find((z) => z > currentZoom() + 0.001) ?? 2));
$('mdr-zoom-out').addEventListener('click', () => setZoom([...ZOOM_STEPS].reverse().find((z) => z < currentZoom() - 0.001) ?? 0.7));
$('mdr-zoom-reset').addEventListener('click', () => setZoom(1));

function togglePanel(name) {
  const hidden = app.classList.toggle(`no-${name}`);
  store.set(`no-${name}`, hidden);
}
$('mdr-toggle-sidebar').addEventListener('click', () => togglePanel('sidebar'));
$('mdr-toggle-outline').addEventListener('click', () => togglePanel('outline'));

// ---------- Fonts and colours ----------
// A setting is only ever a CSS custom property on the sheet (study.css) or the page (app.css).

let settings = normalize(null);
let applied = [];
let saveTimer = null;

function applySettings() {
  for (const [target, name] of applied) target.style.removeProperty(name);
  applied = [];
  const vars = variables(settings);
  const page = document.documentElement;
  page.style.colorScheme = vars.scheme;
  for (const [name, value] of Object.entries(vars.sheet)) {
    sheet.style.setProperty(name, value);
    applied.push([sheet, name]);
  }
  for (const [name, value] of Object.entries(vars.ui)) {
    page.style.setProperty(name, value);
    applied.push([page, name]);
  }
  // The printed page is filled with the paper colour (see @media print in app.css).
  page.style.setProperty('--print-paper', getComputedStyle(sheet).getPropertyValue('--paper').trim());
  updateSpy();
}

function changeSettings(patch) {
  settings = normalize({ ...settings, ...patch });
  applySettings();
  fillSettingsForm();
  $('mdr-settings-error').textContent = '';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettingsNow, 400);
  // Another font or size moves the page breaks.
  relayoutSoon();
}

function saveSettingsNow() {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  backend.saveSettings(settings).catch((err) => {
    $('mdr-settings-error').textContent = `Not saved: ${err.message}`;
  });
}
// A change made just before the window closes is still saved.
window.addEventListener('pagehide', saveSettingsNow);

function fillSelect(select, table) {
  select.replaceChildren(...Object.entries(table).map(([value, { label }]) => el('option', { value, textContent: label })));
}

function fillSettingsForm() {
  $('mdr-set-preset').value = settings.preset;
  $('mdr-set-body').value = settings.body;
  $('mdr-set-head').value = settings.head;
  $('mdr-set-mono').value = settings.mono;
  $('mdr-set-size').value = settings.size;
  $('mdr-set-size-value').textContent = `${settings.size} pt`;
  for (const name of Object.keys(COLORS)) {
    $(`mdr-set-color-${name}`).value = shownColor(settings, name);
    $(`mdr-set-color-${name}-reset`).hidden = !settings.colors[name];
  }
}

function buildSettingsForm() {
  fillSelect($('mdr-set-preset'), PRESETS);
  fillSelect($('mdr-set-body'), FONTS.body);
  fillSelect($('mdr-set-head'), FONTS.head);
  fillSelect($('mdr-set-mono'), FONTS.mono);
  Object.assign($('mdr-set-size'), { min: SIZE.min, max: SIZE.max, step: SIZE.step });
  // Choosing a look starts from that look's own colours.
  $('mdr-set-preset').addEventListener('change', (e) => changeSettings({ preset: e.target.value, colors: {} }));
  for (const key of ['body', 'head', 'mono']) {
    $(`mdr-set-${key}`).addEventListener('change', (e) => changeSettings({ [key]: e.target.value }));
  }
  $('mdr-set-size').addEventListener('input', (e) => changeSettings({ size: Number(e.target.value) }));
  for (const [name, { label }] of Object.entries(COLORS)) {
    const input = el('input', { type: 'color', id: `mdr-set-color-${name}` });
    const reset = el('button', { type: 'button', className: 'btn', id: `mdr-set-color-${name}-reset`, textContent: 'Reset' });
    input.addEventListener('input', () => changeSettings({ colors: { ...settings.colors, [name]: input.value } }));
    reset.addEventListener('click', () => {
      const colors = { ...settings.colors };
      delete colors[name];
      changeSettings({ colors });
    });
    $('mdr-set-colors').append(
      el('label', { htmlFor: input.id, textContent: label }),
      el('div', { className: 'settings-color' }, [input, reset]),
    );
  }
  $('mdr-settings-open').addEventListener('click', () => {
    fillSettingsForm();
    $('mdr-settings').showModal();
  });
  $('mdr-settings-close').addEventListener('click', () => $('mdr-settings').close());
  $('mdr-settings').addEventListener('close', saveSettingsNow);
  $('mdr-settings-reset').addEventListener('click', () => changeSettings({ ...DEFAULTS, colors: {} }));
  $('mdr-settings-form').addEventListener('submit', (event) => event.preventDefault());
}

async function loadSettings() {
  try {
    settings = normalize(await backend.getSettings());
  } catch {
    settings = normalize(null); // the study look
  }
  applySettings();
}

// ---------- Print ----------
// Images load lazily, so the ones not scrolled to yet are fetched before the print dialog opens.

// The printer cuts its own pages, so a note shown in pages view is printed from one sheet.

async function printDoc() {
  if (!state.current) return;
  if (sheet.classList.contains('paged')) await layout({ paged: false, keepPlace: true });
  await whenImagesLoaded(sheet, 5000);
  window.print();
}
$('mdr-print').addEventListener('click', printDoc);
window.addEventListener('beforeprint', () => {
  // Reached without the button (Ctrl+P, the browser's menu): the sheet is rebuilt at once.
  if (sheet.classList.contains('paged')) {
    const place = readingPlace();
    showContinuous();
    showPlace(place);
  }
  for (const img of sheet.querySelectorAll('img')) img.loading = 'eager';
});
window.addEventListener('afterprint', () => {
  if (state.paged && !sheet.classList.contains('paged')) relayout();
});

// ---------- Full screen ----------
// Full screen with the app unchanged: panels and top bar stay. F, F11 or the button toggles it;
// Esc leaves.

// Where the browser has no full screen for pages (iPad and iPhone, above all as an installed
// app), the button gives the note the whole window instead: panels and top bar are hidden and
// a small button brings them back.
const exitReading = $('mdr-exit-reading');
function setReading(on) {
  const top = desk.scrollTop;
  $('mdr-app').classList.toggle('reading', on);
  exitReading.hidden = !on;
  desk.scrollTop = top;
}
async function toggleFullscreen() {
  if ($('mdr-app').classList.contains('reading')) return setReading(false);
  const was = !!document.fullscreenElement;
  await Promise.resolve(backend.toggleFullscreen()).catch(() => {});
  if (backend.kind !== 'tauri' && !was && !document.fullscreenElement) setReading(true);
}
$('mdr-fullscreen').addEventListener('click', toggleFullscreen);
exitReading.addEventListener('click', () => setReading(false));
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
  if (event.target.closest?.('input, textarea, select')) return;
  if (event.key === 'f' || event.key === 'F') toggleFullscreen();
  else if (event.key === 'F11' && backend.kind === 'tauri') {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.key === 'Escape') {
    setReading(false);
    backend.exitFullscreen?.().catch(() => {}); // a browser leaves by itself
  }
});

// ---------- Sources from GitHub ----------

const names = (list) => (list.length > 8 ? `${list.slice(0, 8).join(', ')} and ${list.length - 8} more` : list.join(', '));

// Brings the downloaded copy up to date and says which notes changed.
async function updateRoot(root, button) {
  button.disabled = true;
  try {
    const { added, changed, removed } = await backend.updateGithub(root.id);
    const parts = [
      added.length && `New: ${names(added)}.`,
      changed.length && `Changed: ${names(changed)}.`,
      removed.length && `Removed: ${names(removed)}.`,
    ].filter(Boolean);
    if (parts.length) {
      await loadRoots();
      const open = state.current?.root === root.id ? state.current.path : null;
      // A note that is gone says so in place of its text. A changed one is reloaded by the
      // watcher where there is one; the hosted version has none.
      if (open && removed.includes(open)) await openDoc(root.id, open).catch(() => {});
      else if (open && changed.includes(open) && backend.kind === 'web') await openDoc(root.id, open, { keepScroll: true }).catch(() => {});
    }
    await ask(parts.length ? `${root.name} was updated` : `${root.name} is up to date`, parts.join(' ') || 'No note changed on GitHub.');
  } catch (err) {
    await ask(`${root.name} could not be updated`, err.message);
  } finally {
    button.disabled = false;
  }
}

const githubDialog = $('mdr-github');
const githubError = $('mdr-github-error');

async function showTokenState() {
  let saved = false;
  try {
    saved = await backend.githubToken();
  } catch {
    /* shown as not saved */
  }
  $('mdr-github-token-state').textContent = saved
    ? 'A token is saved on this computer and is used for every download. It cannot be read back, only replaced or forgotten.'
    : 'No token is saved. Public repositories need none. For a private one, paste a token that may read it (a fine-grained token with read-only "Contents" access is enough). ' + (backend.kind === 'web' ? 'It is kept in this browser, on this device.' : 'It is kept in a file only your user can read.');
  $('mdr-github-token-clear').hidden = !saved;
}

async function openGithub() {
  githubError.textContent = '';
  $('mdr-github-busy').textContent = '';
  $('mdr-github-token').value = '';
  githubDialog.showModal();
  $('mdr-github-url').focus();
  await showTokenState();
}

async function saveToken() {
  githubError.textContent = '';
  const field = $('mdr-github-token');
  if (!field.value.trim()) return;
  try {
    await backend.saveGithubToken(field.value);
    field.value = '';
  } catch (err) {
    githubError.textContent = err.message;
  }
  await showTokenState();
}

async function addGithub() {
  const url = $('mdr-github-url').value.trim();
  if (!url || $('mdr-github-add').disabled) return;
  githubError.textContent = '';
  if ($('mdr-github-token').value.trim()) await saveToken(); // a pasted token is meant to be used
  if (githubError.textContent) return;
  $('mdr-github-add').disabled = true;
  $('mdr-github-busy').textContent = 'Downloading…';
  try {
    const root = await backend.addGithub(url);
    await loadRoots();
    $('mdr-github-url').value = '';
    githubDialog.close();
    if (root.kind === 'file') await openDoc(root.id, root.name, { push: true }).catch(() => {});
    else if (!state.current) showWelcome();
  } catch (err) {
    githubError.textContent = err.message;
  } finally {
    $('mdr-github-add').disabled = false;
    $('mdr-github-busy').textContent = '';
  }
}

$('mdr-github-form').addEventListener('submit', (event) => {
  event.preventDefault();
  addGithub();
});
$('mdr-github-cancel').addEventListener('click', () => githubDialog.close());
$('mdr-github-token-save').addEventListener('click', saveToken);
$('mdr-github-token-clear').addEventListener('click', async () => {
  await backend.clearGithubToken().catch(() => {});
  await showTokenState();
});

// ---------- Adding a source ----------

const picker = $('mdr-picker');
const pickerInput = $('mdr-picker-input');
const pickerList = $('mdr-picker-list');
const pickerError = $('mdr-picker-error');
const pickerCount = $('mdr-picker-count');
let pickerDir = null;
let pickerFiles = false; // true while the picker is choosing one file instead of a folder

const mdCount = (n) => (n === 1 ? '1 .md file' : `${n} .md files`);
const isMd = (path) => /\.md$/i.test(path);

// The kinds of source that can be added. Each `add` opens its own dialog.
const SOURCES = [
  { title: 'Folder on this computer', text: 'All the .md files in it, sub-folders included.', add: () => pickLocal(false), local: true },
  { title: 'One file on this computer', text: 'Only that .md file. The rest of its folder stays closed.', add: () => pickLocal(true), local: true },
  { title: 'From GitHub', text: 'A repository, a folder in it or one .md file, downloaded to read. Private ones with a token.', add: () => openGithub() },
];

function buildSourceChoices() {
  // The hosted version has no disk to read: only GitHub is offered there.
  for (const source of SOURCES.filter((s) => !s.local || backend.kind !== 'web')) {
    const button = el('button', { type: 'button' }, [el('b', { textContent: source.title }), el('span', { textContent: source.text })]);
    button.addEventListener('click', () => {
      $('mdr-sources').close();
      source.add();
    });
    $('mdr-source-choices').append(button);
  }
}

async function browseTo(dir) {
  pickerError.textContent = '';
  let listing;
  try {
    listing = await backend.browse(dir, pickerFiles);
  } catch (err) {
    pickerError.textContent = err.message;
    return false;
  }
  pickerDir = listing;
  pickerInput.value = listing.dir;
  $('mdr-picker-up').disabled = !listing.parent;
  pickerCount.textContent = `${mdCount(listing.md)} directly in this folder`;
  pickerList.replaceChildren();
  const files = pickerFiles ? listing.files || [] : [];
  if (!listing.dirs.length && !files.length) {
    pickerList.append(el('li', { className: 'empty', textContent: pickerFiles ? 'No sub-folders or .md files here.' : 'No sub-folders here.' }));
  }
  for (const d of listing.dirs) {
    const button = el('button', { type: 'button' }, [
      el('span', { textContent: `${d.name}/` }),
      el('span', { className: 'count', textContent: d.md ? mdCount(d.md) : '' }),
    ]);
    button.addEventListener('click', () => browseTo(d.path));
    pickerList.append(el('li', {}, [button]));
  }
  for (const f of files) {
    const button = el('button', { type: 'button', className: 'is-file' }, [
      el('span', { textContent: f.name }),
      el('span', { className: 'count', textContent: 'add this file' }),
    ]);
    button.addEventListener('click', () => addFromPicker(f.path));
    pickerList.append(el('li', {}, [button]));
  }
  pickerList.scrollTop = 0;
  return true;
}

// Desktop app: the system's own dialog. Browser: the in-page browser of folders (and .md files).
async function pickLocal(file) {
  const native = file ? backend.pickFile : backend.pickFolder;
  if (native) {
    try {
      const path = await native();
      if (path) await addLocal(path, file);
    } catch (err) {
      await ask(file ? 'The file could not be added' : 'The folder could not be added', err.message);
    }
    return;
  }
  pickerFiles = file;
  $('mdr-picker-title').textContent = file ? 'Add a file' : 'Add a folder';
  $('mdr-picker-help').textContent = file
    ? 'Pick one Markdown (.md) file. md-reader will open only that file, and the images it shows from its own folder.'
    : 'md-reader can open only the Markdown (.md) files inside the folders you add here.';
  pickerInput.setAttribute('aria-label', file ? 'Folder or file path' : 'Folder path');
  $('mdr-picker-add').hidden = file;
  picker.showModal();
  await browseTo(store.get('picker-dir', null));
  if (!pickerDir) await browseTo(null);
  pickerInput.focus();
}

async function addLocal(path, file) {
  const root = await (file ? backend.addFile(path) : backend.addRoot(path));
  await loadRoots();
  // The source is in the list from here on: a note that then fails to open says so itself.
  if (file) await openDoc(root.id, root.name, { push: true }).catch(() => {});
  else if (!state.current) showWelcome();
  return root;
}

async function addFromPicker(path = pickerInput.value.trim()) {
  if (!path) return;
  try {
    const root = await addLocal(path, pickerFiles);
    store.set('picker-dir', root.path.replace(/\/[^/]*$/, '') || '/');
    picker.close();
  } catch (err) {
    pickerError.textContent = err.message;
  }
}

// A typed path: a folder is opened in the list; in file mode a .md path is added straight away.
// (A folder may be named like a note, so the folder is tried first.)
const goToTyped = async () => {
  const typed = pickerInput.value.trim();
  if (!(await browseTo(typed)) && pickerFiles && isMd(typed)) await addFromPicker(typed);
};

$('mdr-add').addEventListener('click', () => $('mdr-sources').showModal());
$('mdr-picker-cancel').addEventListener('click', () => picker.close());
$('mdr-picker-up').addEventListener('click', () => pickerDir?.parent && browseTo(pickerDir.parent));
$('mdr-picker-go').addEventListener('click', goToTyped);
$('mdr-picker-add').addEventListener('click', () => addFromPicker());
$('mdr-picker-form').addEventListener('submit', (event) => event.preventDefault());
pickerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    goToTyped();
  }
});

// ---------- Start ----------

function fromLocation() {
  const q = new URLSearchParams(location.search);
  return q.get('root') && q.get('path') ? { root: q.get('root'), path: q.get('path'), hash: location.hash } : null;
}

window.addEventListener('popstate', () => {
  const target = fromLocation();
  if (!target) {
    closeDoc();
    showWelcome();
  } else if (target.root !== state.current?.root || target.path !== state.current?.path) openDoc(target.root, target.path, target);
});

async function start() {
  if (store.get('no-sidebar', false) || window.innerWidth <= 760) app.classList.add('no-sidebar');
  if (store.get('no-outline', false)) app.classList.add('no-outline');
  setZoom(store.get('zoom', 1));
  state.paged = store.get('view', 'continuous') === 'pages';
  $('mdr-view').setAttribute('aria-pressed', String(state.paged));
  buildSettingsForm();
  buildSourceChoices();
  await loadSettings();
  try {
    await loadRoots();
  } catch (err) {
    showNotice('md-reader cannot reach its server', err.message, { error: true });
    return;
  }
  const target = fromLocation() || store.get('last', null);
  if (target && state.roots.some((r) => r.id === target.root)) await openDoc(target.root, target.path, target);
  else showWelcome();
}

start();

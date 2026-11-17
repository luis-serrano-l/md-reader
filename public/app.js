// md-reader front end. Everything that touches the disk goes through backend.js, which is the
// local server in a browser and Tauri commands in the desktop app. Markdown is rendered here.
import { backend } from './backend.js';
import { createRenderer } from './render.js';
import { PRESETS, FONTS, SIZE, COLORS, DEFAULTS, normalize, variables, shownColor } from './settings.js';

const render = createRenderer({
  MarkdownIt: window.markdownit,
  hljs: window.hljs,
  taskLists: window.markdownitTaskLists,
});
const enc = encodeURIComponent;
const docUrl = (root, path) => `/?root=${enc(root)}&path=${enc(path)}`;
const $ = (id) => document.getElementById(id);
const app = $('mdr-app');
const rootsEl = $('mdr-roots');
const desk = $('mdr-desk');
const sheet = $('mdr-sheet');
const notice = $('mdr-notice');
const outline = $('mdr-outline');
const crumb = $('mdr-crumb');

const state = { roots: [], current: null, stopWatch: null, headings: [] };

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

// ---------- Folder list ----------

async function loadRoots() {
  state.roots = await backend.listRoots();
  const closed = new Set(store.get('closed', []));
  rootsEl.replaceChildren();
  if (!state.roots.length) {
    rootsEl.append(el('p', { className: 'roots-empty', textContent: 'No folders yet. Add one to see its Markdown files here.' }));
    return;
  }
  await Promise.all(
    state.roots.map(async (root) => {
      const body = el('div');
      const details = el('details', { open: !closed.has(root.id) }, [
        el('summary', { title: root.path }, [
          el('span', { className: 'root-name', textContent: root.name }),
          el('span', { className: 'root-path', textContent: shortPath(root.path) }),
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
        title: `Remove ${root.name} from md-reader (the files stay on disk)`,
      });
      remove.setAttribute('aria-label', `Remove folder ${root.name}`);
      remove.addEventListener('click', () => removeRoot(root));
      const wrap = el('div', { className: 'root' }, [details, remove]);
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
  const yes = await ask(`Remove "${root.name}" from md-reader?`, 'The folder and its files stay on disk.', 'Remove');
  if (!yes) return;
  try {
    await backend.removeRoot(root.id);
  } catch (err) {
    await ask('The folder could not be removed', err.message);
    return;
  }
  if (state.current?.root === root.id) {
    closeDoc();
    history.replaceState(null, '', '/');
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
    const add = el('button', { type: 'button', className: 'btn primary', textContent: 'Add folder' });
    add.addEventListener('click', openPicker);
    showNotice('Choose a folder to read from', 'md-reader opens only the Markdown (.md) files inside the folders you add.', { action: add });
  } else showNotice('Pick a note', 'Choose a Markdown file from the list on the left.');
}

function closeDoc() {
  state.stopWatch?.();
  state.stopWatch = null;
  state.current = null;
  state.headings = [];
  sheet.hidden = true;
  sheet.replaceChildren();
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
  const top = desk.scrollTop;
  state.current = { root, path: doc.path };

  // The HTML comes from render.js, which does not pass a note's raw HTML through.
  sheet.innerHTML = doc.html;
  sheet.hidden = false;
  notice.replaceChildren();
  document.title = `${doc.title} · md-reader`;
  const rootInfo = state.roots.find((r) => r.id === root);
  crumb.replaceChildren(`${rootInfo ? rootInfo.name : ''} / `, el('b', { textContent: doc.path }));
  crumb.title = rootInfo ? `${rootInfo.path}/${doc.path}` : doc.path;
  renderOutline(doc.toc);
  markActive();
  store.set('last', state.current);

  const url = docUrl(root, doc.path) + hash;
  if (push) history.pushState(null, '', url);
  else if (!keepScroll) history.replaceState(null, '', url);

  if (keepScroll && sameDoc) desk.scrollTop = top;
  else if (hash && document.getElementById(decodeURIComponent(hash.slice(1)))) {
    document.getElementById(decodeURIComponent(hash.slice(1))).scrollIntoView();
  } else desk.scrollTop = store.get(scrollKey(root, doc.path), 0);
  updateSpy();
  if (!sameDoc || !state.stopWatch) watch(root, doc.path);
}

function watch(root, path) {
  state.stopWatch?.();
  state.stopWatch = backend.watch(root, path, () => {
    if (state.current?.root === root && state.current?.path === path) openDoc(root, path, { keepScroll: true });
  });
}

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
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (state.current) store.set(scrollKey(state.current.root, state.current.path), Math.round(desk.scrollTop));
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

async function printDoc() {
  if (!state.current) return;
  const images = [...sheet.querySelectorAll('img')];
  for (const img of images) img.loading = 'eager';
  const loaded = images
    .filter((img) => !img.complete)
    .map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }));
  await Promise.race([Promise.all(loaded), new Promise((resolve) => setTimeout(resolve, 5000))]);
  window.print();
}
$('mdr-print').addEventListener('click', printDoc);
window.addEventListener('beforeprint', () => {
  for (const img of sheet.querySelectorAll('img')) img.loading = 'eager';
});

// ---------- Full screen ----------
// Full screen with the app unchanged: panels and top bar stay. F, F11 or the button toggles it;
// Esc leaves.

const toggleFullscreen = () => Promise.resolve(backend.toggleFullscreen()).catch(() => {});
$('mdr-fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
  if (event.target.closest?.('input, textarea, select')) return;
  if (event.key === 'f' || event.key === 'F') toggleFullscreen();
  else if (event.key === 'F11' && backend.kind === 'tauri') {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.key === 'Escape') backend.exitFullscreen?.().catch(() => {}); // a browser leaves by itself
});

// ---------- Folder picker ----------

const picker = $('mdr-picker');
const pickerInput = $('mdr-picker-input');
const pickerList = $('mdr-picker-list');
const pickerError = $('mdr-picker-error');
const pickerCount = $('mdr-picker-count');
let pickerDir = null;

const mdCount = (n) => (n === 1 ? '1 .md file' : `${n} .md files`);

async function browseTo(dir) {
  pickerError.textContent = '';
  let listing;
  try {
    listing = await backend.browse(dir);
  } catch (err) {
    pickerError.textContent = err.message;
    return false;
  }
  pickerDir = listing;
  pickerInput.value = listing.dir;
  $('mdr-picker-up').disabled = !listing.parent;
  pickerCount.textContent = `${mdCount(listing.md)} directly in this folder`;
  pickerList.replaceChildren();
  if (!listing.dirs.length) pickerList.append(el('li', { className: 'empty', textContent: 'No sub-folders here.' }));
  for (const d of listing.dirs) {
    const button = el('button', { type: 'button' }, [
      el('span', { textContent: d.name }),
      el('span', { className: 'count', textContent: d.md ? mdCount(d.md) : '' }),
    ]);
    button.addEventListener('click', () => browseTo(d.path));
    pickerList.append(el('li', {}, [button]));
  }
  pickerList.scrollTop = 0;
  return true;
}

// Desktop app: the system's own folder dialog. Browser: the in-page folder browser.
async function openPicker() {
  if (backend.pickFolder) {
    try {
      const path = await backend.pickFolder();
      if (path) await addRoot(path);
    } catch (err) {
      await ask('The folder could not be added', err.message);
    }
    return;
  }
  picker.showModal();
  await browseTo(store.get('picker-dir', null));
  if (!pickerDir) await browseTo(null);
  pickerInput.focus();
}

async function addRoot(path) {
  const root = await backend.addRoot(path);
  await loadRoots();
  if (!state.current) showWelcome();
  return root;
}

async function addFromPicker() {
  const typed = pickerInput.value.trim();
  if (!typed) return;
  try {
    const root = await addRoot(typed);
    store.set('picker-dir', root.path.replace(/\/[^/]*$/, '') || '/');
    picker.close();
  } catch (err) {
    pickerError.textContent = err.message;
  }
}

$('mdr-add').addEventListener('click', openPicker);
$('mdr-picker-cancel').addEventListener('click', () => picker.close());
$('mdr-picker-up').addEventListener('click', () => pickerDir?.parent && browseTo(pickerDir.parent));
$('mdr-picker-go').addEventListener('click', () => browseTo(pickerInput.value.trim()));
$('mdr-picker-add').addEventListener('click', addFromPicker);
$('mdr-picker-form').addEventListener('submit', (event) => event.preventDefault());
pickerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    browseTo(pickerInput.value.trim());
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
  buildSettingsForm();
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

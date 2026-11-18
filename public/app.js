// md-reader front end. Everything that fetches notes goes through backend.js, which is Tauri
// commands in the desktop app and GitHub's API in a browser. Markdown is rendered here.
import { backend } from './backend.js';
import { createRenderer } from './render.js';
import { paginate, currentPage } from './pages.js';
import { icon, setIcon, fillIcons } from './icons.js';
import { isRef } from './github-url.js';
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
// Below these widths a panel lies over the note instead of beside it (see app.css): the list
// of notes on a tablet held upright or a phone, the outline already on a tablet on its side.
const NARROW = window.matchMedia('(max-width: 1000px)');
const OUTLINE_OVER = window.matchMedia('(max-width: 1400px)');
const isNarrow = () => NARROW.matches;
const outlineOverlays = () => OUTLINE_OVER.matches;
const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Full screen (`reading`): the note alone. With pages view it is also `book`: the pages lie
// side by side and are turned sideways. See "Full screen" below.
const isFull = () => app.classList.contains('reading');
const isBook = () => app.classList.contains('book') && sheet.classList.contains('paged');

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
      const actions = el('div', { className: 'root-actions' });
      const action = (name, className, title, run) => {
        const button = el('button', { type: 'button', className: `icon-btn ${className}`, title }, [icon(name)]);
        button.setAttribute('aria-label', title);
        button.addEventListener('click', () => run(button));
        actions.append(button);
      };
      if (hasFolders(root)) action('folders', 'root-folders', `Add or remove folders of ${root.github.repo}`, () => openFolders(root));
      if (root.github) action('refresh', 'root-update', `Update ${root.name} from GitHub`, (button) => updateRoot(root, button));
      action('trash', 'root-remove', `Remove ${root.name} from md-reader (nothing is deleted from where it came from)`, () => removeRoot(root));
      const wrap = el('div', { className: 'root' }, [details, actions]);
      wrap.style.setProperty('--actions', actions.children.length); // room for them on a touch screen
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
// A folder of a repository, on a branch whose name an address can carry: its repository can
// be listed again, to add other folders of it or to remove some.
const hasFolders = (root) => !!root.github && root.kind !== 'file' && isRef(root.github.ref);
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
        if (isNarrow()) showPanel('sidebar', false);
        app.classList.remove('list'); // the list shown over a note in full screen
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
    const add = el('button', { type: 'button', className: 'btn primary', textContent: 'Add notes' });
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
  crumb.replaceChildren(
    el('span', { className: 'crumb-root', textContent: rootInfo && rootInfo.kind !== 'file' ? `${rootInfo.name} / ` : '' }),
    el('b', { textContent: doc.path }),
  );
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
      else if (target) showNode(target);
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
// In book mode it is the first block of the first page on screen.
function readingPlace() {
  const box = desk.getBoundingClientRect();
  const all = places();
  if (isBook()) {
    if (desk.scrollLeft < 4) return null;
    const index = all.findIndex((node) => node.getBoundingClientRect().right > box.left + 1);
    return index < 0 ? null : { index, offset: 0 };
  }
  if (desk.scrollTop < 4) return null;
  const index = all.findIndex((node) => node.getBoundingClientRect().bottom > box.top + 1);
  return index < 0 ? null : { index, offset: Math.round(all[index].getBoundingClientRect().top - box.top) };
}

function showPlace(place) {
  const book = isBook();
  // The desk moves one way only: whatever the other view left behind is undone.
  if (book) desk.scrollTop = 0;
  else desk.scrollLeft = 0;
  if (typeof place === 'number' && !book) desk.scrollTop = place; // stored by an older version
  const node = place && typeof place === 'object' && places()[place.index];
  if (!node) {
    if (!place) desk.scrollTo(0, 0);
    return;
  }
  if (book) return showPageOf(node);
  const box = node.getBoundingClientRect();
  // A long block may have been cut by a page since: never scroll past its own end.
  const offset = Math.max(Number(place.offset) || 0, 24 - box.height);
  desk.scrollTop += box.top - desk.getBoundingClientRect().top - offset;
}

// Book mode: brings the page that holds `node` on screen.
function showPageOf(node) {
  const page = node.closest('.page');
  if (page) desk.scrollLeft += page.getBoundingClientRect().left - desk.getBoundingClientRect().left;
}

const showNode = (node) => (isBook() ? showPageOf(node) : node.scrollIntoView());

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
    if (!img.complete) img.addEventListener('load', () => relayoutSoon(), { once: true });
  }
}

// One layout at a time. `keepPlace` stays at the block being read, `place` goes to one read
// earlier; `after` runs once the note is on the sheet (to scroll). `paged` can be forced
// (printing uses one sheet).
let layoutQueue = Promise.resolve();
function layout({ paged = state.paged, keepPlace = false, place, after } = {}) {
  const task = layoutQueue.then(async () => {
    const at = place !== undefined ? place : keepPlace ? readingPlace() : undefined;
    if (paged && state.html) await showPages();
    else showContinuous();
    if (at !== undefined) showPlace(at);
    after?.();
    lastWidth = sheet.getBoundingClientRect().width;
    updateSpy();
    updatePageInfo();
  });
  layoutQueue = task.catch(() => {});
  return task;
}

const relayout = () => (state.current ? layout({ keepPlace: true }) : Promise.resolve());
// Cuts the pages again in a moment. `ifResized`: only if the sheet still has another width
// than at the last layout (a layout that ran meanwhile has dealt with it).
let relayoutTimer = null;
let relayoutAnyway = false;
function relayoutSoon(ifResized = false) {
  relayoutAnyway ||= !ifResized;
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => {
    const anyway = relayoutAnyway;
    relayoutAnyway = false;
    if (!sheet.classList.contains('paged')) return;
    if (anyway || Math.abs(sheet.getBoundingClientRect().width - lastWidth) >= 1) relayout();
  }, 300);
}

// A narrower or wider sheet (small window, zoom) wraps the text differently: cut the pages again.
// Not in book mode, where the pages have the size of the screen (fit() below sees to it).
let lastWidth = 0;
new ResizeObserver(() => {
  if (!sheet.classList.contains('paged') || isBook()) return;
  if (Math.abs(sheet.getBoundingClientRect().width - lastWidth) >= 1) relayoutSoon(true);
}).observe(sheet);

// Book mode: the page on screen, counted from 0. A page counts once half of it is in.
function shownPage() {
  const box = desk.getBoundingClientRect();
  return currentPage(sheet, box.left + box.width / 2, true) - 1;
}

function updatePageInfo() {
  const info = $('mdr-page-info');
  const total = sheet.classList.contains('paged') ? sheet.children.length : 0;
  info.hidden = !total;
  if (!total) return;
  const short = window.matchMedia('(max-width: 760px)').matches;
  const box = desk.getBoundingClientRect();
  const shown = isBook() ? shownPage() + 1 : currentPage(sheet, box.top + box.height / 2);
  info.textContent = short ? `${shown} / ${total}` : `page ${shown} of ${total}`;
}

function setView(paged) {
  const place = readingPlace();
  state.paged = paged;
  store.set('view', paged ? 'pages' : 'continuous');
  showView();
  fit(); // in full screen, pages view is book mode
  return state.current ? layout({ place }) : Promise.resolve();
}
// The choice sits in the "View, fonts and colours" panel.
function showView() {
  $('mdr-view-continuous').setAttribute('aria-pressed', String(!state.paged));
  $('mdr-view-pages').setAttribute('aria-pressed', String(state.paged));
}
$('mdr-view-continuous').addEventListener('click', () => state.paged && setView(false));
$('mdr-view-pages').addEventListener('click', () => state.paged || setView(true));

// One page further or back. In book mode: the next or the previous page, sideways.
// Otherwise one page down or up, or one screen when a page is taller than the
// window (large zoom), so no part of a page is skipped.
let turning = null; // book mode: where a turn that is still gliding will end
let turnTimer = null;
function turnPage(step) {
  if (isBook()) {
    const pages = [...sheet.children];
    const index = Math.min(Math.max((turning ?? shownPage()) + step, 0), pages.length - 1);
    turning = index;
    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => (turning = null), 500);
    const left = desk.scrollLeft + pages[index].getBoundingClientRect().left - desk.getBoundingClientRect().left;
    desk.scrollTo({ left, behavior: calm() ? 'auto' : 'smooth' });
    return;
  }
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
// Page Up and Page Down in pages view; in book mode also the arrows and the space bar.
document.addEventListener('keydown', (event) => {
  if (!sheet.classList.contains('paged') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (document.querySelector('dialog[open]') || event.target.closest?.('input, textarea, select, button, a')) return;
  const keys = { PageDown: 1, PageUp: -1 };
  if (isBook()) Object.assign(keys, { ArrowRight: 1, ArrowLeft: -1, ' ': event.shiftKey ? -1 : 1 });
  const step = keys[event.key];
  if (!step) return;
  event.preventDefault();
  turnPage(step);
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
  const box = desk.getBoundingClientRect();
  const book = isBook();
  // Passed: above a line near the top of the desk; in book mode, on a page that is on screen
  // or before it.
  const passed = (node) => (book ? node.getBoundingClientRect().left < box.right - 1 : node.getBoundingClientRect().top <= box.top + 60);
  let current = state.headings[0];
  for (const h of state.headings) {
    if (passed(h.target)) current = h;
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
  if (!isFull()) sheet.style.zoom = zoom; // full screen fits the note itself; this one comes back after
  $('mdr-zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
  store.set('zoom', zoom);
  updateSpy();
}
const currentZoom = () => Number(sheet.style.zoom) || 1;
$('mdr-zoom-in').addEventListener('click', () => setZoom(ZOOM_STEPS.find((z) => z > currentZoom() + 0.001) ?? 2));
$('mdr-zoom-out').addEventListener('click', () => setZoom([...ZOOM_STEPS].reverse().find((z) => z < currentZoom() - 0.001) ?? 0.7));
$('mdr-zoom-reset').addEventListener('click', () => setZoom(1));

// The two panels: the list of notes ('sidebar') and the outline. Where a panel lies over the
// note it is only opened for a moment, so that is not remembered as the user's choice.
const overlays = (name) => (name === 'sidebar' ? isNarrow() : outlineOverlays());
const panelShown = (name) => !app.classList.contains(`no-${name}`);
function showPanel(name, shown, keep = !overlays(name)) {
  app.classList.toggle(`no-${name}`, !shown);
  $(`mdr-toggle-${name}`).setAttribute('aria-pressed', String(shown));
  if (keep) store.set(`no-${name}`, !shown);
}
const panelAtStart = (name) => !overlays(name) && !store.get(`no-${name}`, false);
$('mdr-toggle-sidebar').addEventListener('click', () => showPanel('sidebar', !panelShown('sidebar')));
$('mdr-toggle-outline').addEventListener('click', () => showPanel('outline', !panelShown('outline')));
// A panel that lies over the note: a tap on the note puts it away. That tap does nothing
// else: it must not also follow a link or press a button under it.
document.querySelector('.main').addEventListener('click', (event) => {
  if (event.target.closest('#mdr-toggle-sidebar, #mdr-toggle-outline, #mdr-crumb')) return;
  const open = isFull() ? [] : ['sidebar', 'outline'].filter((name) => overlays(name) && panelShown(name));
  if (!open.length && !app.classList.contains('list')) return;
  event.preventDefault();
  event.stopPropagation();
  for (const name of open) showPanel(name, false);
  app.classList.remove('list');
}, true);
// The name of the open note brings the list of notes, to choose another. In full screen the
// list lies over the note (`.list`) until a note is chosen or the note is tapped.
crumb.addEventListener('click', () => {
  if (isFull()) app.classList.toggle('list');
  else showPanel('sidebar', !panelShown('sidebar'));
});
// On a touch screen the outline over the note has done its work once a heading is chosen.
outline.addEventListener('click', (event) => {
  if (event.target.closest('a') && outlineOverlays() && isTouch()) showPanel('outline', false);
});
// The window crosses one of the widths (turned tablet, resized window): a panel that would
// now lie over the note is put away; one that has its own column again is as it was chosen.
NARROW.addEventListener('change', () => showPanel('sidebar', panelAtStart('sidebar'), false));
OUTLINE_OVER.addEventListener('change', () => showPanel('outline', panelAtStart('outline'), false));

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
  showThemeColor();
  updateSpy();
}

// The colour a browser gives its own bars around the page: the shell's, or the paper's in full screen.
function showThemeColor() {
  const style = getComputedStyle(document.documentElement);
  $('mdr-theme-color').content = style.getPropertyValue(isFull() ? '--print-paper' : '--ui-bg').trim();
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
// The note alone: the panels and the top bar are put away, and the window itself goes full
// screen where it can (the desktop app, a browser; an iPhone has no such thing, and there the
// note simply has the whole window). F, F11 or the button toggles it; Esc leaves. A tap or a
// click on the middle of the note shows the top bar over it, and again hides it.
//
// Continuous view stays one sheet, as wide as the window. Pages view becomes a book: every
// page has the size of the screen (always one at a time) and is cut for that size,
// and the pages are turned sideways: swipe, the arrow keys, or a tap near an edge.

const PAGE_WIDTH_PX = 816; // 8.5in: --page-width of the sheet in study.css
let fitKey = 'window';
// Sizes the sheet for where it is shown. Returns whether anything changed.
function fit() {
  const reading = isFull();
  const book = reading && state.paged;
  const width = desk.clientWidth;
  const height = desk.clientHeight;
  let key = 'window';
  let zoom = Math.min(2, Math.max(0.7, Number(store.get('zoom', 1)) || 1));
  if (book) {
    // Never beyond the largest zoom the buttons give, however wide the window: the page then
    // keeps its own margins, so the lines stay a readable length.
    zoom = Math.min(2, Math.max(1, width / PAGE_WIDTH_PX));
    key = `book:${width}:${height}`;
  } else if (reading) {
    zoom = Math.min(2, width / Math.min(PAGE_WIDTH_PX, width));
    key = `sheet:${zoom}`;
  }
  if (key === fitKey) return false;
  fitKey = key;
  app.classList.toggle('book', book);
  sheet.style.zoom = zoom;
  if (book) {
    sheet.style.setProperty('--book-w', `${width / zoom}px`);
    sheet.style.setProperty('--book-h', `${height / zoom}px`);
  } else {
    sheet.style.removeProperty('--book-w');
    sheet.style.removeProperty('--book-h');
  }
  return true;
}
// Fits the sheet and shows `place` again (read before anything changed).
function refit(place = readingPlace()) {
  if (!fit() || !state.current) return;
  if (state.paged) return void layout({ place });
  showPlace(place);
  updateSpy();
}
// The desk changes size when the device is turned, the window resized, or full screen arrives.
let fitTimer = null;
new ResizeObserver(() => {
  updatePageInfo();
  if (!isFull()) return;
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => refit(), 120);
}).observe(desk);

const fullscreenButton = $('mdr-fullscreen');
function setReading(on) {
  if (on === isFull()) return;
  const place = readingPlace();
  app.classList.toggle('reading', on);
  app.classList.remove('chrome', 'list');
  setIcon(fullscreenButton, on ? 'shrink' : 'expand');
  fullscreenButton.setAttribute('aria-pressed', String(on));
  showThemeColor();
  refit(place);
}
let fullscreenBusy = false;
async function toggleFullscreen() {
  if (fullscreenBusy) return;
  fullscreenBusy = true;
  try {
    if (isFull()) {
      setReading(false);
      await backend.setFullscreen(false);
    } else {
      // Asked for first: a browser only grants it straight from the tap or the key.
      await backend.setFullscreen(true).catch(() => false);
      setReading(true);
    }
  } catch {
    /* the window stays as it is; the note has its room either way */
  } finally {
    fullscreenBusy = false;
  }
}
fullscreenButton.addEventListener('click', toggleFullscreen);
// A browser leaves its full screen by itself (Esc, a gesture): the panels come back with it.
for (const name of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(name, () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) setReading(false);
  });
}
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
  if (event.target.closest?.('input, textarea, select')) return;
  if (event.key === 'f' || event.key === 'F') toggleFullscreen();
  else if (event.key === 'F11' && backend.kind === 'tauri') {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.key === 'Escape' && isFull()) toggleFullscreen();
});

// Taps and clicks on the note itself (not on a link, and not the end of selecting text).
// In full screen: the note shows or hides the top bar, at any height; in book mode a strip
// along each side (EDGE of the width) turns the page instead. On a touch screen, outside
// full screen, the middle of the note enters it.
const EDGE = 0.2;
desk.addEventListener('click', (event) => {
  if (event.button !== 0 || event.defaultPrevented || !state.current) return;
  if (event.target.closest('a, button, input, summary') || !window.getSelection().isCollapsed) return;
  const box = desk.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width;
  const y = (event.clientY - box.top) / box.height;
  const middle = x > 1 / 3 && x < 2 / 3 && y > 0.2 && y < 0.8;
  if (!isFull()) {
    if (middle && isTouch()) toggleFullscreen();
  } else if (isBook() && !app.classList.contains('chrome') && (x < EDGE || x > 1 - EDGE)) turnPage(x < EDGE ? -1 : 1);
  else app.classList.toggle('chrome');
});

// ---------- Sources from GitHub ----------

const names = (list) => (list.length > 8 ? `${list.slice(0, 8).join(', ')} and ${list.length - 8} more` : list.join(', '));

// Brings the downloaded copy up to date and says which notes changed.
async function updateRoot(root, button) {
  button.disabled = true;
  const row = button.closest('.root');
  row?.classList.add('busy'); // its buttons stay in view while it runs
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
    row?.classList.remove('busy');
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
  const where = backend.kind === 'web' ? 'in this browser, on this device' : 'in a file only your user can read';
  const state = $('mdr-github-token-state');
  state.textContent = saved
    ? `✓ A token is saved ${where}, and is used for every repository you add. It cannot be read back, only replaced or forgotten.`
    : `No token is saved. Public repositories need none. For private ones, paste a token that may read them (a fine-grained token with read-only "Contents" access to those repositories is enough) and save it once: it is kept ${where}.`;
  state.classList.toggle('ok', saved);
  $('mdr-github-token').placeholder = saved ? 'A new token, to replace the saved one' : 'GitHub token';
  $('mdr-github-token-save').textContent = saved ? 'Replace token' : 'Save token';
  $('mdr-github-token-clear').hidden = !saved;
}

// The dialog has two steps: the address (and the token), then the folders of that repository.
// For a repository that is already in the list it opens at the second step: `have` then maps
// each of its folders that is a source to that source ('' is the whole repository), and
// ticking or unticking adds or removes sources.
const picking = { url: '', picked: new Set(), busy: false, have: null };

function showGithubStep(folders) {
  $('mdr-github-step-address').hidden = folders;
  $('mdr-github-step-folders').hidden = !folders;
  $('mdr-github-back').hidden = !folders || !!picking.have;
  $('mdr-github-add').textContent = folders ? 'Add' : 'Next';
  githubError.textContent = '';
}

// While a listing or a download runs, the dialog can be neither left nor stepped back in.
function setGithubBusy(busy) {
  picking.busy = busy;
  for (const id of ['mdr-github-add', 'mdr-github-back', 'mdr-github-cancel']) $(id).disabled = busy;
  if (!busy) $('mdr-github-busy').textContent = '';
}

async function openGithub() {
  picking.have = null;
  $('mdr-github-title').textContent = 'Add from GitHub';
  showGithubStep(false);
  setGithubBusy(false);
  $('mdr-github-busy').textContent = '';
  $('mdr-github-token').value = '';
  githubDialog.showModal();
  $('mdr-github-url').focus();
  await showTokenState();
}

// Resolves to whether the token in the field is now saved.
async function saveToken() {
  githubError.textContent = '';
  const field = $('mdr-github-token');
  if (!field.value.trim()) {
    githubError.textContent = 'Paste a token into the field first.';
    return false;
  }
  const button = $('mdr-github-token-save');
  button.disabled = true;
  try {
    await backend.saveGithubToken(field.value);
    field.value = '';
    return true;
  } catch (err) {
    githubError.textContent = `The token was not saved. ${err.message}`;
    return false;
  } finally {
    button.disabled = false;
    await showTokenState();
  }
}

const noteCount = (n) => (n === 1 ? '1 note' : `${n} notes`);
// The folders that are ticked, without those inside another ticked one. '' is the whole repository.
function chosenFolders() {
  if (picking.picked.has('')) return [''];
  return [...picking.picked].filter((path) => ![...picking.picked].some((other) => other !== path && path.startsWith(`${other}/`)));
}

const covers = (parent, path) => parent !== path && (parent === '' || path.startsWith(`${parent}/`));
// For a repository already in the list: the folders to download and the ones to take out. A
// folder that is a source goes when it is unticked, or when a folder around it is newly added.
function folderChanges() {
  const have = picking.have || new Map();
  const add = chosenFolders().filter((path) => !have.has(path));
  const remove = [...have.keys()].filter((path) => !picking.picked.has(path) || add.some((parent) => covers(parent, path)));
  return { add, remove };
}
const folderName = (path) => path || 'the whole repository';
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A folder inside a ticked one is shown ticked and cannot be changed: it comes with its parent.
function syncFolderChoices() {
  const chosen = chosenFolders();
  for (const box of $('mdr-github-folders').querySelectorAll('input')) {
    const covered = chosen.some((path) => covers(path, box.value));
    box.checked = covered || picking.picked.has(box.value);
    box.disabled = covered;
  }
  const button = $('mdr-github-add');
  if (picking.have) {
    const { add, remove } = folderChanges();
    button.textContent =
      add.length && remove.length ? `Add ${add.length}, remove ${remove.length}`
      : add.length ? `Add ${count(add.length, 'folder')}`
      : remove.length ? `Remove ${count(remove.length, 'folder')}`
      : 'No change';
    button.disabled = !add.length && !remove.length;
    return;
  }
  button.textContent = chosen.length > 1 ? `Add ${chosen.length} folders` : 'Add';
  button.disabled = chosen.length === 0;
}

function showFolders(listing) {
  const have = picking.have;
  picking.picked = new Set(have ? have.keys() : []);
  $('mdr-github-repo').textContent =
    (have
      ? `${listing.repo}, branch ${listing.ref}. The ticked folders are in your list. Tick another to add it, untick one to remove it.`
      : `${listing.repo} · ${listing.ref}. Tick what to add; each ticked folder becomes its own source, with its sub-folders.`) +
    (listing.truncated ? ' The repository is large: not every folder is listed, and the counts may be too low.' : '');
  const listed = [{ path: '', count: listing.total }, ...listing.folders];
  // A folder in the list that GitHub no longer shows can still be removed here.
  const gone = have ? [...have.keys()].filter((path) => !listed.some((row) => row.path === path)) : [];
  const rows = [...listed, ...gone.map((path) => ({ path, count: null }))].map(({ path, count: notes }) => {
    const item = el('li', { className: have?.has(path) ? 'have' : '' });
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.value = path;
    box.addEventListener('change', () => {
      if (box.checked) picking.picked.add(path);
      else picking.picked.delete(path);
      syncFolderChoices();
    });
    const depth = path ? path.split('/').length : 0;
    label.style.paddingLeft = `${8 + depth * 18}px`;
    label.title = path || listing.repo;
    const text = notes === null ? 'not on GitHub any more' : noteCount(notes);
    label.append(
      box,
      el('span', { className: 'folder-name', textContent: path ? path.slice(path.lastIndexOf('/') + 1) : 'Whole repository' }),
      el('span', { className: 'folder-count', textContent: have?.has(path) ? `in your list, ${text}` : text }),
    );
    item.append(label);
    return item;
  });
  $('mdr-github-folders').replaceChildren(...rows);
  showGithubStep(true);
  syncFolderChoices();
}

// The folders of a repository that is already in the list, to add others or remove some.
async function openFolders(root) {
  const { repo, ref } = root.github;
  picking.url = `https://github.com/${repo}/tree/${ref}`;
  picking.have = new Map(
    state.roots.filter((r) => hasFolders(r) && r.github.repo === repo && r.github.ref === ref).map((r) => [r.github.sub || '', r]),
  );
  picking.picked = new Set(picking.have.keys());
  $('mdr-github-title').textContent = `Folders of ${repo}`;
  $('mdr-github-repo').textContent = '';
  $('mdr-github-folders').replaceChildren();
  showGithubStep(true);
  githubDialog.showModal();
  setGithubBusy(true);
  $('mdr-github-busy').textContent = 'Reading the repository…';
  try {
    showFolders(await backend.githubFolders(picking.url));
  } catch (err) {
    githubError.textContent = err.message;
  } finally {
    setGithubBusy(false);
    syncFolderChoices();
  }
}

async function addGithub() {
  if (picking.busy || $('mdr-github-add').disabled) return;
  const folders = !$('mdr-github-step-folders').hidden;
  const url = folders ? picking.url : $('mdr-github-url').value.trim();
  if (!url) {
    githubError.textContent = 'Paste the address of a repository first.';
    return;
  }
  githubError.textContent = '';
  if (!folders && $('mdr-github-token').value.trim() && !(await saveToken())) return; // a pasted token is meant to be used
  const have = folders ? picking.have : null;
  const gone = have ? folderChanges().remove : [];
  if (gone.length) {
    const yes = await ask(
      gone.length === 1 ? `Remove "${folderName(gone[0])}" from md-reader?` : `Remove ${gone.length} folders from md-reader?`,
      `${gone.length > 1 ? `${names(gone.map(folderName))}. ` : ''}${backend.kind === 'web' ? '' : 'The downloaded copy is deleted. '}The repository on GitHub is not touched.`,
      'Remove',
    );
    if (!yes) return;
  }
  setGithubBusy(true);
  const busy = $('mdr-github-busy');
  const added = [];
  let removed = 0;
  try {
    let subs = !folders ? null : have ? folderChanges().add : chosenFolders();
    if (!subs) {
      busy.textContent = 'Reading the repository…';
      const listing = await backend.githubFolders(url);
      if (listing.direct || !listing.folders.length) {
        if (!listing.direct && !listing.total) throw new Error('That repository has no .md files.');
        subs = [''];
      } else {
        picking.url = url;
        showFolders(listing);
        return;
      }
    }
    for (const [i, sub] of subs.entries()) {
      busy.textContent = subs.length > 1 ? `Downloading ${sub} (${i + 1} of ${subs.length})…` : 'Downloading…';
      const root = await backend.addGithub(url, sub);
      added.push(root);
      // Not added a second time if a later one fails.
      if (have) have.set(sub, root);
      else picking.picked.delete(sub);
    }
    // Removed only once everything new is there.
    for (const sub of gone) {
      busy.textContent = `Removing ${folderName(sub)}…`;
      const root = have.get(sub);
      await backend.removeRoot(root.id);
      have.delete(sub);
      removed += 1;
      if (state.current?.root === root.id) {
        closeDoc();
        history.replaceState(null, '', location.pathname);
      }
    }
    $('mdr-github-url').value = '';
    githubDialog.close();
  } catch (err) {
    const done = [added.length && `${added.length} added`, removed && `${removed} removed`].filter(Boolean).join(', ');
    githubError.textContent = done ? `${done}, then: ${err.message}` : err.message;
  } finally {
    setGithubBusy(false);
    if (!$('mdr-github-step-folders').hidden) syncFolderChoices();
  }
  if (!added.length && !removed) return;
  await loadRoots();
  if (!githubDialog.open && added.length === 1 && added[0].kind === 'file') await openDoc(added[0].id, added[0].name, { push: true }).catch(() => {});
  else if (!state.current) showWelcome();
}

$('mdr-github-form').addEventListener('submit', (event) => {
  event.preventDefault();
  addGithub();
});
$('mdr-github-cancel').addEventListener('click', () => githubDialog.close());
// Esc does not close the dialog in the middle of a download.
githubDialog.addEventListener('cancel', (event) => {
  if (picking.busy) event.preventDefault();
});
$('mdr-github-back').addEventListener('click', () => {
  showGithubStep(false);
  $('mdr-github-add').disabled = false;
  $('mdr-github-url').focus();
});
$('mdr-github-token-save').addEventListener('click', saveToken);
$('mdr-github-token-clear').addEventListener('click', async () => {
  githubError.textContent = '';
  await backend.clearGithubToken().catch(() => {});
  await showTokenState();
});

// ---------- Adding a source ----------

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

// Desktop app only: the system's own dialog.
async function pickLocal(file) {
  try {
    const path = await (file ? backend.pickFile() : backend.pickFolder());
    if (path) await addLocal(path, file);
  } catch (err) {
    await ask(file ? 'The file could not be added' : 'The folder could not be added', err.message);
  }
}
async function addLocal(path, file) {
  const root = await (file ? backend.addFile(path) : backend.addRoot(path));
  await loadRoots();
  // The source is in the list from here on: a note that then fails to open says so itself.
  if (file) await openDoc(root.id, root.name, { push: true }).catch(() => {});
  else if (!state.current) showWelcome();
  return root;
}

$('mdr-add').addEventListener('click', () => $('mdr-sources').showModal());
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
  fillIcons();
  showPanel('sidebar', panelAtStart('sidebar'), false);
  showPanel('outline', panelAtStart('outline'), false);
  setZoom(store.get('zoom', 1));
  state.paged = store.get('view', 'continuous') === 'pages';
  showView();
  buildSettingsForm();
  buildSourceChoices();
  await loadSettings();
  try {
    await loadRoots();
  } catch (err) {
    showNotice('md-reader could not load the list of sources', err.message, { error: true });
    return;
  }
  const target = fromLocation() || store.get('last', null);
  if (target && state.roots.some((r) => r.id === target.root)) await openDoc(target.root, target.path, target);
  else showWelcome();
}

start();

// md-reader front end. Talks to the server only through /api/* and /asset, so a desktop shell
// can replace the server later without changing this file's structure.
const $ = (id) => document.getElementById(id);
const app = $('mdr-app');
const rootsEl = $('mdr-roots');
const desk = $('mdr-desk');
const sheet = $('mdr-sheet');
const notice = $('mdr-notice');
const outline = $('mdr-outline');
const crumb = $('mdr-crumb');

const state = { roots: [], current: null, events: null, headings: [] };

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

async function api(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const shortPath = (p) => p.replace(/^\/home\/[^/]+/, '~');

// ---------- Folder list ----------

async function loadRoots() {
  state.roots = (await api('/api/roots')).roots;
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
        const tree = await api(`/api/tree?root=${encodeURIComponent(root.id)}`);
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
  if (!confirm(`Remove "${root.name}" from md-reader?\n\nThe folder and its files stay on disk.`)) return;
  try {
    await api(`/api/roots/${encodeURIComponent(root.id)}`, { method: 'DELETE' });
  } catch (err) {
    alert(err.message);
    return;
  }
  if (state.current?.root === root.id) {
    closeDoc();
    history.replaceState(null, '', '/');
  }
  await loadRoots();
  if (!state.current) showWelcome();
}

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
  state.events?.close();
  state.events = null;
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
    doc = await api(`/api/doc?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  } catch (err) {
    if (keepScroll) return; // a failed live reload leaves the note on screen
    closeDoc();
    showNotice('This note cannot be opened', err.message, { error: true });
    return;
  }
  const sameDoc = state.current?.root === root && state.current?.path === doc.path;
  const top = desk.scrollTop;
  state.current = { root, path: doc.path };

  // The HTML comes from the server's Markdown renderer, which does not pass raw HTML through.
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

  const url = `/?root=${encodeURIComponent(root)}&path=${encodeURIComponent(doc.path)}${hash}`;
  if (push) history.pushState(null, '', url);
  else if (!keepScroll) history.replaceState(null, '', url);

  if (keepScroll && sameDoc) desk.scrollTop = top;
  else if (hash && document.getElementById(decodeURIComponent(hash.slice(1)))) {
    document.getElementById(decodeURIComponent(hash.slice(1))).scrollIntoView();
  } else desk.scrollTop = store.get(scrollKey(root, doc.path), 0);
  updateSpy();
  if (!sameDoc || !state.events) watch(root, doc.path);
}

function watch(root, path) {
  state.events?.close();
  const events = new EventSource(`/api/watch?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  events.onmessage = () => {
    if (state.current?.root === root && state.current?.path === path) openDoc(root, path, { keepScroll: true });
  };
  state.events = events;
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

// Links between notes open in place instead of reloading the app.
sheet.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-doc]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  openDoc(state.current.root, link.dataset.doc, { push: true, hash: new URL(link.href).hash });
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

// ---------- Full screen ----------
// Real browser full screen with the app unchanged: panels and top bar stay. F or the button
// toggles it; Esc leaves (the browser handles that).

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
$('mdr-fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
  if (event.target.closest?.('input, textarea, select')) return;
  if (event.key === 'f' || event.key === 'F') toggleFullscreen();
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
    listing = await api(`/api/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
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

async function openPicker() {
  picker.showModal();
  await browseTo(store.get('picker-dir', null));
  if (!pickerDir) await browseTo(null);
  pickerInput.focus();
}

async function addFromPicker() {
  const typed = pickerInput.value.trim();
  if (!typed) return;
  try {
    const { root } = await api('/api/roots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: typed }),
    });
    store.set('picker-dir', root.path.replace(/\/[^/]*$/, '') || '/');
    picker.close();
    await loadRoots();
    if (!state.current) showWelcome();
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

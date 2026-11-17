// The hosted version (a static site, installable as a PWA): there is no server and no disk.
// Every source is a GitHub repository, a folder in one or a single .md file, read through
// GitHub's own API. The same rules as the local versions hold: only .md files are listed and
// opened, only images are fetched besides, and a path never leaves the source that was added.
//
// What is kept, all of it in this browser on this device: the list of sources and the settings
// (localStorage), the notes already opened (service worker cache, for reading offline), and the
// GitHub token for private repositories (its own cache entry, which sw.js also reads so it can
// fetch private images). The token is sent to api.github.com only.
import { parseGithubUrl } from './github-url.js';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const DOC = /\.md$/i;
const IMAGE = /\.(svg|png|jpe?g|gif|webp)$/i;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5000;
const SKIP = (segment) => segment.startsWith('.') || segment === 'node_modules';

const local = {
  get(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(`mdr:web:${key}`));
      return value ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`mdr:web:${key}`, JSON.stringify(value));
    } catch {
      /* storage full or blocked: the app still works for this visit */
    }
  },
};

const encPath = (path) => path.split('/').map(encodeURIComponent).join('/');
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path) => path.slice(path.lastIndexOf('/') + 1);

// ---------- The token ----------

const TOKEN_CACHE = 'mdr-private';
const tokenUrl = () => new URL('__token', location.href).href;
const NOTES_CACHE = 'mdr-notes-v1'; // filled by sw.js
let tokenSaved = false; // known without waiting, for assetUrl()
let tokenKnown; // undefined until read once; then the token or null

function privateStore() {
  if (typeof caches === 'undefined') throw new Error('A token can be saved only when the page is served over https.');
  return caches.open(TOKEN_CACHE);
}

// Forgets notes and images kept for offline reading: all of them, or those of one repository.
async function forgetKept(repo) {
  try {
    if (!repo) return void (await caches.delete(NOTES_CACHE));
    const cache = await caches.open(NOTES_CACHE);
    for (const request of await cache.keys()) {
      if (request.url.includes(`/${repo}/`)) await cache.delete(request);
    }
  } catch {
    /* nothing was kept */
  }
}

async function readToken() {
  if (tokenKnown !== undefined) return tokenKnown;
  try {
    const hit = await (await caches.open(TOKEN_CACHE)).match(tokenUrl());
    const token = hit ? (await hit.text()).trim() : '';
    tokenSaved = TOKEN.test(token);
    tokenKnown = tokenSaved ? token : null;
  } catch {
    tokenKnown = null;
  }
  return tokenKnown;
}

// ---------- Talking to GitHub ----------

async function request(url, headers) {
  let res;
  try {
    // Always asked again: an update must not be answered from the browser's own cache.
    res = await fetch(url, { headers, cache: 'no-cache' });
  } catch {
    throw new Error('GitHub could not be reached, and this was not opened before on this device.');
  }
  if (res.ok) return res;
  const hadToken = 'Authorization' in headers;
  if (res.status === 401) throw new Error('GitHub refused the saved token. Save a new one.');
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error(hadToken ? 'GitHub\'s request limit was reached. Try again later.' : 'GitHub\'s limit for requests without a token was reached. Try again in an hour, or save a token.');
  }
  if (res.status === 404 || res.status === 403) {
    throw new Error(hadToken ? 'Not found on GitHub. Check the address, and that the saved token may read it.' : 'Not found on GitHub. If the repository is private, save a GitHub token first.');
  }
  throw new Error(`GitHub answered with an error (${res.status}).`);
}

async function api(path, raw = false) {
  const token = await readToken();
  return request(`${API}${path}`, {
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
}

// ---------- Sources ----------

// Read again before every use: another tab or the installed app may have changed the list.
let sources = [];
const load = () => {
  sources = local.get('sources', []).filter((s) => s && typeof s.id === 'string' && typeof s.repo === 'string');
};
const save = () => local.set('sources', sources);
load();

function find(id) {
  load();
  const source = sources.find((s) => s.id === id);
  if (!source) throw new Error('Unknown folder.');
  return source;
}

function sourceId(source) {
  let hash = 0x811c9dc5;
  for (const ch of `${source.repo}\n${source.ref}\n${source.sub}\n${source.kind}`) {
    hash = Math.imul(hash ^ ch.codePointAt(0), 0x01000193) >>> 0;
  }
  return `w${hash.toString(16).padStart(8, '0')}`;
}

// The guard of this back end: (source, relative path) -> path in the repository, or an error.
// The path is taken apart by hand, so "..", empty and odd segments never reach a URL.
function resolveInside(source, rel, pattern) {
  if (typeof rel !== 'string' || !rel || !pattern.test(rel)) throw new Error('This file type cannot be opened.');
  const parts = [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Path is outside the folder.');
      parts.pop();
    } else if (/[\\\0-\x1f]/.test(part)) throw new Error('Path is outside the folder.');
    else parts.push(part);
  }
  const inside = parts.join('/');
  if (!inside || !pattern.test(inside)) throw new Error('This file type cannot be opened.');
  const base = source.kind === 'file' ? dirOf(source.sub) : source.sub;
  // A file at the top of a repository does not open the whole repository's images: only those
  // beside it (the local versions download no more than that either).
  if (source.kind === 'file' && !base && inside.includes('/')) throw new Error('Path is outside the folder.');
  const full = base ? `${base}/${inside}` : inside;
  if (source.kind === 'file' && DOC.test(full) && full !== source.sub) throw new Error('Only the file that was added can be opened.');
  return { full, rel: inside };
}

const TOO_LARGE = 'This repository is too large for GitHub to list in one answer. Use the desktop app for it.';

// The .md files of a source, as { "path inside the source": "git sha" }.
async function fetchFiles(source) {
  const data = await (await api(`/repos/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`)).json();
  const entries = Array.isArray(data.tree) ? data.tree : [];
  if (source.kind === 'file') {
    const entry = entries.find((e) => e.type === 'blob' && e.path === source.sub);
    if (!entry) throw new Error(data.truncated ? TOO_LARGE : 'That file was not found in the repository.');
    return { files: { [baseOf(source.sub)]: entry.sha }, truncated: false };
  }
  if (source.sub && !entries.some((e) => e.type === 'tree' && e.path === source.sub)) {
    throw new Error(data.truncated ? TOO_LARGE : 'That folder was not found in the repository.');
  }
  const prefix = source.sub ? `${source.sub}/` : '';
  const files = {};
  let count = 0;
  for (const entry of entries) {
    if (entry.type !== 'blob' || !DOC.test(entry.path) || !entry.path.startsWith(prefix)) continue;
    const rel = entry.path.slice(prefix.length);
    if (rel.split('/').some(SKIP)) continue;
    if (++count > MAX_FILES) break;
    files[rel] = entry.sha;
  }
  return { files, truncated: !!data.truncated || count > MAX_FILES };
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function nodes(paths) {
  const top = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let at = top;
    parts.slice(0, -1).forEach((name, i) => {
      if (!at.dirs.has(name)) at.dirs.set(name, { name, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
      at = at.dirs.get(name);
    });
    at.files.push({ type: 'file', name: parts.at(-1), path });
  }
  const build = (dir) => [
    ...[...dir.dirs.values()].sort(byName).map((d) => ({ type: 'dir', name: d.name, path: d.path, children: build(d) })),
    ...dir.files.sort(byName),
  ];
  return build(top);
}

const info = (s) => ({
  id: s.id,
  path: `github.com/${s.repo}`,
  name: s.sub ? baseOf(s.sub) : baseOf(s.repo),
  kind: s.kind,
  github: { repo: s.repo, ref: s.ref, sub: s.sub },
  missing: false,
});

// ---------- Becoming an installable, offline-capable app ----------

// The page's own rules, set here because a static host sends no headers: scripts and styles
// only from the app itself, connections only to GitHub.
function restrictPage() {
  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; " +
    `connect-src 'self' ${API} ${RAW}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'`;
  document.head.prepend(meta);
  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = 'manifest.webmanifest';
  document.head.append(manifest);
}

// Resolves once the service worker serves this page (it fetches private images), or after a
// short wait where there is none.
function startWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
    setTimeout(resolve, 3000);
  });
}

export function webBackend() {
  restrictPage();
  const ready = Promise.all([startWorker(), readToken()]);
  return {
    kind: 'web',
    async listRoots() {
      await ready;
      load();
      return sources.map(info);
    },
    async addGithub(url) {
      const spec = parseGithubUrl(url);
      const repo = `${spec.owner}/${spec.repo}`;
      const ref = spec.ref || (await (await api(`/repos/${repo}`)).json()).default_branch;
      if (typeof ref !== 'string' || !ref) throw new Error('The repository has no branch to read.');
      const source = { repo, ref, sub: spec.sub, kind: spec.kind };
      source.id = sourceId(source);
      Object.assign(source, await fetchFiles(source));
      load();
      sources = [...sources.filter((s) => s.id !== source.id), source];
      save();
      return info(source);
    },
    // Reads the list of notes again and says what is new, changed or gone.
    async updateGithub(id) {
      const source = find(id);
      const before = source.files || {};
      const { files, truncated } = await fetchFiles(source);
      const result = {
        added: Object.keys(files).filter((p) => !(p in before)),
        changed: Object.keys(files).filter((p) => p in before && before[p] !== files[p]),
        removed: Object.keys(before).filter((p) => !(p in files)),
      };
      Object.assign(source, { files, truncated });
      save();
      return result;
    },
    githubToken: async () => (await readToken()) !== null,
    async saveGithubToken(token) {
      if (typeof token !== 'string' || !TOKEN.test(token.trim())) throw new Error('That does not look like a GitHub token.');
      await (await privateStore()).put(tokenUrl(), new Response(token.trim()));
      tokenSaved = true;
      tokenKnown = token.trim();
    },
    async clearGithubToken() {
      await (await privateStore()).delete(tokenUrl());
      tokenSaved = false;
      tokenKnown = null;
      await forgetKept(); // what was read with the token does not stay behind
    },
    async removeRoot(id) {
      const { repo } = find(id);
      sources = sources.filter((s) => s.id !== id);
      save();
      if (!sources.some((s) => s.repo === repo)) await forgetKept(repo);
    },
    async tree(id) {
      const source = find(id);
      return { nodes: nodes(Object.keys(source.files || {})), truncated: !!source.truncated };
    },
    async readDoc(id, path) {
      const source = find(id);
      const { full, rel } = resolveInside(source, path, DOC);
      const token = await readToken();
      // Without a token the file comes from GitHub's file host, which has no hourly limit.
      const res = token
        ? await api(`/repos/${source.repo}/contents/${encPath(full)}?ref=${encodeURIComponent(source.ref)}`, true)
        : await request(`${RAW}/${source.repo}/${encPath(source.ref)}/${encPath(full)}`, {});
      const text = await res.text();
      if (text.length > MAX_DOC_BYTES) throw new Error('This file is too large to display.');
      return { path: rel, source: text };
    },
    // An image linked from a note. Public: straight from GitHub's file host. With a token: a
    // local address that sw.js answers by fetching the image with the token.
    assetUrl(id, path) {
      try {
        const source = find(id);
        const { full } = resolveInside(source, path, IMAGE);
        // The local address needs the service worker; without it only public images load.
        if (!tokenSaved || !navigator.serviceWorker?.controller) return `${RAW}/${source.repo}/${encPath(source.ref)}/${encPath(full)}`;
        return `gh-asset?repo=${encodeURIComponent(source.repo)}&ref=${encodeURIComponent(source.ref)}&path=${encodeURIComponent(full)}`;
      } catch {
        return 'data:,';
      }
    },
    watch: () => () => {}, // nothing changes under a hosted page; "Update" asks GitHub again
    getSettings: async () => local.get('settings', {}),
    saveSettings: async (settings) => local.set('settings', settings),
    async toggleFullscreen() {
      if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
      else await document.documentElement.requestFullscreen?.().catch(() => {});
    },
  };
}

// For the tests: the guard and the tree builder, which need no browser.
export const internals = { resolveInside, nodes, sourceId };

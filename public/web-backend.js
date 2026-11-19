// The hosted version (a static site, installable as a PWA): there is no server and no disk.
// Every source is a GitHub repository, a folder in one or a single .md file, read through
// GitHub's own API. The same rules as the local versions hold: only .md files are listed and
// opened, only images are fetched besides, and a path never leaves the source that was added.
// A submodule inside a source is read too: its files are listed where the repository has them,
// and a path inside it is read from the submodule's own repository, at the commit that the
// repository names (`mounts` of a source).
//
// What is kept, all of it in this browser on this device: the list of sources and the settings
// (localStorage), the notes already opened (service worker cache, for reading offline), and the
// GitHub token for private repositories (its own cache entry, which sw.js also reads so it can
// fetch private images). The token is sent to api.github.com only.
import { isFolderPath, parseGithubUrl, parseGitmodules, submoduleRepo } from './github-url.js';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const DOC = /\.md$/i;
const IMAGE = /\.(svg|png|jpe?g|gif|webp)$/i;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_SUBMODULES = 30;
const MAX_SUBMODULE_DEPTH = 5;
const REPO_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
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
    const message = hadToken ? 'Not found on GitHub. Check the address, and that the saved token may read it.' : 'Not found on GitHub. If the repository is private, save a GitHub token first.';
    throw Object.assign(new Error(message), { notFound: true }); // a submodule like this is left out
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

// True when a submodule at `path` belongs to a source that is the folder `scope` ('' is the
// whole repository): it is that folder, lies inside it, or holds it.
const inScope = (path, scope) => scope === '' || path === scope || path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`);

const isMount = (m) => !!m && typeof m.path === 'string' && isFolderPath(m.path) && REPO_NAME.test(m.repo) && COMMIT.test(m.ref);

// Where a path of the source's repository is read from: the repository itself, or, below a
// submodule, the submodule's repository at the commit that is named (the deepest one wins).
function locate(source, full) {
  let mount = null;
  for (const m of Array.isArray(source.mounts) ? source.mounts : []) {
    if (isMount(m) && full.startsWith(`${m.path}/`) && (!mount || m.path.length > mount.path.length)) mount = m;
  }
  return mount ? { repo: mount.repo, ref: mount.ref, path: full.slice(mount.path.length + 1) } : { repo: source.repo, ref: source.ref, path: full };
}

// The guard of this back end: (source, relative path) -> path in the repository, or an error.
// The path is taken apart by hand, so "..", empty and odd segments never reach a URL. `full`
// is the path in the source's repository; `repo`, `ref` and `path` say where it is read from.
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
  return { full, rel: inside, ...locate(source, full) };
}

const TOO_LARGE = 'This repository is too large for GitHub to list in one answer. Use the desktop app for it.';

// All files of a repository at a branch, with those of the submodules inside the folder
// `scope` listed where the repository has them ('' reads every submodule, null none):
// { entries: [{ path, type, sha }], mounts: [{ path, repo, ref }], skipped: [path], truncated }.
// A submodule is left out, and named in `skipped`, when its address is not a GitHub repository,
// when GitHub does not show it (private, gone), or beyond the limits. Any other failure fails
// the whole reading, so a list is never quietly short.
async function readAll(repo, ref, scope) {
  const all = { entries: [], mounts: [], skipped: [], truncated: false };
  let taken = 0;
  // A repository that is a submodule in two places is asked for once.
  const asked = new Map();
  const once = (key, ask) => asked.get(key) || asked.set(key, ask()).get(key);
  const walk = async (prefix, at, rev, depth) => {
    const data = await once(`tree ${at} ${rev}`, async () => (await api(`/repos/${at}/git/trees/${encodeURIComponent(rev)}?recursive=1`)).json());
    const tree = Array.isArray(data.tree) ? data.tree.filter((e) => e && typeof e.path === 'string') : [];
    all.truncated ||= !!data.truncated;
    for (const e of tree) if (e.type !== 'commit') all.entries.push({ path: prefix + e.path, type: e.type, sha: e.sha });
    const links = tree
      .filter((e) => e.type === 'commit')
      .map((e) => ({ name: e.path, path: prefix + e.path, sha: e.sha }))
      .filter((link) => scope !== null && !link.path.split('/').some(SKIP) && inScope(link.path, scope));
    if (!links.length) return;
    const listed = tree.some((e) => e.path === '.gitmodules' && e.type === 'blob');
    // A .gitmodules that cannot be read leaves the submodules out, not the repository itself.
    const text = listed ? await once(`text ${at} ${rev}`, () => readText(at, rev, '.gitmodules')).catch((err) => (err.notFound ? '' : Promise.reject(err))) : '';
    const addresses = parseGitmodules(text);
    for (const link of links) {
      const sub = submoduleRepo(at, addresses.get(link.name));
      if (!sub || !isFolderPath(link.path) || !COMMIT.test(link.sha) || depth >= MAX_SUBMODULE_DEPTH || taken >= MAX_SUBMODULES) {
        all.skipped.push(link.path);
        continue;
      }
      taken++;
      try {
        await walk(`${link.path}/`, sub, link.sha, depth + 1);
      } catch (err) {
        if (!err.notFound) throw err;
        all.skipped.push(link.path);
        continue;
      }
      all.entries.push({ path: link.path, type: 'tree' });
      all.mounts.push({ path: link.path, repo: sub, ref: link.sha });
    }
  };
  await walk('', repo, ref, 0);
  return all;
}

// The text of one file. Without a token it comes from GitHub's file host, which has no hourly limit.
async function readText(repo, ref, path) {
  const res = (await readToken())
    ? await api(`/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`, true)
    : await request(`${RAW}/${repo}/${encPath(ref)}/${encPath(path)}`, {});
  return res.text();
}

// readAll(), with the last answer kept for a minute, so choosing folders and then adding them
// asks GitHub once (requests without a token are few). An answer that holds every submodule
// serves any folder.
let recent = null;
async function fetchAll(repo, ref, scope, reuse = false, byDefault = false) {
  const fits = recent && recent.repo === repo && recent.ref === ref && (recent.scope === '' || recent.scope === scope);
  if (reuse && fits && Date.now() - recent.at < 60000) return recent.data;
  const data = await readAll(repo, ref, scope);
  const kept = { repo, ref, scope, data, byDefault, at: Date.now() };
  recent = kept;
  setTimeout(() => {
    if (recent === kept) recent = null; // a large list is not held for longer than it is of use
  }, 60000).unref?.();
  return data;
}

async function branchOf(spec, repo) {
  if (spec.ref) return spec.ref;
  if (recent && recent.repo === repo && recent.byDefault && Date.now() - recent.at < 60000) return recent.ref;
  const ref = (await (await api(`/repos/${repo}`)).json()).default_branch;
  if (typeof ref !== 'string' || !ref) throw new Error('The repository has no branch to read.');
  return ref;
}

const MAX_FOLDERS = 1000;

// Counts the notes below every folder, from the paths of all files in a repository. Hidden
// folders and node_modules are left out, as in the list of notes.
function folderCounts(paths) {
  const counts = new Map();
  let total = 0;
  for (const path of paths) {
    const parts = path.split('/');
    if (!DOC.test(path) || parts.some(SKIP)) continue;
    total++;
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      if (!isFolderPath(dir)) break;
      counts.set(dir, (counts.get(dir) || 0) + 1);
    }
  }
  const order = (a, b) => {
    const [x, y] = [a.path.split('/'), b.path.split('/')];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const by = x[i].localeCompare(y[i], undefined, { numeric: true, sensitivity: 'base' }) || (x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0);
      if (by) return by;
    }
    return x.length - y.length;
  };
  const folders = [...counts].map(([path, count]) => ({ path, count })).sort(order);
  return { total, folders: folders.slice(0, MAX_FOLDERS), truncated: folders.length > MAX_FOLDERS };
}

// The .md files of a source, as { "path inside the source": "git sha" }, with the submodules
// that hold some of them (`mounts`) and those that could not be read (`skipped`).
async function fetchFiles(source, reuse = false) {
  const scope = source.kind === 'file' ? null : source.sub;
  const data = await fetchAll(source.repo, source.ref, scope, reuse);
  const entries = data.entries;
  if (source.kind === 'file') {
    const entry = entries.find((e) => e.type === 'blob' && e.path === source.sub);
    if (!entry) throw new Error(data.truncated ? TOO_LARGE : 'That file was not found in the repository.');
    return { files: { [baseOf(source.sub)]: entry.sha }, truncated: false, mounts: [], skipped: [] };
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
  return {
    files,
    truncated: data.truncated || count > MAX_FILES,
    mounts: data.mounts.filter((m) => inScope(m.path, source.sub)),
    skipped: data.skipped.filter((path) => inScope(path, source.sub)),
  };
}

// The repositories a source reads from: its own and those of its submodules.
const reposOf = (source) => [source.repo, ...(Array.isArray(source.mounts) ? source.mounts : []).filter(isMount).map((m) => m.repo)];

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

// Full screen of the browser itself. Resolves to whether the page is in full screen afterwards
// (an iPhone has none for pages, and it stays false). Older iPad systems know it only under its
// `webkit` name, where the call returns nothing and the change comes a moment later, so that is
// waited for.
export async function setBrowserFullscreen(on) {
  const root = document.documentElement;
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const was = isFull();
  if (was === !!on) return was;
  const call = was ? document.exitFullscreen || document.webkitExitFullscreen : root.requestFullscreen || root.webkitRequestFullscreen;
  if (!call) return was;
  try {
    await call.call(was ? document : root);
  } catch {
    return isFull();
  }
  for (let i = 0; i < 10 && isFull() === was; i++) await new Promise((done) => setTimeout(done, 50));
  return isFull();
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
    // The folders of a repository that hold notes, to choose from. `direct` means the address
    // already names one folder or one file.
    async githubFolders(url) {
      const spec = parseGithubUrl(url);
      const repo = `${spec.owner}/${spec.repo}`;
      if (spec.sub || spec.kind === 'file') return { direct: true, repo, ref: spec.ref, total: 0, folders: [], truncated: false, skipped: [] };
      const ref = await branchOf(spec, repo);
      const data = await fetchAll(repo, ref, '', false, !spec.ref);
      const counted = folderCounts(data.entries.filter((e) => e.type === 'blob').map((e) => e.path));
      return { direct: false, repo, ref, ...counted, truncated: counted.truncated || data.truncated, skipped: data.skipped };
    },
    // `sub` narrows the address of a whole repository to one folder chosen from githubFolders().
    async addGithub(url, sub = '') {
      const spec = parseGithubUrl(url);
      if (sub) {
        if (spec.sub || spec.kind !== 'folder' || !isFolderPath(sub)) throw new Error('That folder cannot be added.');
        spec.sub = sub;
      }
      const repo = `${spec.owner}/${spec.repo}`;
      const ref = await branchOf(spec, repo);
      const source = { repo, ref, sub: spec.sub, kind: spec.kind };
      source.id = sourceId(source);
      const { skipped, ...read } = await fetchFiles(source, true);
      Object.assign(source, read);
      load();
      sources = [...sources.filter((s) => s.id !== source.id), source];
      save();
      return { ...info(source), skipped };
    },
    // Reads the list of notes again and says what is new, changed or gone.
    async updateGithub(id) {
      const source = find(id);
      const before = source.files || {};
      const { files, truncated, mounts, skipped } = await fetchFiles(source);
      const result = {
        added: Object.keys(files).filter((p) => !(p in before)),
        changed: Object.keys(files).filter((p) => p in before && before[p] !== files[p]),
        removed: Object.keys(before).filter((p) => !(p in files)),
        skipped,
      };
      Object.assign(source, { files, truncated, mounts });
      save();
      return result;
    },
    githubToken: async () => (await readToken()) !== null,
    async saveGithubToken(token) {
      if (typeof token !== 'string' || !TOKEN.test(token.trim())) throw new Error('That does not look like a GitHub token.');
      const store = await privateStore();
      // Asked once, so a miscopied or expired token is refused now and not at the first download.
      const check = await fetch(`${API}/user`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.trim()}` },
        cache: 'no-store',
      }).catch(() => null);
      if (check && check.status === 401) throw new Error('GitHub does not accept that token. Check that all of it was copied and that it has not expired.');
      await store.put(tokenUrl(), new Response(token.trim()));
      tokenSaved = true;
      tokenKnown = token.trim();
      recent = null;
    },
    async clearGithubToken() {
      await (await privateStore()).delete(tokenUrl());
      tokenSaved = false;
      tokenKnown = null;
      recent = null;
      await forgetKept(); // what was read with the token does not stay behind
    },
    async removeRoot(id) {
      const gone = find(id);
      sources = sources.filter((s) => s.id !== id);
      save();
      const still = new Set(sources.flatMap(reposOf));
      for (const repo of new Set(reposOf(gone))) if (!still.has(repo)) await forgetKept(repo);
    },
    async tree(id) {
      const source = find(id);
      return { nodes: nodes(Object.keys(source.files || {})), truncated: !!source.truncated };
    },
    async readDoc(id, path) {
      const source = find(id);
      const at = resolveInside(source, path, DOC);
      const text = await readText(at.repo, at.ref, at.path);
      if (text.length > MAX_DOC_BYTES) throw new Error('This file is too large to display.');
      return { path: at.rel, source: text };
    },
    // An image linked from a note. Public: straight from GitHub's file host. With a token: a
    // local address that sw.js answers by fetching the image with the token.
    assetUrl(id, path) {
      try {
        const source = find(id);
        const at = resolveInside(source, path, IMAGE);
        // The local address needs the service worker; without it only public images load.
        if (!tokenSaved || !navigator.serviceWorker?.controller) return `${RAW}/${at.repo}/${encPath(at.ref)}/${encPath(at.path)}`;
        return `gh-asset?repo=${encodeURIComponent(at.repo)}&ref=${encodeURIComponent(at.ref)}&path=${encodeURIComponent(at.path)}`;
      } catch {
        return 'data:,';
      }
    },
    watch: () => () => {}, // nothing changes under a hosted page; "Update" asks GitHub again
    getSettings: async () => local.get('settings', {}),
    saveSettings: async (settings) => local.set('settings', settings),
    setFullscreen: setBrowserFullscreen,
  };
}

// For the tests: the guard and the tree builder, which need no browser.
export const internals = { resolveInside, nodes, sourceId, folderCounts, fetchFiles };

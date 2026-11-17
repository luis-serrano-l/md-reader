// Service worker of the hosted version (never registered by the local versions). It does three
// things: keeps the app itself for offline use, keeps the notes and images already opened, and
// fetches the images of private repositories with the saved token.
const SHELL = 'mdr-shell-v1';
const NOTES = 'mdr-notes-v1';
const PRIVATE = 'mdr-private'; // holds the GitHub token; see web-backend.js
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const FILES = [
  './', 'app.js', 'app.css', 'study.css', 'render.js', 'backend.js', 'web-backend.js', 'github-url.js',
  'settings.js', 'pages.js', 'vendor/markdown-it.min.js', 'vendor/markdown-it-task-lists.min.js',
  'vendor/highlight.min.js', 'favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
];
const IMAGE_TYPES = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => ![SHELL, NOTES, PRIVATE].includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/gh-asset')) event.respondWith(privateImage(request, url));
    else if (url.pathname.endsWith('/__token')) event.respondWith(new Response('', { status: 404 }));
    else event.respondWith(shell(event, request));
  } else if (url.origin === API || url.origin === RAW) {
    event.respondWith(fromGithub(request, request.url));
  }
});

// The app's own files: the kept copy at once, refreshed in the background for the next visit.
async function shell(event, request) {
  const cache = await caches.open(SHELL);
  const key = request.mode === 'navigate' ? './' : request;
  const kept = await cache.match(key, { ignoreSearch: true });
  const fresh = fetch(request.mode === 'navigate' ? './' : request)
    .then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    })
    .catch(() => null);
  if (kept) {
    event.waitUntil(fresh);
    return kept;
  }
  return (await fresh) || Response.error();
}

// Notes, lists of notes and images: GitHub first, the kept copy when GitHub cannot be reached.
async function fromGithub(request, key) {
  const cache = await caches.open(NOTES);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch {
    return (await cache.match(key, { ignoreVary: true })) || Response.error();
  }
}

// An image of a private repository, asked for by an <img> of a note. Only images, only as
// images: opened as a page it would be an SVG running in the app's own origin.
async function privateImage(request, url) {
  const repo = url.searchParams.get('repo') || '';
  const ref = url.searchParams.get('ref') || '';
  const path = url.searchParams.get('path') || '';
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const safe =
    request.destination === 'image' &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) &&
    ref &&
    IMAGE_TYPES[ext] &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..');
  if (!safe) return new Response('Forbidden', { status: 403 });
  const hit = await (await caches.open(PRIVATE)).match(new URL('__token', self.registration.scope).href);
  const token = hit ? (await hit.text()).trim() : '';
  const upstream = `${API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  const res = await fromGithub(
    new Request(upstream, { headers: { Accept: 'application/vnd.github.raw+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }),
    upstream,
  );
  if (!res.ok) return new Response('Not found', { status: 404 });
  return new Response(res.body, {
    headers: {
      'Content-Type': IMAGE_TYPES[ext],
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    },
  });
}

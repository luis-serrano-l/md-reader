// md-reader server. Listens on 127.0.0.1 only. Reads .md files (and the images they link) from the
// folders the user added, and nothing else.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RootStore, GuardError, browse, DOC_EXTS, IMAGE_EXTS } from './roots.js';

const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_DOC_BYTES = 5 * 1024 * 1024;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/study.css': ['study.css', 'text/css; charset=utf-8'],
  '/render.js': ['render.js', 'text/javascript; charset=utf-8'],
  '/backend.js': ['backend.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
  '/pages.js': ['pages.js', 'text/javascript; charset=utf-8'],
  '/vendor/markdown-it.min.js': ['vendor/markdown-it.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/markdown-it-task-lists.min.js': ['vendor/markdown-it-task-lists.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/highlight.min.js': ['vendor/highlight.min.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const IMAGE_TYPES = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      reject(new GuardError(415, 'Send JSON.'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new GuardError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new GuardError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// Only this machine's own page may talk to the server: the Host must be a loopback name (stops
// DNS rebinding), and requests that a browser marks as coming from another site are refused.
function checkCaller(req, port) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const host = req.headers.host || '';
  if (!allowedHosts.has(host)) throw new GuardError(403, 'Forbidden host.');
  // The app shell itself may be reached from a link anywhere; it holds no data.
  if (req.method === 'GET' && STATIC[req.url.split('?')[0]]) return;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new GuardError(403, 'Cross-site request refused.');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) throw new GuardError(403, 'Cross-origin request refused.');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !origin && !site) {
    throw new GuardError(403, 'Request has no origin.');
  }
}

export function createServer({ store = new RootStore(), port = 4747 } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      checkCaller(req, server.address().port);
      const url = new URL(req.url, `http://${req.headers.host}`);
      await route(req, res, url, store);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof GuardError) sendJson(res, err.status, { error: err.message });
      else {
        console.error(err);
        sendJson(res, 500, { error: 'Internal error.' });
      }
    }
  });
  server.listenLocal = () => new Promise((resolve) => server.listen(port, HOST, () => resolve(server)));
  return server;
}

async function route(req, res, url, store) {
  const { pathname, searchParams: q } = url;
  const method = req.method;

  if (method === 'GET' && STATIC[pathname]) {
    const [file, type] = STATIC[pathname];
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(pathname === '/' ? { 'Content-Security-Policy': PAGE_CSP } : {}),
    });
    fs.createReadStream(path.join(PUBLIC_DIR, file)).pipe(res);
    return;
  }

  if (pathname === '/api/roots' && method === 'GET') return sendJson(res, 200, { roots: store.list() });

  if (pathname === '/api/roots' && method === 'POST') {
    const body = await readJsonBody(req);
    const root = body.kind === 'file' ? store.addFile(body.path) : store.add(body.path);
    return sendJson(res, 200, { root: store.list().find((r) => r.id === root.id) });
  }

  if (pathname.startsWith('/api/roots/') && method === 'DELETE') {
    store.remove(decodeURIComponent(pathname.slice('/api/roots/'.length)));
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/settings' && method === 'GET') return sendJson(res, 200, { settings: store.getSettings() });

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJsonBody(req);
    store.saveSettings(body.settings);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/browse' && method === 'GET') return sendJson(res, 200, browse(q.get('dir'), q.get('files') === '1'));

  if (pathname === '/api/tree' && method === 'GET') return sendJson(res, 200, store.tree(q.get('root')));

  if (pathname === '/api/doc' && method === 'GET') {
    const { file, rel } = store.resolveInside(q.get('root'), q.get('path'), DOC_EXTS);
    if (fs.statSync(file).size > MAX_DOC_BYTES) throw new GuardError(413, 'This file is too large to display.');
    // The Markdown is sent as text; the page renders it (public/render.js).
    return sendJson(res, 200, { path: rel, source: fs.readFileSync(file, 'utf8') });
  }

  if (pathname === '/asset' && method === 'GET') {
    const { file } = store.resolveInside(q.get('root'), q.get('path'), IMAGE_EXTS);
    res.writeHead(200, {
      'Content-Type': IMAGE_TYPES[path.extname(file).toLowerCase()],
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      // An SVG opened directly in a tab could run script; sandbox it. As <img> it never does.
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (pathname === '/api/watch' && method === 'GET') return watch(req, res, store, q);

  throw new GuardError(404, 'Not found.');
}

// Server-sent events: one "changed" message each time the open note is saved. The folder is
// watched, not the file, because editors replace the file on save.
function watch(req, res, store, q) {
  const { file } = store.resolveInside(q.get('root'), q.get('path'), DOC_EXTS);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const name = path.basename(file);
  let timer = null;
  let watcher = null;
  try {
    watcher = fs.watch(path.dirname(file), (event, changed) => {
      if (changed && changed !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => res.write('data: changed\n\n'), 150);
    });
    watcher.on('error', () => {});
  } catch {
    /* no live reload for this file; the page still works */
  }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(timer);
    watcher?.close();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4747;
  const server = createServer({ port });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Try: PORT=4748 npm start` : err);
    process.exit(1);
  });
  await server.listenLocal();
  console.log(`md-reader: http://localhost:${port}`);
}

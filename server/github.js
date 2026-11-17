// GitHub sources: a folder or one .md file of a repository, downloaded with `git` into the
// app's own data folder and then read like any local source (same path guard, .md only).
//
// - The copy is read-only from the app's side: it is cloned, fetched and reset, never committed
//   to or pushed.
// - Only what is asked for is downloaded: a shallow, sparse clone without blobs
//   (`git clone --depth 1 --filter=blob:none --sparse` plus `git sparse-checkout set`).
// - A token for private repositories is kept in its own file (mode 0600) next to the config
//   file. It is handed to `git` through the environment for one command at a time; it is never
//   written into the clone, its URL or its .git/config, and never sent back to the page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GuardError } from './roots.js';

const GIT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
// The branch kept in the config file: the default branch's own name may hold a "/".
const STORED_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
// A path segment that is safe as a sparse-checkout folder and as a file name.
const SEGMENT = /^[^/\\\0-\x1f*?[\]!#]+$/;

const bad = (message) => new GuardError(400, message);

// "https://github.com/owner/repo", ".../tree/<branch>/<folder>", ".../blob/<branch>/<file>.md"
// or "owner/repo" -> { owner, repo, ref, sub, kind }. `ref` is '' for the default branch, `sub`
// is '' for the whole repository. A branch name with a "/" in it cannot be told apart from a
// folder in such a URL, so it is not supported.
export function parseGithubUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2000) throw bad('Give the address of a GitHub repository, folder or file.');
  let text = input.trim();
  const ssh = /^git@github\.com:(.+)$/i.exec(text);
  if (ssh) text = ssh[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(www\.)?github\.com\//i.test(text)) {
    // The URL parser would quietly fold "." and ".." segments away; they are refused instead.
    if (/(^|\/)(\.|%2e){1,2}(?=[/?#]|$)/i.test(text)) throw bad('The path in that address cannot be used.');
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      throw bad('That is not a valid address.');
    }
    if (url.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(url.hostname) || url.username || url.password || url.port) {
      throw bad('Only https://github.com addresses can be added.');
    }
    text = url.pathname;
  }
  let parts;
  try {
    parts = text.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw bad('That is not a valid address.');
  }
  if (parts.length < 2) throw bad('The address must name a repository: github.com/owner/repository.');
  const [owner, rawRepo, marker, ref = '', ...rest] = parts;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') throw bad('That is not a GitHub repository name.');
  if (marker === undefined) return { owner, repo, ref: '', sub: '', kind: 'folder' };
  if (marker !== 'tree' && marker !== 'blob') throw bad('Give the address of a repository, of a folder in it, or of a .md file in it.');
  if (!REF.test(ref)) throw bad('The branch name in that address cannot be used.');
  if (rest.some((part) => part === '.' || part === '..' || part.startsWith('-') || part !== part.trim() || !SEGMENT.test(part))) {
    throw bad('The path in that address cannot be used.');
  }
  const sub = rest.join('/');
  if (marker === 'tree') return { owner, repo, ref, sub, kind: 'folder' };
  if (!sub || !/\.md$/i.test(sub)) throw new GuardError(403, 'Only Markdown (.md) files can be added.');
  return { owner, repo, ref, sub, kind: 'file' };
}

// ---------- Where things are kept ----------

// With MD_READER_CONFIG (a scratch folder list for testing) the downloads go next to that
// file, so a test never touches the copies of the real folder list.
export function dataDir() {
  if (process.env.MD_READER_CONFIG) return path.join(path.dirname(path.resolve(process.env.MD_READER_CONFIG)), 'md-reader-data');
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'md-reader');
}

const reposDir = () => path.join(dataDir(), 'repos');

// The folder of one source's clone: repos/<owner>/<repo>/<key>, the key naming branch and path.
export function cloneDir(spec) {
  // FNV-1a, 40 bits: the same key as the desktop app makes, so both use one copy.
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(`${spec.ref}\n${spec.sub}\n${spec.kind}`)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const key = (hash & 0xffffffffffn).toString(16).padStart(10, '0');
  return path.join(reposDir(), spec.owner, spec.repo, key);
}

// True for a folder that this module made: three levels below repos/, nothing odd in between.
function isCloneDir(dir) {
  const rel = path.relative(reposDir(), path.resolve(dir));
  const parts = rel.split(path.sep);
  return !path.isAbsolute(rel) && parts.length === 3 && parts.every((part) => part && part !== '.' && part !== '..');
}

function removeDir(dir) {
  if (!isCloneDir(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  // Empty <repo> and <owner> folders are not left behind.
  for (const parent of [path.dirname(dir), path.dirname(path.dirname(dir))]) {
    try {
      fs.rmdirSync(parent);
    } catch {
      break;
    }
  }
}

// ---------- The token ----------

const tokenFile = (configFile) => path.join(path.dirname(configFile), 'github-token');

function readToken(configFile) {
  try {
    const token = fs.readFileSync(tokenFile(configFile), 'utf8').trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

export const hasToken = (configFile) => readToken(configFile) !== null;

export function saveToken(configFile, token) {
  if (typeof token !== 'string' || !TOKEN.test(token.trim())) throw bad('That does not look like a GitHub token.');
  const file = tokenFile(configFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token.trim()}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function clearToken(configFile) {
  fs.rmSync(tokenFile(configFile), { force: true });
}

// ---------- Running git ----------

function gitEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  if (token) {
    // Sent as a request header for github.com only, for this one command.
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

function git(args, { cwd, token } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Its own process group, so a timeout also stops the helpers git starts.
      child = spawn('git', args, { cwd, env: gitEnv(token), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch {
      reject(new GuardError(500, 'git could not be started.'));
      return;
    }
    let out = '';
    let err = '';
    let tooMuch = false;
    child.stdout.on('data', (chunk) => {
      if (out.length < MAX_OUTPUT) out += chunk;
      else tooMuch = true;
    });
    child.stderr.on('data', (chunk) => { if (err.length < 20_000) err += chunk; });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      reject(new GuardError(504, 'The download took too long and was stopped.'));
    }, GIT_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new GuardError(500, e.code === 'ENOENT' ? 'git is not installed. It is needed to download from GitHub.' : 'git could not be started.'));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && tooMuch) reject(new GuardError(502, 'git answered with more than md-reader can read.'));
      else if (code === 0) resolve(out);
      else if (signal) reject(new GuardError(504, 'The download took too long and was stopped.'));
      else reject(gitError(err, !!token));
    });
  });
}

// git's own message -> something a reader can act on. The token is never part of it.
export function gitError(stderr, hadToken) {
  const text = String(stderr);
  if (/Repository not found|could not read Username|Authentication failed|terminal prompts disabled|returned error: 40[134]/i.test(text)) {
    return new GuardError(404, hadToken
      ? 'GitHub did not give access to that repository. Check the address, and that the saved token may read it.'
      : 'That repository was not found. If it is private, save a GitHub token first.');
  }
  if (/Remote branch .* not found|couldn't find remote ref|not our ref/i.test(text)) return new GuardError(404, 'That branch was not found in the repository.');
  if (/Could not resolve host|unable to access|Connection (timed out|refused)|Failed to connect/i.test(text)) {
    return new GuardError(502, 'GitHub could not be reached. Check the network connection.');
  }
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';
  return new GuardError(502, `git failed: ${line.slice(0, 300)}`);
}

// ---------- Download and update ----------

const sparseFolder = (spec) => (spec.kind === 'file' ? path.posix.dirname(spec.sub).replace(/^\.$/, '') : spec.sub);

// Downloads what `spec` (from parseGithubUrl) names. Returns { dir, target, github } where
// `target` is the folder or file to add as a source and `github` is what the config keeps.
export async function download(spec, configFile) {
  const token = readToken(configFile);
  const dir = cloneDir(spec);
  const folder = sparseFolder(spec);
  const whole = spec.kind === 'folder' && !spec.sub;
  const target = path.join(dir, ...spec.sub.split('/').filter(Boolean));
  const found = () => {
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    return !!stat && (spec.kind === 'file' ? stat.isFile() : stat.isDirectory());
  };
  // Already downloaded (the same address was added before): that copy is used as it is, never
  // deleted and fetched again. "Update" is what brings it up to date.
  if (fs.existsSync(path.join(dir, '.git')) && found()) {
    const ref = spec.ref || (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).trim();
    return { dir, target, github: { repo: `${spec.owner}/${spec.repo}`, ref, sub: spec.sub, dir } };
  }
  removeDir(dir); // what an interrupted download left
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    await git(
      ['clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', '--filter=blob:none',
        ...(whole ? [] : ['--sparse']), ...(spec.ref ? ['--branch', spec.ref] : []),
        '--', `https://github.com/${spec.owner}/${spec.repo}.git`, dir],
      { token },
    );
    if (folder) await git(['sparse-checkout', 'set', '--cone', '--', folder], { cwd: dir, token });
    const ref = spec.ref || (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).trim();
    if (!found()) {
      throw new GuardError(404, spec.kind === 'file' ? 'That file was not found in the repository.' : 'That folder was not found in the repository.');
    }
    return { dir, target, github: { repo: `${spec.owner}/${spec.repo}`, ref, sub: spec.sub, dir } };
  } catch (err) {
    removeDir(dir);
    throw err;
  }
}

// Brings a downloaded source up to date. Returns the notes that changed:
// { added: [...], changed: [...], removed: [...] } with paths relative to the source.
export async function update(root, configFile) {
  const g = root.github;
  if (!g || !isCloneDir(g.dir) || !STORED_REF.test(g.ref) || g.ref.includes('..')) throw bad('This source was not downloaded from GitHub.');
  if (!fs.existsSync(path.join(g.dir, '.git'))) throw new GuardError(404, 'The downloaded copy is missing. Remove this source and add it again.');
  const token = readToken(configFile);
  const before = (await git(['rev-parse', 'HEAD'], { cwd: g.dir })).trim();
  await git(['fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', g.ref], { cwd: g.dir, token });
  const after = (await git(['rev-parse', 'FETCH_HEAD'], { cwd: g.dir })).trim();
  const result = { added: [], changed: [], removed: [] };
  if (before === after) return result;
  const single = root.kind === 'file';
  const diff = await git(['diff', '--name-status', '--no-renames', '-z', before, after, '--', g.sub || '.'], { cwd: g.dir, token });
  // The copy only ever follows the repository: local changes to it are not kept.
  await git(['reset', '--quiet', '--hard', after], { cwd: g.dir, token });
  const fields = diff.split('\0');
  const prefix = single ? path.posix.dirname(g.sub).replace(/^\.$/, '') : g.sub;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const file = fields[i + 1];
    if (!/\.md$/i.test(file)) continue;
    const rel = prefix && file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : file;
    const list = fields[i] === 'A' ? result.added : fields[i] === 'D' ? result.removed : result.changed;
    list.push(rel);
  }
  return result;
}

// Deletes the downloaded copy of a removed source.
export function discard(root) {
  if (root?.github) removeDir(root.github.dir);
}

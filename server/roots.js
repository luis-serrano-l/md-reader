// The list of allowed sources and the path guard. Every route that touches the disk goes through
// RootStore.resolveInside(), which is the only place that turns a request into a file path.
//
// A source is a folder (all its .md files) or a single .md file. In the config file a plain
// folder is a string; anything else is { path, kind: 'folder' | 'file', github? }, where
// `github` describes the repository a downloaded copy came from (server/github.js).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DOC_EXTS, IMAGE_EXTS } from '../public/render.js';

export { DOC_EXTS, IMAGE_EXTS };

const SKIP_DIRS = new Set(['node_modules']);
const MAX_TREE_DEPTH = 8;
const MAX_TREE_FILES = 5000;
const MAX_SETTINGS_BYTES = 8 * 1024;

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export class GuardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function defaultConfigPath() {
  if (process.env.MD_READER_CONFIG) return process.env.MD_READER_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'md-reader', 'config.json');
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isInside(parent, child) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function realpathOr(p, status, message) {
  try {
    return fs.realpathSync(p);
  } catch {
    throw new GuardError(status, message);
  }
}

export class RootStore {
  constructor(file = defaultConfigPath()) {
    this.file = file;
    this.roots = [];
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const seen = new Set();
      this.roots = (Array.isArray(data.roots) ? data.roots : [])
        .map(readEntry)
        .filter((r) => r && !seen.has(r.path) && seen.add(r.path));
    } catch {
      this.roots = [];
    }
  }

  // The whole config file as it is on disk now, or {} when missing or unreadable.
  readFile() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return isPlainObject(data) ? data : {};
    } catch {
      return {};
    }
  }

  // Writes one part of the config file and keeps the rest as it is on disk, so the browser
  // version and the desktop app (which share the file) do not undo each other's changes.
  write(part) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...this.readFile(), ...part }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

  save() {
    this.write({ roots: this.roots.map(writeEntry) });
  }

  // Fonts and colours. Stored as given; the page checks every value before using it
  // (public/settings.js), so this only keeps the file small and well-formed.
  getSettings() {
    const { settings } = this.readFile();
    return isPlainObject(settings) ? settings : {};
  }

  saveSettings(settings) {
    if (!isPlainObject(settings)) throw new GuardError(400, 'Settings must be an object.');
    if (JSON.stringify(settings).length > MAX_SETTINGS_BYTES) throw new GuardError(413, 'Settings are too large.');
    this.write({ settings });
  }

  list() {
    return this.roots.map((r) => ({
      id: r.id,
      path: r.path,
      name: path.basename(r.path) || r.path,
      kind: r.kind,
      github: r.github ? { repo: r.github.repo, ref: r.github.ref, sub: r.github.sub } : null,
      missing: r.kind === 'file' ? !isFile(r.path) : !isDirectory(r.path),
    }));
  }

  get(id) {
    return this.roots.find((r) => r.id === id);
  }

  add(input) {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
      throw new GuardError(400, 'Give the path of a folder.');
    }
    this.load(); // the desktop app may have changed the list since it was read
    const wanted = expandHome(input.trim());
    if (!path.isAbsolute(wanted)) throw new GuardError(400, 'The path must be absolute (start with / or ~).');
    const real = realpathOr(wanted, 404, 'That folder does not exist.');
    if (!isDirectory(real)) throw new GuardError(400, 'That path is a file, not a folder.');
    if (real === path.parse(real).root) throw new GuardError(400, 'The whole disk cannot be added. Pick a folder.');
    return this.put({ id: rootId(real), path: real, kind: 'folder' });
  }

  // One .md file. Only that file can be opened, plus images in its own folder or below.
  addFile(input, github) {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
      throw new GuardError(400, 'Give the path of a Markdown file.');
    }
    this.load();
    const wanted = expandHome(input.trim());
    if (!path.isAbsolute(wanted)) throw new GuardError(400, 'The path must be absolute (start with / or ~).');
    const real = realpathOr(wanted, 404, 'That file does not exist.');
    if (!isFile(real)) throw new GuardError(400, 'That path is not a file.');
    if (!DOC_EXTS.has(path.extname(real).toLowerCase())) throw new GuardError(403, 'Only Markdown (.md) files can be added.');
    if (github) requireInsideCopy(real, github);
    return this.put({ id: rootId(real), path: real, kind: 'file', ...(github ? { github } : {}) });
  }

  // A downloaded copy of a GitHub folder (server/github.js made it and says where it is).
  addGithubFolder(dir, github) {
    this.load();
    const real = realpathOr(dir, 404, 'That folder does not exist.');
    if (!isDirectory(real)) throw new GuardError(400, 'That path is a file, not a folder.');
    requireInsideCopy(real, github);
    return this.put({ id: rootId(real), path: real, kind: 'folder', github });
  }

  put(root) {
    const existing = this.roots.find((r) => r.path === root.path);
    if (existing) return existing;
    this.roots.push(root);
    this.save();
    return root;
  }

  // Returns the entry that was removed.
  remove(id) {
    this.load();
    const removed = this.get(id);
    if (!removed) throw new GuardError(404, 'Unknown folder.');
    this.roots = this.roots.filter((r) => r.id !== id);
    this.save();
    return removed;
  }

  // Turns (root id, relative path) into a real file path, or throws. Rules, in order:
  // the root must be configured; the extension must be allowed; the real path (symlinks
  // resolved) must stay inside the real root; the real file's extension must be allowed too.
  // For a single-file source the "root" is the file's folder, and the only .md file that can
  // be opened is the file itself.
  resolveInside(id, rel, exts) {
    const root = this.get(id);
    if (!root) throw new GuardError(404, 'Unknown folder.');
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new GuardError(400, 'Missing path.');
    if (!exts.has(path.extname(rel).toLowerCase())) throw new GuardError(403, 'This file type cannot be opened.');
    const single = root.kind === 'file';
    const sourceReal = realpathOr(root.path, 404, single ? 'The file no longer exists.' : 'The folder no longer exists.');
    // A repository may hold links; a downloaded source never reads outside its own copy.
    if (root.github) requireInsideCopy(sourceReal, root.github);
    const rootReal = single ? path.dirname(sourceReal) : sourceReal;
    // A file kept directly in the home folder or at the top of the disk must not open every
    // image below it: for such a file only the note itself is served.
    if (single && !DOC_EXTS.has(path.extname(rel).toLowerCase()) && tooBroad(rootReal)) {
      throw new GuardError(403, 'Images are not shown for a file kept directly in the home folder.');
    }
    const candidate = path.resolve(rootReal, rel);
    if (!isInside(rootReal, candidate)) throw new GuardError(403, 'Path is outside the folder.');
    const real = realpathOr(candidate, 404, 'File not found.');
    if (!isInside(rootReal, real)) throw new GuardError(403, 'Path is outside the folder.');
    if (!exts.has(path.extname(real).toLowerCase())) throw new GuardError(403, 'This file type cannot be opened.');
    if (single && DOC_EXTS.has(path.extname(real).toLowerCase()) && real !== sourceReal) {
      throw new GuardError(403, 'Only the file that was added can be opened.');
    }
    let stat;
    try {
      stat = fs.statSync(real);
    } catch {
      throw new GuardError(404, 'File not found.');
    }
    if (!stat.isFile()) throw new GuardError(404, 'File not found.');
    return { file: real, rootReal, rel: path.relative(rootReal, real).split(path.sep).join('/') };
  }

  // Nested list of the .md files under a root. Symlinks are not followed.
  tree(id) {
    const root = this.get(id);
    if (!root) throw new GuardError(404, 'Unknown folder.');
    if (root.kind === 'file') {
      if (!isFile(root.path)) throw new GuardError(404, 'The file no longer exists.');
      const name = path.basename(root.path);
      return { nodes: [{ type: 'file', name, path: name }], truncated: false };
    }
    if (!isDirectory(root.path)) throw new GuardError(404, 'The folder no longer exists.');
    const budget = { left: MAX_TREE_FILES };
    return { nodes: walk(root.path, '', 0, budget), truncated: budget.left <= 0 };
  }
}

function rootId(p) {
  return crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
}

// One entry of "roots" in the config file -> a source, or null when it is not valid.
function readEntry(entry) {
  if (typeof entry === 'string') return path.isAbsolute(entry) ? { id: rootId(entry), path: entry, kind: 'folder' } : null;
  if (!isPlainObject(entry) || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return null;
  if (entry.kind !== 'folder' && entry.kind !== 'file') return null;
  const root = { id: rootId(entry.path), path: entry.path, kind: entry.kind };
  const g = entry.github;
  if (isPlainObject(g) && [g.repo, g.ref, g.sub, g.dir].every((v) => typeof v === 'string') && path.isAbsolute(g.dir)) {
    root.github = { repo: g.repo, ref: g.ref, sub: g.sub, dir: g.dir };
  }
  return root;
}

function writeEntry(root) {
  if (root.kind === 'folder' && !root.github) return root.path;
  return { path: root.path, kind: root.kind, ...(root.github ? { github: root.github } : {}) };
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function walk(abs, rel, depth, budget) {
  const dirs = [];
  const files = [];
  for (const entry of readDir(abs)) {
    if (budget.left <= 0) break;
    if (entry.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || depth >= MAX_TREE_DEPTH) continue;
      const children = walk(path.join(abs, entry.name), childRel, depth + 1, budget);
      if (children.length) dirs.push({ type: 'dir', name: entry.name, path: childRel, children });
    } else if (entry.isFile() && DOC_EXTS.has(path.extname(entry.name).toLowerCase())) {
      budget.left -= 1;
      files.push({ type: 'file', name: entry.name, path: childRel });
    }
  }
  return [...dirs.sort(byName), ...files.sort(byName)];
}

// A source downloaded from GitHub must be, links resolved, inside the folder of its download.
function requireInsideCopy(real, github) {
  let copy = null;
  try {
    copy = fs.realpathSync(String(github?.dir));
  } catch {
    /* refused below */
  }
  if (!copy || !isInside(copy, real)) throw new GuardError(403, 'This source leads outside its downloaded copy.');
}

// True for a folder that is too much to open as a side effect of adding one file in it: the
// top of the disk and the home folder.
export function tooBroad(dir, home = os.homedir()) {
  let homeReal = home;
  try {
    homeReal = fs.realpathSync(home);
  } catch {
    /* compared as given */
  }
  return dir === path.parse(dir).root || dir === homeReal;
}

// Directory listing for the "Add folder" and "Add file" dialogs: sub-folders, and with
// `withFiles` the names of the .md files in the folder. Never other file names, never contents.
export function browse(input, withFiles = false) {
  const wanted = input ? expandHome(String(input)) : os.homedir();
  if (wanted.includes('\0') || !path.isAbsolute(wanted)) throw new GuardError(400, 'The path must be absolute.');
  const dir = realpathOr(wanted, 404, 'That folder does not exist.');
  if (!isDirectory(dir)) throw new GuardError(400, 'That path is not a folder.');
  const isMd = (e) => e.isFile() && DOC_EXTS.has(path.extname(e.name).toLowerCase());
  const countMd = (d) => readDir(d).filter(isMd).length;
  const entries = readDir(dir);
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .sort(byName)
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), md: countMd(path.join(dir, e.name)) }));
  const parent = path.dirname(dir);
  const files = withFiles
    ? entries
        .filter((e) => isMd(e) && !e.name.startsWith('.'))
        .sort(byName)
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    : [];
  return { dir, parent: parent === dir ? null : parent, md: entries.filter(isMd).length, dirs, files };
}

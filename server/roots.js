// The allowed-folder list and the path guard. Every route that touches the disk goes through
// RootStore.resolveInside(), which is the only place that turns a request into a file path.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DOC_EXTS = new Set(['.md']);
export const IMAGE_EXTS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

const SKIP_DIRS = new Set(['node_modules']);
const MAX_TREE_DEPTH = 8;
const MAX_TREE_FILES = 5000;

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
        .filter((p) => typeof p === 'string' && path.isAbsolute(p) && !seen.has(p) && seen.add(p))
        .map((p) => ({ id: rootId(p), path: p }));
    } catch {
      this.roots = [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ roots: this.roots.map((r) => r.path) }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.roots.map((r) => ({
      id: r.id,
      path: r.path,
      name: path.basename(r.path) || r.path,
      missing: !isDirectory(r.path),
    }));
  }

  get(id) {
    return this.roots.find((r) => r.id === id);
  }

  add(input) {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
      throw new GuardError(400, 'Give the path of a folder.');
    }
    const wanted = expandHome(input.trim());
    if (!path.isAbsolute(wanted)) throw new GuardError(400, 'The path must be absolute (start with / or ~).');
    const real = realpathOr(wanted, 404, 'That folder does not exist.');
    if (!isDirectory(real)) throw new GuardError(400, 'That path is a file, not a folder.');
    if (real === path.parse(real).root) throw new GuardError(400, 'The whole disk cannot be added. Pick a folder.');
    const existing = this.roots.find((r) => r.path === real);
    if (existing) return existing;
    const root = { id: rootId(real), path: real };
    this.roots.push(root);
    this.save();
    return root;
  }

  remove(id) {
    const before = this.roots.length;
    this.roots = this.roots.filter((r) => r.id !== id);
    if (this.roots.length === before) throw new GuardError(404, 'Unknown folder.');
    this.save();
  }

  // Turns (root id, relative path) into a real file path, or throws. Rules, in order:
  // the root must be configured; the extension must be allowed; the real path (symlinks
  // resolved) must stay inside the real root; the real file's extension must be allowed too.
  resolveInside(id, rel, exts) {
    const root = this.get(id);
    if (!root) throw new GuardError(404, 'Unknown folder.');
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new GuardError(400, 'Missing path.');
    if (!exts.has(path.extname(rel).toLowerCase())) throw new GuardError(403, 'This file type cannot be opened.');
    const rootReal = realpathOr(root.path, 404, 'The folder no longer exists.');
    const candidate = path.resolve(rootReal, rel);
    if (!isInside(rootReal, candidate)) throw new GuardError(403, 'Path is outside the folder.');
    const real = realpathOr(candidate, 404, 'File not found.');
    if (!isInside(rootReal, real)) throw new GuardError(403, 'Path is outside the folder.');
    if (!exts.has(path.extname(real).toLowerCase())) throw new GuardError(403, 'This file type cannot be opened.');
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
    if (!isDirectory(root.path)) throw new GuardError(404, 'The folder no longer exists.');
    const budget = { left: MAX_TREE_FILES };
    return { nodes: walk(root.path, '', 0, budget), truncated: budget.left <= 0 };
  }
}

function rootId(p) {
  return crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
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

// Directory listing for the "Add folder" dialog: sub-folders only, never file names or contents.
export function browse(input) {
  const wanted = input ? expandHome(String(input)) : os.homedir();
  if (wanted.includes('\0') || !path.isAbsolute(wanted)) throw new GuardError(400, 'The path must be absolute.');
  const dir = realpathOr(wanted, 404, 'That folder does not exist.');
  if (!isDirectory(dir)) throw new GuardError(400, 'That path is not a folder.');
  const countMd = (d) =>
    readDir(d).filter((e) => e.isFile() && DOC_EXTS.has(path.extname(e.name).toLowerCase())).length;
  const dirs = readDir(dir)
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .sort(byName)
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), md: countMd(path.join(dir, e.name)) }));
  const parent = path.dirname(dir);
  return { dir, parent: parent === dir ? null : parent, md: countMd(dir), dirs };
}

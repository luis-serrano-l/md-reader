import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RootStore, GuardError, DOC_EXTS, IMAGE_EXTS, browse } from '../server/roots.js';

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-')));
  const root = path.join(base, 'notes');
  fs.mkdirSync(path.join(root, 'diagrams'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sub'));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'a.md'), '# A');
  fs.writeFileSync(path.join(root, 'B.MD'), '# B');
  fs.writeFileSync(path.join(root, 'a.pdf'), 'pdf');
  fs.writeFileSync(path.join(root, 'sub', 'c.md'), '# C');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'README.md'), 'x');
  fs.writeFileSync(path.join(root, '.hidden', 'h.md'), 'x');
  fs.writeFileSync(path.join(root, 'diagrams', 'd.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(base, 'secret.md'), 'secret');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(base, 'secret.md'), path.join(root, 'escape.md'));
  fs.symlinkSync(path.join(root, 'a.pdf'), path.join(root, 'disguised.md'));
  fs.symlinkSync(base, path.join(root, 'up'));
  const store = new RootStore(path.join(base, 'config', 'config.json'));
  const { id } = store.add(root);
  return { base, root, store, id };
}

const status = (code) => (err) => err instanceof GuardError && err.status === code;

test('opens .md files inside an added folder', () => {
  const { store, id, root } = fixture();
  assert.equal(store.resolveInside(id, 'a.md', DOC_EXTS).file, path.join(root, 'a.md'));
  assert.equal(store.resolveInside(id, 'sub/c.md', DOC_EXTS).rel, 'sub/c.md');
  assert.equal(store.resolveInside(id, 'B.MD', DOC_EXTS).rel, 'B.MD');
});

test('refuses anything that is not .md as a document', () => {
  const { store, id } = fixture();
  assert.throws(() => store.resolveInside(id, 'a.pdf', DOC_EXTS), status(403));
  assert.throws(() => store.resolveInside(id, 'diagrams/d.svg', DOC_EXTS), status(403));
  assert.throws(() => store.resolveInside(id, 'sub', DOC_EXTS), status(403));
});

test('refuses paths that leave the folder', () => {
  const { store, id, base } = fixture();
  assert.throws(() => store.resolveInside(id, '../secret.md', DOC_EXTS), status(403));
  assert.throws(() => store.resolveInside(id, 'sub/../../secret.md', DOC_EXTS), status(403));
  assert.throws(() => store.resolveInside(id, path.join(base, 'secret.md'), DOC_EXTS), status(403));
});

test('refuses symlinks that leave the folder or hide another file type', () => {
  const { store, id } = fixture();
  assert.throws(() => store.resolveInside(id, 'escape.md', DOC_EXTS), status(403));
  assert.throws(() => store.resolveInside(id, 'up/secret.md', DOC_EXTS), status(403));
  assert.throws(() => store.resolveInside(id, 'disguised.md', DOC_EXTS), status(403));
});

test('unknown folders and missing files are not found', () => {
  const { store, id } = fixture();
  assert.throws(() => store.resolveInside('nope', 'a.md', DOC_EXTS), status(404));
  assert.throws(() => store.resolveInside(id, 'missing.md', DOC_EXTS), status(404));
  assert.throws(() => store.resolveInside(id, '', DOC_EXTS), status(400));
});

test('assets: images only', () => {
  const { store, id } = fixture();
  assert.ok(store.resolveInside(id, 'diagrams/d.svg', IMAGE_EXTS).file.endsWith('d.svg'));
  assert.throws(() => store.resolveInside(id, 'a.md', IMAGE_EXTS), status(403));
  assert.throws(() => store.resolveInside(id, 'a.pdf', IMAGE_EXTS), status(403));
});

test('tree lists only .md files and skips hidden folders, node_modules and symlinks', () => {
  const { store, id } = fixture();
  const flat = [];
  const visit = (nodes) => nodes.forEach((n) => (n.type === 'dir' ? visit(n.children) : flat.push(n.path)));
  visit(store.tree(id).nodes);
  assert.deepEqual(flat.sort(), ['B.MD', 'a.md', 'sub/c.md']);
});

test('folders persist, deduplicate, and stop being readable once removed', () => {
  const { store, id, root } = fixture();
  assert.equal(store.add(root + '/').id, id);
  assert.equal(new RootStore(store.file).list().length, 1);
  store.remove(id);
  assert.throws(() => store.resolveInside(id, 'a.md', DOC_EXTS), status(404));
  assert.equal(new RootStore(store.file).list().length, 0);
});

test('add refuses files, missing paths, relative paths and the disk root', () => {
  const { store, root } = fixture();
  assert.throws(() => store.add(path.join(root, 'a.md')), status(400));
  assert.throws(() => store.add(path.join(root, 'nope')), status(404));
  assert.throws(() => store.add('notes'), status(400));
  assert.throws(() => store.add('/'), status(400));
});

test('browse lists sub-folders only', () => {
  const { root } = fixture();
  const listing = browse(root);
  assert.deepEqual(listing.dirs.map((d) => d.name), ['diagrams', 'empty', 'sub']);
  assert.equal(listing.md, 2);
  assert.equal(listing.dirs.find((d) => d.name === 'sub').md, 1);
});

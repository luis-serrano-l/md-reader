// The hosted version's guard and tree builder (public/web-backend.js). The rest of that file
// needs a browser and GitHub, so it is not covered here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { internals } from '../public/web-backend.js';

const { resolveInside, nodes, sourceId } = internals;
const DOC = /\.md$/i;
const IMAGE = /\.(svg|png|jpe?g|gif|webp)$/i;
const folder = { repo: 'octo/notes', ref: 'main', sub: 'docs', kind: 'folder' };
const file = { repo: 'octo/notes', ref: 'main', sub: 'docs/a.md', kind: 'file' };

test('hosted guard: a path stays inside the folder that was added', () => {
  assert.deepEqual(resolveInside(folder, 'week 1/b.md', DOC), { full: 'docs/week 1/b.md', rel: 'week 1/b.md' });
  assert.deepEqual(resolveInside(folder, './x/../b.md', DOC), { full: 'docs/b.md', rel: 'b.md' });
  assert.deepEqual(resolveInside({ ...folder, sub: '' }, 'README.md', DOC), { full: 'README.md', rel: 'README.md' });
  assert.equal(resolveInside(folder, 'img/d.svg', IMAGE).full, 'docs/img/d.svg');
  for (const bad of ['../secret.md', 'x/../../secret.md', '..', '', null, 'a.pdf', 'a.md/', 'a\\..\\b.md', 'a\nb.md']) {
    assert.throws(() => resolveInside(folder, bad, DOC), undefined, String(bad));
  }
  assert.throws(() => resolveInside(folder, 'a.md', IMAGE));
  assert.throws(() => resolveInside(folder, 'd.svg', DOC));
});

test('hosted guard: a single file opens only itself, plus images beside or below it', () => {
  assert.deepEqual(resolveInside(file, 'a.md', DOC), { full: 'docs/a.md', rel: 'a.md' });
  assert.throws(() => resolveInside(file, 'b.md', DOC), /Only the file/);
  assert.throws(() => resolveInside(file, 'sub/a.md', DOC), /Only the file/);
  assert.equal(resolveInside(file, 'img/d.png', IMAGE).full, 'docs/img/d.png');
  assert.throws(() => resolveInside(file, '../d.png', IMAGE));
  // At the top of a repository: the images beside it, not the whole repository's.
  const top = { ...file, sub: 'README.md' };
  assert.equal(resolveInside(top, 'logo.png', IMAGE).full, 'logo.png');
  assert.throws(() => resolveInside(top, 'private/scan.png', IMAGE));
});

test('hosted tree: folders first, then files, by name', () => {
  assert.deepEqual(nodes(['b.md', 'sub/z.md', 'a.md', 'sub/deep/c.md', 'sub/10.md', 'sub/9.md']), [
    {
      type: 'dir', name: 'sub', path: 'sub', children: [
        { type: 'dir', name: 'deep', path: 'sub/deep', children: [{ type: 'file', name: 'c.md', path: 'sub/deep/c.md' }] },
        { type: 'file', name: '9.md', path: 'sub/9.md' },
        { type: 'file', name: '10.md', path: 'sub/10.md' },
        { type: 'file', name: 'z.md', path: 'sub/z.md' },
      ],
    },
    { type: 'file', name: 'a.md', path: 'a.md' },
    { type: 'file', name: 'b.md', path: 'b.md' },
  ]);
  assert.notEqual(sourceId(folder), sourceId(file));
  assert.match(sourceId(folder), /^w[0-9a-f]{8}$/);
});

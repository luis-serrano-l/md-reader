// The hosted version's guard and tree builder (public/web-backend.js). The rest of that file
// needs a browser and GitHub, so it is not covered here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { internals } from '../public/web-backend.js';

const { resolveInside, nodes, sourceId, folderCounts, fetchFiles } = internals;
const DOC = /\.md$/i;
const IMAGE = /\.(svg|png|jpe?g|gif|webp)$/i;
const folder = { repo: 'octo/notes', ref: 'main', sub: 'docs', kind: 'folder' };
const file = { repo: 'octo/notes', ref: 'main', sub: 'docs/a.md', kind: 'file' };

test('hosted guard: a path stays inside the folder that was added', () => {
  const here = { repo: 'octo/notes', ref: 'main' };
  assert.deepEqual(resolveInside(folder, 'week 1/b.md', DOC), { full: 'docs/week 1/b.md', rel: 'week 1/b.md', ...here, path: 'docs/week 1/b.md' });
  assert.deepEqual(resolveInside(folder, './x/../b.md', DOC), { full: 'docs/b.md', rel: 'b.md', ...here, path: 'docs/b.md' });
  assert.deepEqual(resolveInside({ ...folder, sub: '' }, 'README.md', DOC), { full: 'README.md', rel: 'README.md', ...here, path: 'README.md' });
  assert.equal(resolveInside(folder, 'img/d.svg', IMAGE).full, 'docs/img/d.svg');
  for (const bad of ['../secret.md', 'x/../../secret.md', '..', '', null, 'a.pdf', 'a.md/', 'a\\..\\b.md', 'a\nb.md']) {
    assert.throws(() => resolveInside(folder, bad, DOC), undefined, String(bad));
  }
  assert.throws(() => resolveInside(folder, 'a.md', IMAGE));
  assert.throws(() => resolveInside(folder, 'd.svg', DOC));
});

test('hosted guard: a single file opens only itself, plus images beside or below it', () => {
  assert.deepEqual(resolveInside(file, 'a.md', DOC), { full: 'docs/a.md', rel: 'a.md', repo: 'octo/notes', ref: 'main', path: 'docs/a.md' });
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

test('folders to choose from: notes are counted with their sub-folders', () => {
  const paths = ['README.md', 'docs/a.md', 'docs/deep/b.md', 'docs/deep/c.MD', 'docs/pic.svg', 'src/main.rs',
    '.github/x.md', 'node_modules/p/README.md', 'odd[1]/in/d.md', 'notes/-x/e.md', 'week 10/a.md', 'week 2/a.md', 'Zeta/a.md'];
  assert.deepEqual(folderCounts(paths), {
    total: 9,
    folders: [
      { path: 'docs', count: 3 },
      { path: 'docs/deep', count: 2 },
      { path: 'notes', count: 1 },
      { path: 'week 2', count: 1 },
      { path: 'week 10', count: 1 },
      { path: 'Zeta', count: 1 },
    ],
    truncated: false,
  });
});

// ---------- Submodules ----------

const LIB = 'a'.repeat(40);
const INNER = 'b'.repeat(40);
const mounted = {
  ...folder,
  mounts: [
    { path: 'docs/lib', repo: 'octo/lib', ref: LIB },
    { path: 'docs/lib/nested', repo: 'octo/inner', ref: INNER },
  ],
};

test('hosted guard: a path inside a submodule is read from the submodule\'s repository', () => {
  assert.deepEqual(resolveInside(mounted, 'lib/docs/guide.md', DOC), {
    full: 'docs/lib/docs/guide.md', rel: 'lib/docs/guide.md', repo: 'octo/lib', ref: LIB, path: 'docs/guide.md',
  });
  // The deepest submodule wins; beside the submodules it is still the repository itself.
  assert.deepEqual(resolveInside(mounted, 'lib/nested/deep.md', DOC), {
    full: 'docs/lib/nested/deep.md', rel: 'lib/nested/deep.md', repo: 'octo/inner', ref: INNER, path: 'deep.md',
  });
  assert.equal(resolveInside(mounted, 'lib/img/p.svg', IMAGE).repo, 'octo/lib');
  assert.equal(resolveInside(mounted, 'library.md', DOC).repo, 'octo/notes');
  assert.equal(resolveInside(mounted, 'lib/../a.md', DOC).repo, 'octo/notes');
  // A submodule opens nothing above the source, and nothing above itself in its repository.
  assert.throws(() => resolveInside(mounted, 'lib/../../secret.md', DOC));
  assert.throws(() => resolveInside(mounted, '../lib/a.md', DOC));
  assert.equal(resolveInside(mounted, 'lib/x/../../a.md', DOC).path, 'docs/a.md');
  // The source is a folder inside the submodule.
  const inside = { ...mounted, sub: 'docs/lib/docs' };
  assert.deepEqual(resolveInside(inside, 'guide.md', DOC), { full: 'docs/lib/docs/guide.md', rel: 'guide.md', repo: 'octo/lib', ref: LIB, path: 'docs/guide.md' });
  assert.throws(() => resolveInside(inside, '../README.md', DOC));
});

test('hosted guard: a stored submodule that does not name a repository and a commit is not used', () => {
  for (const mount of [
    { path: 'docs/lib', repo: 'octo/lib', ref: 'main' },
    { path: 'docs/lib', repo: 'octo/lib/../../evil', ref: LIB },
    { path: 'docs/lib', repo: 'https://evil.test/x', ref: LIB },
    { path: 'docs/../..', repo: 'octo/lib', ref: LIB },
    { path: 'docs/lib', repo: 'octo/lib' },
    null,
    'docs/lib',
  ]) {
    const at = resolveInside({ ...folder, mounts: [mount] }, 'lib/a.md', DOC);
    assert.deepEqual([at.repo, at.ref, at.path], ['octo/notes', 'main', 'docs/lib/a.md'], JSON.stringify(mount));
  }
  assert.equal(resolveInside({ ...folder, mounts: 'x' }, 'lib/a.md', DOC).repo, 'octo/notes');
});

// GitHub, as far as the list of notes asks it: the tree of a repository at a branch or commit,
// and the text of a file.
function fakeGithub(repos) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const tree = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\/([^?]+)\?recursive=1$/.exec(url);
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(url);
    const repo = repos[(tree || raw)?.[1]];
    const at = repo?.[(tree || raw)[2]];
    if (repo?.status) return new Response('{}', { status: repo.status, headers: repo.headers });
    if (tree && at) return Response.json({ tree: at.tree, truncated: false });
    if (raw && at?.files?.[raw[3]] !== undefined) return new Response(at.files[raw[3]]);
    return new Response('{}', { status: 404 });
  };
  return asked;
}
const blob = (path) => ({ path, type: 'blob', sha: `sha-${path}` });
const dir = (path) => ({ path, type: 'tree', sha: `tree-${path}` });
const link = (path, sha) => ({ path, type: 'commit', sha });
const hub = () => ({
  'octo/notes': {
    main: {
      tree: [blob('.gitmodules'), blob('README.md'), dir('docs'), blob('docs/a.md'), link('docs/lib', LIB), link('docs/away', LIB),
        link('docs/secret', LIB), link('other', LIB), link('.hidden/lib', LIB)],
      files: {
        '.gitmodules': [
          '[submodule "lib"]\n\tpath = docs/lib\n\turl = https://github.com/octo/lib.git',
          '[submodule "away"]\n\tpath = docs/away\n\turl = https://gitlab.com/octo/lib.git',
          '[submodule "secret"]\n\tpath = docs/secret\n\turl = git@github.com:octo/private.git',
          '[submodule "other"]\n\tpath = other\n\turl = ../lib',
          '[submodule "hidden"]\n\tpath = .hidden/lib\n\turl = ../lib',
        ].join('\n'),
      },
    },
  },
  'octo/lib': {
    [LIB]: {
      tree: [blob('.gitmodules'), blob('README.md'), dir('docs'), blob('docs/guide.md'), blob('img/p.svg'), link('nested', INNER)],
      files: { '.gitmodules': '[submodule "in"]\n\tpath = nested\n\turl = ../inner.git\n' },
    },
  },
  'octo/inner': { [INNER]: { tree: [blob('deep.md')] } },
  'octo/private': { status: 404 },
});

test('list of notes: submodules inside the folder are listed where the repository has them', async () => {
  const asked = fakeGithub(hub());
  const got = await fetchFiles({ repo: 'octo/notes', ref: 'main', sub: 'docs', kind: 'folder' });
  assert.deepEqual(Object.keys(got.files).sort(), ['a.md', 'lib/README.md', 'lib/docs/guide.md', 'lib/nested/deep.md']);
  assert.deepEqual(got.mounts, [
    { path: 'docs/lib/nested', repo: 'octo/inner', ref: INNER },
    { path: 'docs/lib', repo: 'octo/lib', ref: LIB },
  ]);
  // Not on GitHub, and not shown by GitHub: left out and named. Outside the folder: not asked for.
  assert.deepEqual(got.skipped, ['docs/away', 'docs/secret']);
  assert.ok(!asked.some((url) => url.includes('gitlab')), 'only GitHub is asked');
  assert.equal(asked.filter((url) => url.includes('/octo/lib/git/trees/')).length, 1, 'the submodule outside the folder is not read');
  // What the guard makes of it.
  const source = { repo: 'octo/notes', ref: 'main', sub: 'docs', kind: 'folder', ...got };
  assert.equal(resolveInside(source, 'lib/nested/deep.md', DOC).repo, 'octo/inner');
});

test('list of notes: the whole repository, a submodule as the source, and a single file', async () => {
  let asked = fakeGithub(hub());
  const whole = await fetchFiles({ repo: 'octo/notes', ref: 'main', sub: '', kind: 'folder' });
  assert.deepEqual(Object.keys(whole.files).sort(), [
    'README.md', 'docs/a.md', 'docs/lib/README.md', 'docs/lib/docs/guide.md', 'docs/lib/nested/deep.md',
    'other/README.md', 'other/docs/guide.md', 'other/nested/deep.md',
  ]);
  assert.deepEqual(whole.mounts.map((m) => m.path), ['docs/lib/nested', 'docs/lib', 'other/nested', 'other']);
  assert.equal(asked.filter((url) => url.includes('/octo/lib/')).length, 2, 'a repository that is a submodule twice is asked for once: its files, its .gitmodules');
  const sub = await fetchFiles({ repo: 'octo/notes', ref: 'main', sub: 'docs/lib/docs', kind: 'folder' });
  assert.deepEqual(sub.files, { 'guide.md': 'sha-docs/guide.md' });
  assert.deepEqual(sub.mounts, [{ path: 'docs/lib', repo: 'octo/lib', ref: LIB }]);
  // A single file reads no submodule at all.
  asked = fakeGithub(hub());
  const one = await fetchFiles({ repo: 'octo/notes', ref: 'main', sub: 'docs/a.md', kind: 'file' });
  assert.deepEqual(one.mounts, []);
  assert.equal(asked.length, 1);
});

test('list of notes: a failure that is not "not found" fails the reading instead of shortening it', async () => {
  const repos = hub();
  repos['octo/lib'] = { status: 403, headers: { 'x-ratelimit-remaining': '0' } };
  fakeGithub(repos);
  await assert.rejects(fetchFiles({ repo: 'octo/notes', ref: 'main', sub: 'docs', kind: 'folder' }), /limit/);
  repos['octo/lib'] = { status: 500 };
  await assert.rejects(fetchFiles({ repo: 'octo/notes', ref: 'main', sub: 'docs', kind: 'folder' }), /500/);
});

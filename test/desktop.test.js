// The desktop app's back end (public/backend.js): local sources go to Tauri commands, GitHub
// sources to web-backend.js, which keeps its list and the token through commands too. Tauri and
// GitHub are stand-ins here; the window itself is not covered.
import test from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = '0123456789abcdef';
const calls = [];
const kept = { sources: [], token: null };
const commands = {
  list_roots: () => [{ id: LOCAL, path: '/notes', name: 'notes', kind: 'folder', github: null, missing: false }],
  get_github_sources: () => kept.sources,
  save_github_sources: ({ sources }) => void (kept.sources = JSON.parse(JSON.stringify(sources))),
  github_token: () => kept.token,
  set_github_token: ({ token }) => void (kept.token = token),
  clear_github_token: () => void (kept.token = null),
  tree: () => ({ nodes: [{ type: 'file', name: 'local.md', path: 'local.md' }], truncated: false }),
  read_doc({ root, path }) {
    if (root !== LOCAL) throw 'Unknown folder.';
    return { path, source: '# from disk' };
  },
  remove_root: () => null,
  watch_doc: () => null,
  unwatch_doc: () => null,
};
globalThis.window = {
  __TAURI__: {
    core: {
      async invoke(command, args) {
        calls.push(command);
        if (!commands[command]) throw `no command ${command}`;
        return commands[command](args || {});
      },
      convertFileSrc: (path, scheme) => `${scheme}://localhost/${path}`,
    },
    event: { listen: async () => () => {} },
  },
};

const asked = [];
const TOKEN = 'ghp_' + 'a'.repeat(36);
globalThis.fetch = async (url, options = {}) => {
  asked.push({ url: String(url), auth: options.headers?.Authorization });
  const at = String(url).replace('https://api.github.com', '').replace('https://raw.githubusercontent.com', 'raw:');
  if (at === '/repos/octo/notes') return Response.json({ default_branch: 'main' });
  if (at === '/repos/octo/notes/git/trees/main?recursive=1') {
    return Response.json({ tree: [{ path: 'docs', type: 'tree', sha: 't' }, { path: 'docs/a.md', type: 'blob', sha: 'one' }, { path: 'docs/p.png', type: 'blob', sha: 'pic' }] });
  }
  if (at === 'raw:/octo/notes/main/docs/a.md') return new Response('# from GitHub');
  if (at === '/repos/octo/notes/contents/docs/a.md?ref=main') return new Response('# with the token');
  if (at === '/user') return Response.json({});
  return new Response('{}', { status: 404 });
};

const { backend } = await import('../public/backend.js');

test('desktop: a GitHub source is kept through a command and read from GitHub, a local one from disk', async () => {
  assert.equal(backend.kind, 'tauri');
  assert.deepEqual((await backend.listRoots()).map((r) => r.id), [LOCAL]);

  const added = await backend.addGithub('octo/notes', 'docs');
  assert.match(added.id, /^w[0-9a-f]{8}$/);
  assert.deepEqual(added.github, { repo: 'octo/notes', ref: 'main', sub: 'docs' });
  assert.equal(kept.sources.length, 1, 'saved in the config file, through Rust');
  assert.deepEqual(kept.sources[0].files, { 'a.md': 'one' });
  assert.deepEqual((await backend.listRoots()).map((r) => r.id), [LOCAL, added.id]);

  calls.length = 0;
  assert.deepEqual(await backend.readDoc(added.id, 'a.md'), { path: 'a.md', source: '# from GitHub' });
  assert.deepEqual((await backend.tree(added.id)).nodes, [{ type: 'file', name: 'a.md', path: 'a.md' }]);
  assert.equal(backend.assetUrl(added.id, 'p.png'), 'https://raw.githubusercontent.com/octo/notes/main/docs/p.png');
  await assert.rejects(backend.readDoc(added.id, '../secret.md'));
  assert.deepEqual(calls, [], 'no command reads a GitHub source');

  assert.deepEqual(await backend.readDoc(LOCAL, 'local.md'), { path: 'local.md', source: '# from disk' });
  assert.equal((await backend.tree(LOCAL)).nodes[0].name, 'local.md');
  assert.equal(backend.assetUrl(LOCAL, 'p.png'), `mdr://localhost/${LOCAL}/p.png`);
  assert.deepEqual(calls, ['read_doc', 'tree']);

  assert.deepEqual(await backend.updateGithub(added.id), { added: [], changed: [], removed: [], skipped: [] });
});

test('desktop: the token is kept by Rust, sent to api.github.com only, and used for images too', async () => {
  const [source] = kept.sources;
  assert.equal(await backend.githubToken(), false);
  await assert.rejects(backend.saveGithubToken('short'), /does not look like/);
  await backend.saveGithubToken(` ${TOKEN}\n`);
  assert.equal(kept.token, TOKEN);
  assert.equal(await backend.githubToken(), true);

  asked.length = 0;
  assert.equal((await backend.readDoc(source.id, 'a.md')).source, '# with the token');
  assert.deepEqual(asked, [{ url: 'https://api.github.com/repos/octo/notes/contents/docs/a.md?ref=main', auth: `Bearer ${TOKEN}` }]);
  assert.equal(backend.assetUrl(source.id, 'p.png'), 'gh-asset?repo=octo%2Fnotes&ref=main&path=docs%2Fp.png');

  await backend.clearGithubToken();
  assert.equal(kept.token, null);
  assert.equal(await backend.githubToken(), false);
  asked.length = 0;
  await backend.readDoc(source.id, 'a.md');
  assert.equal(asked[0].auth, undefined);
});

test('desktop: removing a GitHub source changes the kept list and runs no command on the disk', async () => {
  const [source] = kept.sources;
  calls.length = 0;
  await backend.removeRoot(source.id);
  assert.deepEqual(kept.sources, []);
  assert.deepEqual(calls, ['save_github_sources']);
  await backend.removeRoot(LOCAL);
  assert.deepEqual(calls, ['save_github_sources', 'remove_root']);
  await assert.rejects(backend.readDoc(source.id, 'a.md'), /Unknown folder/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isFolderPath, parseGithubUrl, parseGitmodules, submoduleRepo } from '../public/github-url.js';

const status = (code) => (err) => err.status === code;

test('reads repository, folder and file addresses', () => {
  const whole = { owner: 'octo', repo: 'notes', ref: '', sub: '', kind: 'folder' };
  for (const address of [
    'https://github.com/octo/notes',
    'https://github.com/octo/notes/',
    'https://github.com/octo/notes.git',
    'github.com/octo/notes',
    'git@github.com:octo/notes.git',
    'octo/notes',
    '  https://www.github.com/octo/notes?tab=readme#top ',
  ]) {
    assert.deepEqual(parseGithubUrl(address), whole, address);
  }
  assert.deepEqual(parseGithubUrl('https://github.com/octo/notes/tree/main/docs/week%201'), {
    owner: 'octo', repo: 'notes', ref: 'main', sub: 'docs/week 1', kind: 'folder',
  });
  assert.deepEqual(parseGithubUrl('https://github.com/octo/notes/tree/v1.2'), {
    owner: 'octo', repo: 'notes', ref: 'v1.2', sub: '', kind: 'folder',
  });
  assert.deepEqual(parseGithubUrl('https://github.com/octo/notes/blob/main/docs/a.MD'), {
    owner: 'octo', repo: 'notes', ref: 'main', sub: 'docs/a.MD', kind: 'file',
  });
});

test('refuses other hosts, other file types and unsafe paths', () => {
  for (const address of [
    '',
    null,
    'octo',
    'https://gitlab.com/octo/notes',
    'http://github.com/octo/notes',
    'https://github.com.evil.test/octo/notes',
    'https://user:pw@github.com/octo/notes',
    'https://github.com/octo/notes/issues/3',
    'https://github.com/octo/notes/tree/main/../../etc',
    'https://github.com/octo/notes/tree/main/a/%2e%2e/b',
    'https://github.com/octo/notes/tree/--upload-pack=x/docs',
    'https://github.com/octo/notes/tree/main/-rf',
    'https://github.com/octo/notes/tree/main/a*b',
    'https://github.com/-octo/notes',
    'https://github.com/octo/..',
  ]) {
    assert.throws(() => parseGithubUrl(address), status(400), String(address));
  }
  assert.throws(() => parseGithubUrl('https://github.com/octo/notes/blob/main/docs/a.pdf'), status(403));
  assert.throws(() => parseGithubUrl('https://github.com/octo/notes/blob/main'), status(403));
});

test('a chosen folder is checked like the path of an address', () => {
  for (const good of ['docs', 'docs/week 1', 'a.b/c_d', 'año 1']) assert.ok(isFolderPath(good), good);
  for (const bad of ['', '..', 'docs/..', 'docs//a', '/docs', 'docs/', '-x', 'a/-x', 'a*', 'a\\b', 'a\nb', ' a', null, 'x'.repeat(1001)]) {
    assert.ok(!isFolderPath(bad), String(bad));
  }
});

test('the address of a submodule must name a GitHub repository', () => {
  for (const address of [
    'https://github.com/octo/lib',
    'https://github.com/octo/lib.git',
    'https://GitHub.com/octo/lib.git/',
    'https://www.github.com/octo/lib',
    'git@github.com:octo/lib.git',
    'ssh://git@github.com/octo/lib.git',
    'git://github.com/octo/lib',
    '../lib',
    '../lib.git',
    '../../octo/lib.git',
    '  ../lib\n',
  ]) {
    assert.equal(submoduleRepo('octo/notes', address), 'octo/lib', address);
  }
  assert.equal(submoduleRepo('octo/notes', '../../other/lib'), 'other/lib');
  for (const address of [
    '',
    undefined,
    'octo/lib',
    'lib',
    './lib',
    '../',
    '../..',
    '../../lib',
    '../../../octo/lib',
    '../lib/more',
    '/srv/git/lib.git',
    'file:///srv/git/lib.git',
    'https://gitlab.com/octo/lib.git',
    'http://github.com/octo/lib',
    'https://github.com.evil.test/octo/lib',
    'https://user:pw@github.com/octo/lib',
    'https://github.com/octo',
    'https://github.com/octo/lib/tree/main',
    'https://github.com/octo/lib?x=1',
    'https://github.com/-octo/lib',
    'https://github.com/octo/..',
    '../-lib/../lib x',
    '--upload-pack=touch /tmp/x',
    'ext::sh -c touch% /tmp/x',
  ]) {
    assert.equal(submoduleRepo('octo/notes', address), null, String(address));
  }
  assert.equal(submoduleRepo('not a repository', '../lib'), null);
});

test('.gitmodules: path and address of every submodule', () => {
  const text = [
    '# comment',
    '[submodule "lib"]',
    '\tpath = docs/lib',
    '\turl = https://github.com/octo/lib.git # where it lives',
    '\tbranch = main',
    '[submodule "with space"]',
    '  path = "docs/week 1" ; quoted',
    '  URL=../inner.git',
    '[core]',
    '\tpath = not/a/submodule',
    '\turl = https://github.com/octo/wrong',
    '[submodule "no-address"]',
    '\tpath = docs/x',
    '[submodule "lib"]',
    '\tignore = all',
    '[submodule "split"]',
    '\tpath = docs/split',
    '[submodule "split"]',
    '\turl = ../split',
  ].join('\r\n');
  assert.deepEqual([...parseGitmodules(text)], [
    ['docs/lib', 'https://github.com/octo/lib.git'],
    ['docs/week 1', '../inner.git'],
    ['docs/split', '../split'],
  ]);
  assert.equal(parseGitmodules('').size, 0);
  assert.equal(parseGitmodules(null).size, 0);
  assert.equal(parseGitmodules('path = a\nurl = ../b').size, 0);
});

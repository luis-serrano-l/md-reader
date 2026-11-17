import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubUrl } from '../public/github-url.js';

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

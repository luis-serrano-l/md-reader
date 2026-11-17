import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGithubUrl, saveToken, hasToken, clearToken, gitError, update, discard, dataDir, cloneDir } from '../server/github.js';

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

test('the token is checked, kept private and never echoed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-token-'));
  const config = path.join(dir, 'config.json');
  assert.equal(hasToken(config), false);
  assert.throws(() => saveToken(config, 'short'), status(400));
  assert.throws(() => saveToken(config, 'ghp_has spaces and $(things) in it 123'), status(400));
  assert.throws(() => saveToken(config, undefined), status(400));
  saveToken(config, ' ghp_abcdefghijklmnopqrstuvwxyz0123456789 \n');
  assert.equal(hasToken(config), true);
  assert.equal(fs.statSync(path.join(dir, 'github-token')).mode & 0o777, 0o600);
  const error = gitError("fatal: Authentication failed for 'https://github.com/octo/private.git/'", true);
  assert.equal(error.status, 404);
  assert.doesNotMatch(error.message, /ghp_/);
  clearToken(config);
  assert.equal(hasToken(config), false);
  fs.rmSync(dir, { recursive: true });
});

test('only folders made for downloads are updated or deleted', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-keep-'));
  fs.writeFileSync(path.join(outside, 'keep.md'), 'x');
  const repos = path.join(dataDir(), 'repos');
  for (const dir of [outside, repos, path.join(repos, 'octo'), path.join(repos, 'octo', 'notes'), path.join(repos, 'a', '..', '..', 'x')]) {
    const root = { kind: 'folder', github: { repo: 'octo/notes', ref: 'main', sub: '', dir } };
    await assert.rejects(update(root, path.join(outside, 'config.json')), status(400), dir);
  }
  discard({ github: { repo: 'octo/notes', ref: 'main', sub: '', dir: outside } });
  assert.equal(fs.existsSync(path.join(outside, 'keep.md')), true);
  await assert.rejects(update({ kind: 'folder' }, path.join(outside, 'config.json')), status(400));
  fs.rmSync(outside, { recursive: true });
});

test('the download folder is named the same way as in the desktop app', () => {
  const dir = cloneDir({ owner: 'octo', repo: 'notes', ref: 'main', sub: 'docs', kind: 'folder' });
  assert.equal(dir, path.join(dataDir(), 'repos', 'octo', 'notes', '22f63808a1'));
});

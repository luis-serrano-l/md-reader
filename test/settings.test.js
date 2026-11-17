import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize, variables, shownColor, DEFAULTS, PRESETS } from '../public/settings.js';
import { RootStore } from '../server/roots.js';

test('normalize keeps valid settings and replaces anything else with the default', () => {
  assert.deepEqual(normalize(null), { ...DEFAULTS, colors: {} });
  assert.deepEqual(normalize({ preset: 'dark', body: 'noto-serif', size: 13.2, colors: { paper: '#ABCDEF' } }), {
    preset: 'dark', body: 'noto-serif', head: 'noto-sans', mono: 'fira', size: 13, colors: { paper: '#abcdef' },
  });
  const bad = normalize({
    preset: 'constructor', body: '__proto__', head: 7, mono: ['fira'], size: 400,
    colors: { paper: 'red; background: url(x)', ink: '#12345', evil: '#000000' }, extra: 1,
  });
  assert.deepEqual(bad, { ...DEFAULTS, size: 16, colors: {} });
  for (const size of [null, '', false, 'big']) assert.equal(normalize({ size }).size, DEFAULTS.size);
});

test('the study look sets no property; other choices set only custom properties', () => {
  assert.deepEqual(variables({}), { sheet: {}, ui: {}, scheme: 'light' });
  const v = variables({ preset: 'dark', mono: 'dejavu', size: 12, colors: { heading: '#ff0000' } });
  assert.equal(v.sheet['--paper'], PRESETS.dark.sheet['--paper']);
  assert.equal(v.sheet['--h1'], '#ff0000');
  assert.equal(v.sheet['--h2'], '#ff0000');
  assert.equal(v.sheet['--size-body'], '12pt');
  assert.match(v.sheet['--font-mono'], /DejaVu Sans Mono/);
  assert.ok(v.ui['--desk']);
  assert.equal(v.scheme, 'dark');
  for (const name of [...Object.keys(v.sheet), ...Object.keys(v.ui)]) assert.match(name, /^--[a-z0-9-]+$/);
});

test('a colour control shows the chosen colour, else the look\'s own', () => {
  assert.equal(shownColor({}, 'paper'), '#fbf7ee');
  assert.equal(shownColor({ preset: 'dark' }, 'paper'), PRESETS.dark.sheet['--paper']);
  assert.equal(shownColor({ preset: 'dark', colors: { paper: '#101010' } }, 'paper'), '#101010');
});

test('settings are stored next to the folders and neither overwrites the other', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-settings-'));
  try {
    const file = path.join(dir, 'config.json');
    const notes = path.join(dir, 'notes');
    fs.mkdirSync(notes);
    const store = new RootStore(file);
    assert.deepEqual(store.getSettings(), {});
    store.saveSettings({ preset: 'dark' });
    store.add(notes);
    // Another program (the desktop app) changes the settings while this one is running.
    new RootStore(file).saveSettings({ preset: 'white' });
    fs.mkdirSync(path.join(dir, 'more'));
    store.add(path.join(dir, 'more'));
    const reloaded = new RootStore(file);
    assert.equal(reloaded.list().length, 2);
    assert.deepEqual(reloaded.getSettings(), { preset: 'white' });
    // A folder added by the other program is not lost when this one adds or removes a folder.
    fs.mkdirSync(path.join(dir, 'other'));
    const otherId = new RootStore(file).add(path.join(dir, 'other')).id;
    store.remove(store.list()[0].id);
    assert.deepEqual(new RootStore(file).list().map((r) => r.name), ['more', 'other']);
    assert.ok(store.get(otherId));
    assert.throws(() => store.saveSettings('dark'), (err) => err.status === 400);
    assert.throws(() => store.saveSettings({ x: 'y'.repeat(9000) }), (err) => err.status === 413);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, variables, shownColor, DEFAULTS, PRESETS } from '../public/settings.js';

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

test('a look that colours the shell also colours its buttons, shadows and the status strip', () => {
  for (const [name, look] of Object.entries(PRESETS)) {
    if (!look.ui?.['--ui-bg']) continue;
    for (const key of ['--ui-btn', '--ui-btn-hover', '--ui-shadow', '--ui-scrim']) assert.ok(look.ui[key], `${name} lacks ${key}`);
  }
});

test('every value of a look is a colour, a number or a length', () => {
  const value = /^(#[0-9a-f]{6}([0-9a-f]{2})?|-?\d+(\.\d+)?(em|px|pt)?)$/;
  for (const [name, look] of Object.entries(PRESETS)) {
    for (const [key, text] of [...Object.entries(look.sheet || {}), ...Object.entries(look.ui || {})]) {
      assert.match(text, value, `${name} ${key}`);
    }
  }
});

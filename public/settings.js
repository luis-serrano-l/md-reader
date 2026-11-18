// Fonts and colours of the note. Pure data and functions (no DOM), so the tests can import it.
// A setting only ever becomes a CSS custom property: `variables()` returns the properties to
// set on the sheet (study.css) and on the page (app.css). Nothing else in the app changes.

// Presets. "study" is what the stylesheets say, so it sets nothing.
export const PRESETS = {
  study: { label: 'Study (warm paper)', sheet: {}, ui: {} },
  white: {
    label: 'Plain white',
    sheet: {
      '--paper': '#ffffff', '--ink': '#222222', '--quote-bg': '#f5f5f5', '--code-bg': '#f2f2f2',
      '--pre-bg': '#f6f6f6', '--rule': '#d5d5d5', '--zebra': '#f8f8f8',
    },
    ui: {
      '--ui-bg': '#f6f6f6', '--ui-bg-2': '#ececec', '--ui-line': '#dcdcdc', '--desk': '#e4e4e4',
      '--ui-btn': '#e6e6e6', '--ui-btn-hover': '#d8d8d8', '--ui-shadow': '#0000002b', '--ui-scrim': '#00000066',
    },
  },
  // The study paper at night: three levels (desk, then paper, then the surfaces of code, quotes
  // and tables), soft off-white text, and headings that stand apart from it by brightness as
  // well as by hue. The text is set a little more open, which a serif needs on a dark ground.
  dark: {
    label: 'Dark',
    scheme: 'dark', // the browser's own controls (lists, scroll bars) follow
    sheet: {
      '--paper': '#1c1b18', '--ink': '#d3cec2', '--strong': '#f6f1e6', '--h1': '#f6f1e6', '--h1-rule': '#6fa8e6',
      '--h2': '#8dbdf5', '--h2-rule': '#34455a', '--h3': '#8fd3ae', '--h4': '#e6b577', '--accent': '#8dbdf5',
      '--quote-bg': '#25231d', '--quote-bar': '#d9a441', '--code-bg': '#2a2823', '--code-ink': '#f2a9a0',
      '--pre-bg': '#242320', '--pre-ink': '#dedad0', '--rule': '#3b382f', '--th-bg': '#243140',
      '--th-ink': '#cfe2fb', '--zebra': '#211f1c', '--check-bg': '#22201c', '--check-line': '#7b8696',
      '--sheet-edge': '#2e2c26', '--leading': '1.68', '--tracking': '0.012em',
      '--hl-comment': '#948f82', '--hl-keyword': '#8dbdf5', '--hl-string': '#8fd3ae',
      '--hl-number': '#f2a9a0', '--hl-title': '#e6b577', '--hl-meta': '#c3a6e0',
    },
    ui: {
      '--ui-bg': '#181714', '--ui-bg-2': '#24221e', '--ui-line': '#33312a', '--ui-ink': '#e4dfd3',
      '--ui-muted': '#a39e91', '--ui-accent': '#4f8fd6', '--ui-accent-ink': '#0d0f12', '--ui-accent-hover': '#63a0e4',
      '--ui-active': '#1d2c3f', '--ui-head': '#a9cdf8', '--ui-field': '#22201c', '--desk': '#100f0d',
      '--ui-btn': '#2b2925', '--ui-btn-hover': '#37342e', '--ui-status': '#100f0d',
      '--ui-shadow': '#00000073', '--ui-scrim': '#000000a6', '--danger': '#f2a9a0',
    },
  },
};

// Font choices. Only fonts that are on the machine can be used; each stack ends in a generic
// family, so a missing font falls back instead of breaking.
export const FONTS = {
  body: {
    charter: { label: 'Charter / DejaVu Serif', stack: '"Bitstream Charter", "DejaVu Serif", Georgia, serif' },
    'noto-serif': { label: 'Noto Serif', stack: '"Noto Serif", "DejaVu Serif", Georgia, serif' },
    georgia: { label: 'Georgia / Times', stack: 'Georgia, "Times New Roman", "Liberation Serif", serif' },
    'noto-sans': { label: 'Noto Sans', stack: '"Noto Sans", "DejaVu Sans", sans-serif' },
    system: { label: 'System font', stack: 'system-ui, sans-serif' },
  },
  head: {
    'noto-sans': { label: 'Noto Sans', stack: '"Noto Sans", "DejaVu Sans", sans-serif' },
    system: { label: 'System font', stack: 'system-ui, sans-serif' },
    charter: { label: 'Charter / DejaVu Serif', stack: '"Bitstream Charter", "DejaVu Serif", Georgia, serif' },
    'noto-serif': { label: 'Noto Serif', stack: '"Noto Serif", "DejaVu Serif", Georgia, serif' },
  },
  mono: {
    fira: { label: 'Fira Code', stack: '"Fira Code", "DejaVu Sans Mono", monospace' },
    dejavu: { label: 'DejaVu Sans Mono', stack: '"DejaVu Sans Mono", monospace' },
    system: { label: 'System monospace', stack: 'ui-monospace, monospace' },
  },
};

export const SIZE = { min: 9, max: 16, step: 0.5, default: 11.5 };

// The colours that can be changed one by one, and the properties each one sets.
export const COLORS = {
  paper: { label: 'Paper', vars: ['--paper'] },
  ink: { label: 'Text', vars: ['--ink'] },
  heading: { label: 'Headings', vars: ['--h1', '--h2'] },
  accent: { label: 'Accent (links, list marks)', vars: ['--accent'] },
};

export const DEFAULTS = Object.freeze({ preset: 'study', body: 'charter', head: 'noto-sans', mono: 'fira', size: SIZE.default, colors: {} });

const HEX = /^#[0-9a-f]{6}$/i;

// Whatever was stored (by an older version, by hand, or by another program) becomes a valid
// settings object. Unknown keys and bad values are dropped, never passed on.
export function normalize(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const own = (object, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);
  const pick = (table, value, fallback) => (own(table, value) ? value : fallback);
  const size = typeof input.size === 'number' || (typeof input.size === 'string' && input.size.trim()) ? Number(input.size) : NaN;
  const colors = {};
  const given = input.colors && typeof input.colors === 'object' ? input.colors : {};
  for (const name of Object.keys(COLORS)) {
    if (typeof given[name] === 'string' && HEX.test(given[name])) colors[name] = given[name].toLowerCase();
  }
  return {
    preset: pick(PRESETS, input.preset, DEFAULTS.preset),
    body: pick(FONTS.body, input.body, DEFAULTS.body),
    head: pick(FONTS.head, input.head, DEFAULTS.head),
    mono: pick(FONTS.mono, input.mono, DEFAULTS.mono),
    size: Number.isFinite(size) ? Math.min(SIZE.max, Math.max(SIZE.min, Math.round(size * 2) / 2)) : DEFAULTS.size,
    colors,
  };
}

// The CSS custom properties for a settings object, and the colour scheme of the browser's
// own controls: { sheet: {...}, ui: {...}, scheme: 'light' | 'dark' }.
export function variables(raw) {
  const s = normalize(raw);
  const preset = PRESETS[s.preset];
  const sheet = { ...preset.sheet };
  if (s.body !== DEFAULTS.body) sheet['--font-body'] = FONTS.body[s.body].stack;
  if (s.head !== DEFAULTS.head) sheet['--font-head'] = FONTS.head[s.head].stack;
  if (s.mono !== DEFAULTS.mono) sheet['--font-mono'] = FONTS.mono[s.mono].stack;
  if (s.size !== DEFAULTS.size) sheet['--size-body'] = `${s.size}pt`;
  for (const [name, value] of Object.entries(s.colors)) {
    for (const property of COLORS[name].vars) sheet[property] = value;
  }
  return { sheet, ui: { ...preset.ui }, scheme: preset.scheme || 'light' };
}

// The colour a control shows when the user has not chosen one: the preset's, else the study look's.
const STUDY_COLORS = { paper: '#fbf7ee', ink: '#2b2b2b', heading: '#14365d', accent: '#1d4f8a' };
export function shownColor(raw, name) {
  const s = normalize(raw);
  return s.colors[name] || PRESETS[s.preset].sheet[COLORS[name].vars[0]] || STUDY_COLORS[name];
}

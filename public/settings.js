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
    ui: { '--ui-bg': '#f6f6f6', '--ui-bg-2': '#ececec', '--ui-line': '#dcdcdc', '--desk': '#e4e4e4' },
  },
  // True black everywhere a surface is drawn: on an OLED screen black pixels are off, which
  // gives the most contrast. Only text, thin lines and the hover/selection marks are lit.
  dark: {
    label: 'Dark (true black)',
    scheme: 'dark', // the browser's own controls (lists, scroll bars) follow
    sheet: {
      '--paper': '#000000', '--ink': '#e2dfd7', '--strong': '#ffffff', '--h1': '#9cc4f5', '--h2': '#7fb0ea',
      '--h2-rule': '#2c3a4d', '--h3': '#86c9a6', '--h4': '#d9a86a', '--accent': '#7fb0ea',
      '--quote-bg': '#000000', '--quote-bar': '#b88a2e', '--code-bg': '#000000', '--code-ink': '#f0a3a3',
      '--pre-bg': '#000000', '--pre-ink': '#e2e2e2', '--rule': '#3a3a3a', '--th-bg': '#000000',
      '--th-ink': '#9cc4f5', '--zebra': '#000000', '--check-bg': '#000000', '--check-line': '#6c7684',
      '--sheet-edge': '#262626',
      '--hl-comment': '#8c897d', '--hl-keyword': '#9cc4f5', '--hl-string': '#86c9a6',
      '--hl-number': '#f0a3a3', '--hl-title': '#d9a86a', '--hl-meta': '#b99ad6',
    },
    ui: {
      '--ui-bg': '#000000', '--ui-bg-2': '#1c1c1c', '--ui-line': '#2a2a2a', '--ui-ink': '#e2dfd7',
      '--ui-muted': '#9a968b', '--ui-accent': '#3f78bd', '--ui-accent-hover': '#356aa9',
      '--ui-active': '#12243a', '--ui-head': '#9cc4f5', '--ui-field': '#000000', '--desk': '#000000',
      '--danger': '#f0a3a3',
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

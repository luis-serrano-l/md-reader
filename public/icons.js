// The icons of the shell, drawn as SVG from path data. Built with DOM calls and styled by the
// `.icon` class in app.css (no inline style), so the page's Content-Security-Policy holds.
const NS = 'http://www.w3.org/2000/svg';
const FRAME = 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';
const FOLDER = 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';

// Each icon is one path on a 24 x 24 grid, drawn with a round 1.75 stroke.
const PATHS = {
  'panel-left': `${FRAME}M9 4v16`,
  'panel-right': `${FRAME}M15 4v16`,
  minus: 'M6 12h12',
  plus: 'M12 6v12M6 12h12',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  printer: 'M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.3L20 15.5M20 20v-4.5h-4.5',
  folders: `${FOLDER}M12 11v5M9.5 13.5h5`,
  copy: 'M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  trash: 'M4 7h16M10 4h4M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M10 11v6M14 11v6',
};

export const ICON_NAMES = Object.keys(PATHS);

export function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name] || '');
  svg.append(path);
  return svg;
}

// Puts its icon into an element; the element's text, if any, is replaced.
export function setIcon(node, name) {
  node.dataset.icon = name;
  node.replaceChildren(icon(name));
}

// Every element in the page that names an icon with `data-icon` gets it.
export function fillIcons(within = document) {
  for (const node of within.querySelectorAll('[data-icon]')) node.replaceChildren(icon(node.dataset.icon));
}

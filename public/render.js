// Markdown -> HTML, matching what build-readme.sh produced with pandoc (GFM) plus its Lua filter:
// .svg images get class "diagram" and are kept together with the paragraph that introduces them.
// Raw HTML in the Markdown is not rendered (html: false), so a note cannot inject script.
//
// This file runs in the browser (web version and desktop app) and in Node (tests). It imports
// nothing: the Markdown libraries are passed in, and the caller says how a file inside the
// folder becomes a URL.

export const DOC_EXTS = new Set(['.md']);
export const IMAGE_EXTS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function extname(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

function splitUrl(url) {
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
  return { pathname: m[1], hash: m[3] || '' };
}

function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Resolves a link written in a note against the note's own folder. Returns the path relative to
// the root, or null when it would leave the root.
function resolveRel(docRel, pathname) {
  if (pathname.startsWith('/')) return null;
  const dir = dirname(docRel);
  const parts = dir ? dir.split('/') : [];
  for (const segment of decode(pathname).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/') || null;
}

function addClass(token, name) {
  const current = token.attrGet('class');
  token.attrSet('class', current ? `${current} ${name}` : name);
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

const anchorFor = (hash) => `#h-${slugify(decode(hash.slice(1)))}`;

function plainText(inline) {
  return (inline.children || [])
    .filter((t) => t.type === 'text' || t.type === 'code_inline')
    .map((t) => t.content)
    .join('')
    .trim();
}

function rewriteImage(token, env) {
  const src = token.attrGet('src') || '';
  token.attrSet('loading', 'lazy');
  if (HAS_SCHEME.test(src) || src.startsWith('//')) return;
  const { pathname } = splitUrl(src);
  const rel = resolveRel(env.docRel, pathname);
  const ext = extname(pathname);
  if (!rel || !IMAGE_EXTS.has(ext)) {
    token.attrSet('src', '');
    addClass(token, 'missing');
    return;
  }
  token.attrSet('src', env.assetUrl(rel));
  if (ext === '.svg') addClass(token, 'diagram');
}

function rewriteLink(token, env) {
  const href = token.attrGet('href') || '';
  if (href.startsWith('#')) {
    token.attrSet('href', anchorFor(href));
    return;
  }
  if (HAS_SCHEME.test(href) || href.startsWith('//')) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
    return;
  }
  const { pathname, hash } = splitUrl(href);
  const rel = resolveRel(env.docRel, pathname);
  if (rel && DOC_EXTS.has(extname(rel))) {
    token.attrSet('href', env.docUrl(rel) + (hash ? anchorFor(hash) : ''));
    token.attrSet('data-doc', rel);
    return;
  }
  // Anything else on disk is not a Markdown file: the app does not open it.
  token.attrs = (token.attrs || []).filter(([name]) => name !== 'href');
  addClass(token, 'dead-link');
  token.attrSet('title', 'Not a Markdown file: md-reader does not open it');
}

// Builds the renderer once. `MarkdownIt`, `hljs` and `taskLists` are the markdown-it constructor,
// highlight.js, and the markdown-it-task-lists plugin.
export function createRenderer({ MarkdownIt, hljs, taskLists }) {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {
          /* fall through to plain escaping */
        }
      }
      return '';
    },
  }).use(taskLists, { enabled: false });

  // Heading ids and the outline.
  md.core.ruler.push('mdr_headings', (state) => {
    const used = new Map();
    state.env.toc = [];
    state.tokens.forEach((token, i) => {
      if (token.type !== 'heading_open') return;
      const text = plainText(state.tokens[i + 1]);
      const base = `h-${slugify(text)}`;
      const n = used.get(base) || 0;
      used.set(base, n + 1);
      const id = n ? `${base}-${n + 1}` : base;
      token.attrSet('id', id);
      const level = Number(token.tag.slice(1));
      state.env.toc.push({ level, text, id });
      if (level === 1 && !state.env.title) state.env.title = text;
    });
  });

  // Images and links: relative targets are rewritten to go through the guarded routes.
  md.core.ruler.push('mdr_urls', (state) => {
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      for (const token of block.children) {
        if (token.type === 'image') rewriteImage(token, state.env);
        else if (token.type === 'link_open') rewriteLink(token, state.env);
      }
    }
  });

  // A paragraph that is only a diagram is wrapped together with the paragraph or heading before it.
  md.core.ruler.push('mdr_diagram_blocks', (state) => {
    const tokens = state.tokens;
    const isDiagramPara = (i) =>
      tokens[i].type === 'paragraph_open' &&
      tokens[i].level === 0 &&
      tokens[i + 1]?.children?.length === 1 &&
      tokens[i + 1].children[0].type === 'image' &&
      (tokens[i + 1].children[0].attrGet('class') || '').split(' ').includes('diagram');
    for (let i = tokens.length - 3; i >= 0; i--) {
      if (!isDiagramPara(i)) continue;
      const prev = tokens[i - 1];
      const leadIn = prev && prev.level === 0 && (prev.type === 'paragraph_close' || prev.type === 'heading_close');
      const start = leadIn ? i - 3 : i;
      const open = new state.Token('html_block', '', 0);
      open.content = '<div class="diagram-block">\n';
      const close = new state.Token('html_block', '', 0);
      close.content = '</div>\n';
      tokens.splice(i + 3, 0, close);
      tokens.splice(start, 0, open);
    }
  });

  // Column alignment as a class instead of an inline style, so the page can forbid inline styles.
  for (const rule of ['th_open', 'td_open']) {
    md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const align = /text-align:\s*(left|right|center)/.exec(token.attrGet('style') || '');
      if (token.attrs) token.attrs = token.attrs.filter(([name]) => name !== 'style');
      if (align) addClass(token, `align-${align[1]}`);
      return self.renderToken(tokens, idx, options);
    };
  }

  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';

  // docRel: the note's path inside its folder. assetUrl(rel) and docUrl(rel) turn the path of an
  // image or of another note (both relative to the folder) into a URL.
  return function render(source, { docRel, assetUrl, docUrl }) {
    const env = { docRel, assetUrl, docUrl };
    const html = md.render(source, env);
    const name = docRel.slice(docRel.lastIndexOf('/') + 1);
    return { title: env.title || name.replace(/\.[^.]+$/, ''), html, toc: env.toc };
  };
}

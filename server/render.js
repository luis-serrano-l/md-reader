// Markdown -> HTML, matching what build-readme.sh produced with pandoc (GFM) plus its Lua filter:
// .svg images get class "diagram" and are kept together with the paragraph that introduces them.
// Raw HTML in the Markdown is not rendered (html: false), so a note cannot inject script.
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js/lib/common';
import { DOC_EXTS, IMAGE_EXTS } from './roots.js';

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

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function splitUrl(url) {
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
  return { pathname: m[1], hash: m[3] || '' };
}

// Resolves a link written in a note against the note's own folder. Returns the path relative to
// the root, or null when it would leave the root.
function resolveRel(docRel, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(docRel), decoded));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return null;
  return joined;
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

function plainText(inline) {
  return (inline.children || [])
    .filter((t) => t.type === 'text' || t.type === 'code_inline')
    .map((t) => t.content)
    .join('')
    .trim();
}

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
  const { rootId, docRel } = state.env;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    for (const token of block.children) {
      if (token.type === 'image') rewriteImage(token, rootId, docRel);
      else if (token.type === 'link_open') rewriteLink(token, rootId, docRel);
    }
  }
});

function rewriteImage(token, rootId, docRel) {
  const src = token.attrGet('src') || '';
  token.attrSet('loading', 'lazy');
  if (HAS_SCHEME.test(src) || src.startsWith('//')) return;
  const { pathname } = splitUrl(src);
  const rel = pathname.startsWith('/') ? null : resolveRel(docRel, pathname);
  const ext = path.posix.extname(pathname).toLowerCase();
  if (!rel || !IMAGE_EXTS.has(ext)) {
    token.attrSet('src', '');
    addClass(token, 'missing');
    return;
  }
  token.attrSet('src', `/asset?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(rel)}`);
  if (ext === '.svg') addClass(token, 'diagram');
}

function rewriteLink(token, rootId, docRel) {
  const href = token.attrGet('href') || '';
  if (href.startsWith('#')) {
    token.attrSet('href', `#h-${slugify(decodeURIComponent(href.slice(1)))}`);
    return;
  }
  if (HAS_SCHEME.test(href) || href.startsWith('//')) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
    return;
  }
  const { pathname, hash } = splitUrl(href);
  const rel = pathname.startsWith('/') ? null : resolveRel(docRel, pathname);
  if (rel && DOC_EXTS.has(path.posix.extname(rel).toLowerCase())) {
    const anchor = hash ? `#h-${slugify(decodeURIComponent(hash.slice(1)))}` : '';
    token.attrSet('href', `/?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(rel)}${anchor}`);
    token.attrSet('data-doc', rel);
    return;
  }
  // Anything else on disk is not a Markdown file: the app does not open it.
  token.attrs = (token.attrs || []).filter(([name]) => name !== 'href');
  addClass(token, 'dead-link');
  token.attrSet('title', 'Not a Markdown file: md-reader does not open it');
}

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

export function renderMarkdown(source, { rootId, docRel }) {
  const env = { rootId, docRel };
  const html = md.render(source, env);
  return {
    title: env.title || path.posix.basename(docRel, path.posix.extname(docRel)),
    html,
    toc: env.toc,
  };
}

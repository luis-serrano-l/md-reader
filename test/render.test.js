import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../server/render.js';

const render = (src, docRel = 'notes/p3l1.md') => renderMarkdown(src, { rootId: 'r1', docRel });

test('title, heading ids and outline', () => {
  const { title, toc, html } = render('# P3L1: scheduling\n\n## Part 1 — What\n\n## Part 1 — What\n');
  assert.equal(title, 'P3L1: scheduling');
  assert.deepEqual(toc.map((h) => h.id), ['h-p3l1-scheduling', 'h-part-1-what', 'h-part-1-what-2']);
  assert.match(html, /<h2 id="h-part-1-what">/);
});

test('title falls back to the file name', () => {
  assert.equal(render('text only', 'sub/my-note.md').title, 'my-note');
});

test('GFM tables, with alignment as a class and no inline style', () => {
  const { html } = render('| a | b |\n|---|--:|\n| 1 | 2 |\n');
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /<td class="align-right">2<\/td>/);
  assert.doesNotMatch(html, /style=/);
});

test('relative images go through /asset; svg becomes a diagram kept with its lead-in', () => {
  const { html } = render('Lead in.\n\n![alt](diagrams/x.svg)\n\nAfter.\n');
  assert.match(html, /src="\/asset\?root=r1&amp;path=notes%2Fdiagrams%2Fx\.svg"/);
  assert.match(html, /<div class="diagram-block">\n<p>Lead in\.<\/p>\n<p><img [^>]*class="diagram"[^>]*><\/p>\n<\/div>/);
  assert.match(html, /<\/div>\n<p>After\.<\/p>/);
});

test('images outside the folder or of another type are dropped', () => {
  assert.match(render('![x](../../etc/passwd.png)', 'a.md').html, /src=""/);
  assert.match(render('![x](/etc/x.png)').html, /src=""/);
  assert.match(render('![x](notes.pdf)').html, /src=""/);
});

test('links: other notes open in the app, other files are inert, web links open in a new tab', () => {
  const { html } = render('[n](../other/b.md#Part-2) [p](a-study.pdf) [w](https://example.com) [s](#Part 1)'.replace('#Part 1', '#part-1'));
  assert.match(html, /href="\/\?root=r1&amp;path=other%2Fb\.md#h-part-2" data-doc="other\/b\.md"/);
  assert.match(html, /<a class="dead-link" title="[^"]+">p<\/a>/);
  assert.match(html, /href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="#h-part-1"/);
});

test('raw HTML and script URLs in a note are not rendered', () => {
  const { html } = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
  assert.doesNotMatch(html, /<script|<img|href="javascript/);
});

test('code blocks are highlighted when the language is known', () => {
  const { html } = render('```c\nint main(void) { return 0; }\n```\n');
  assert.match(html, /<pre><code class="language-c">.*hljs-/s);
});

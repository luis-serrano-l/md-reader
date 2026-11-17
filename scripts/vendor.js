// Copies the browser builds of the Markdown libraries into public/vendor/, so the front end
// needs no bundler and the desktop app needs no Node. Run after changing a library version:
//   npm run vendor
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  'markdown-it.min.js': 'node_modules/markdown-it/dist/markdown-it.min.js',
  'highlight.min.js': 'node_modules/@highlightjs/cdn-assets/highlight.min.js',
};
fs.mkdirSync(path.join(root, 'public/vendor'), { recursive: true });
// markdown-it-task-lists ships a stale browser build (2.1.0), so wrap the same index.js the
// tests use. It is one CommonJS file with no require().
const taskLists = fs.readFileSync(path.join(root, 'node_modules/markdown-it-task-lists/index.js'), 'utf8');
if (/\brequire\(/.test(taskLists)) throw new Error('markdown-it-task-lists now needs require(); update scripts/vendor.js');
const wrapped = `(function () {\nvar module = { exports: {} };\n${taskLists}\nwindow.markdownitTaskLists = module.exports;\n})();\n`;
fs.writeFileSync(path.join(root, 'public/vendor/markdown-it-task-lists.min.js'), wrapped);
console.log(`public/vendor/markdown-it-task-lists.min.js  ${(wrapped.length / 1024).toFixed(0)} kB`);
for (const [name, source] of Object.entries(files)) {
  // Source-map comments point at files that are not shipped; drop them.
  const text = fs.readFileSync(path.join(root, source), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
  fs.writeFileSync(path.join(root, 'public/vendor', name), text);
  console.log(`public/vendor/${name}  ${(text.length / 1024).toFixed(0)} kB`);
}

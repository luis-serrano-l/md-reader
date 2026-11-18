// Pages view: cuts the rendered note into Letter-size pages, like the PDF.
//
// paginate(sheet) moves the blocks of the note into <section class="page"> elements, one after
// the other, measuring as it goes. A block that does not fit in what is left of the page is
// split when it can be split well (a paragraph or code block between two lines, a list between
// two items, a table between two rows, with its header row repeated), otherwise it starts the
// next page. A heading is never left alone at the bottom of a page. Nothing is dropped: the
// text of the pages, read in order, is the text of the note (repeated table headers aside).

const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const INLINE_BLOCKS = new Set(['P', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const CONTAINERS = new Set(['UL', 'OL', 'BLOCKQUOTE', 'LI']);
const BLOCK_TAGS = new Set(['P', 'PRE', 'UL', 'OL', 'BLOCKQUOTE', 'DIV', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR']);
// Fewer lines than this are not left behind at the bottom of a page or carried to the next.
const MIN_LINES = 2;

const bottomOf = (node) => node.getBoundingClientRect().bottom;

// A copy of the element without its content, to hold the part that goes to the next page.
function continuation(element) {
  const rest = element.cloneNode(false);
  rest.removeAttribute('id'); // the id stays with the first part, where links should land
  rest.classList.add('cont');
  return rest;
}

// Splits a block of running text between two lines. Returns the part after the split (not yet
// in the document), or null when it should not or cannot be split.
function splitInline(block, limit, force) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const texts = [];
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    texts.push({ node, start: total });
    total += node.data.length;
  }
  if (total < 2) return null;
  const place = (offset) => {
    let lo = 0;
    let hi = texts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (texts[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [texts[lo].node, offset - texts[lo].start];
  };
  const range = document.createRange();
  range.setStart(block, 0);
  // The bottom edge of the text from the start of the block up to character `offset`.
  const bottomAt = (offset) => {
    range.setEnd(...place(offset));
    const rects = range.getClientRects();
    let bottom = -Infinity;
    for (const rect of rects) if (rect.width || rect.height) bottom = Math.max(bottom, rect.bottom);
    return bottom;
  };
  // Largest offset whose text still ends above the limit. It falls where a line wraps.
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bottomAt(mid) <= limit + 0.5) lo = mid;
    else hi = mid - 1;
  }
  if (lo <= 0 || lo >= total) return null;
  if (!force) {
    const style = getComputedStyle(block);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    const box = block.getBoundingClientRect();
    const zoom = box.height / (block.offsetHeight || box.height) || 1;
    const kept = (bottomAt(lo) - box.top) / (line * zoom);
    const carried = (box.bottom - bottomAt(lo)) / (line * zoom);
    if (kept < MIN_LINES - 0.3 || carried < MIN_LINES - 0.3) return null;
  }
  const tail = document.createRange();
  tail.setStart(...place(lo));
  tail.setEnd(block, block.childNodes.length);
  const rest = continuation(block);
  rest.append(tail.extractContents());
  // A line break left at the cut would open the next page with an empty line.
  const first = rest.firstChild;
  if (first?.nodeType === Node.TEXT_NODE && block.tagName !== 'PRE') first.data = first.data.replace(/^\s+/, '');
  if (!rest.textContent.trim()) {
    block.append(...rest.childNodes);
    return null;
  }
  return rest;
}

// Splits a list, a quote or a list item between two of its child blocks; the child that
// crosses the limit is itself split when possible.
function splitContainer(element, limit, force) {
  const children = [...element.children].filter((child) => child.tagName !== 'INPUT');
  const crossing = children.findIndex((child) => bottomOf(child) > limit + 0.5);
  if (crossing < 0) return null;
  const child = children[crossing];
  // A list item's own text comes before its nested blocks; if that text crosses, do not split.
  if (element.tagName === 'LI') {
    if (!BLOCK_TAGS.has(child.tagName)) return null;
    const firstBlock = children.find((c) => BLOCK_TAGS.has(c.tagName));
    const lead = document.createRange();
    lead.setStart(element, 0);
    lead.setEndBefore(firstBlock);
    for (const rect of lead.getClientRects()) if (rect.bottom > limit + 0.5) return null;
  }
  const part = splitBlock(child, limit, force && crossing === 0);
  if (!part && crossing === 0) return null;
  const rest = continuation(element);
  if (part) rest.append(part);
  const moved = [];
  for (let node = part ? child.nextSibling : child; node; node = node.nextSibling) moved.push(node);
  rest.append(...moved);
  if (element.tagName === 'OL') {
    // Numbering goes on. A split item keeps its number on the first page only.
    const kept = [...element.children].filter((li) => li.tagName === 'LI').length;
    const start = (Number(element.getAttribute('start')) || 1) + kept - (part ? 1 : 0);
    rest.setAttribute('start', String(start));
  }
  // A list or quote that goes on with a whole item is not marked: only a cut item is.
  if (!part && element.tagName !== 'LI') rest.classList.remove('cont');
  return rest;
}

// Splits a table between two rows and repeats its header row.
function splitTable(wrap, limit) {
  const table = wrap.tagName === 'TABLE' ? wrap : wrap.querySelector(':scope > table');
  const body = table?.tBodies[0];
  if (!body) return null;
  const rows = [...body.rows];
  const crossing = rows.findIndex((row) => bottomOf(row) > limit + 0.5);
  if (crossing <= 0) return null; // the header alone must not stay behind
  const restTable = table.cloneNode(false);
  if (table.tHead) {
    const head = table.tHead.cloneNode(true);
    head.classList.add('repeated');
    restTable.append(head);
  }
  const restBody = body.cloneNode(false);
  // Keeps the striping of the rows as it was (see study.css).
  if (crossing % 2 === 1) restBody.classList.toggle('odd-start', !body.classList.contains('odd-start'));
  else restBody.classList.toggle('odd-start', body.classList.contains('odd-start'));
  restBody.append(...rows.slice(crossing));
  restTable.append(restBody);
  if (wrap === table) return restTable;
  const rest = continuation(wrap);
  rest.append(restTable);
  return rest;
}

// Returns the part of `block` that goes to the next page, or null to move the block whole.
function splitBlock(block, limit, force = false) {
  const tag = block.tagName;
  if (block.classList.contains('diagram-block')) return null;
  if (tag === 'TABLE' || block.classList.contains('table-wrap')) return splitTable(block, limit);
  if (INLINE_BLOCKS.has(tag)) return HEADINGS.has(tag) && !force ? null : splitInline(block, limit, force);
  if (tag === 'LI') {
    const hasBlocks = [...block.children].some((child) => BLOCK_TAGS.has(child.tagName));
    return hasBlocks ? splitContainer(block, limit, force) : splitInline(block, limit, force);
  }
  if (CONTAINERS.has(tag)) return splitContainer(block, limit, force);
  return null;
}

function newPage(sheet) {
  const body = document.createElement('div');
  body.className = 'page-body';
  const page = document.createElement('section');
  page.className = 'page';
  page.append(body);
  sheet.append(page);
  return body;
}

// Rebuilds the sheet as pages. Returns the number of pages.
export function paginate(sheet) {
  const queue = [...sheet.childNodes].filter((node) => node.nodeType === Node.ELEMENT_NODE);
  sheet.replaceChildren();
  sheet.classList.add('paged');
  if (!queue.length) return 0;
  let body = newPage(sheet);
  // The page body has the height of the text area while it is empty; that is the limit.
  let limit = bottomOf(body);
  let guard = queue.length * 50 + 1000;
  while (queue.length && guard-- > 0) {
    const block = queue.shift();
    body.append(block);
    if (bottomOf(block) <= limit + 0.5) continue;
    // Alone on its page, or only headings before it: a new page would not give it more room.
    const alone = [...body.children].slice(0, -1).every((node) => HEADINGS.has(node.tagName));
    const rest = splitBlock(block, limit, alone);
    if (rest) queue.unshift(rest);
    else if (!alone) {
      // Start the next page with this block, and take along the headings that introduce it.
      const moved = [block];
      block.remove();
      while (body.children.length > 1 && HEADINGS.has(body.lastElementChild.tagName)) {
        moved.unshift(body.lastElementChild);
        body.lastElementChild.remove();
      }
      queue.unshift(...moved);
    } // else: taller than a page and cannot be split; the page grows to hold it
    if (!queue.length) break;
    body = newPage(sheet);
    limit = bottomOf(body);
  }
  if (queue.length) body.append(...queue); // never drop content, whatever happened above
  return sheet.children.length;
}

// The page that holds the line `at` of the window, counted from 1: a height where the pages
// are stacked, a distance from the left where they lie side by side (`sideways`).
export function currentPage(sheet, at, sideways = false) {
  const pages = sheet.children;
  let current = 1;
  for (let i = 0; i < pages.length; i++) {
    const box = pages[i].getBoundingClientRect();
    if ((sideways ? box.left : box.top) <= at) current = i + 1;
    else break;
  }
  return current;
}

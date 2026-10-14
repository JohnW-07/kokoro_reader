// The block editor in the notes column, seen from outside: what notes_editor.mjs and its
// cases read off the page and the gestures they make on it.

import { BASE_URL } from './harness.mjs';

export const LOAD_TIMEOUT_MS = 90000;
export const STEP_TIMEOUT_MS = 30000;
const SAVE_TIMEOUT_MS = 15000;
export const SETTLE_MS = 400;
const TYPE_DELAY_MS = 12;
export const DRAG_STEPS = 12;
export const EDGE_INSET_PX = 3;
const MIN_SPAN_CHARS = 30;
const MIN_SPAN_WIDTH_PX = 200;
const VIEW_MARGIN_PX = 120;
export const SLASH_COMMAND_COUNT = 11;   // blocks.js SLASH_COMMANDS

export const blocks = (page) => page.$$eval('#notes-column .ne-block', (els) => els.map((el) => ({
  type: el.dataset.type,
  text: el.querySelector('.ne-text')?.textContent ?? '',
  checked: el.querySelector('.ne-check')?.getAttribute('aria-checked') === 'true',
})));

export const menuItems = (page) => page.$$eval('#notes-column .ne-slash-item', (els) => els.map((el) => ({
  id: el.dataset.command,
  label: el.querySelector('.ne-slash-label').textContent,
  selected: el.getAttribute('aria-selected') === 'true',
})));

export const savedState = (page) => page.$eval('#notes-column .ne-status', (el) => el.textContent);

export const waitForSaved = (page) => page.waitForFunction(
  () => document.querySelector('#notes-column .ne-status')?.textContent === 'Saved',
  null, { timeout: SAVE_TIMEOUT_MS },
);

/** Just inside the right edge of block `index`: a click there puts the caret at its end. */
export async function blockEnd(page, index) {
  const box = await (await page.$$('#notes-column .ne-text'))[index].boundingBox();
  return { x: box.x + Math.max(0, box.width - EDGE_INSET_PX), y: box.y + box.height / 2 };
}

/** Put the caret at the end of block `index` by clicking just inside its right edge. */
export async function focusBlock(page, index) {
  const { x, y } = await blockEnd(page, index);
  await page.mouse.click(x, y);
}

/** After the next animation frame, which is when the margin layout places the notes a render drew. */
const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => resolve()); }));

/**
 * Keys that land before the next frame, made certain: animation frames queue up instead of
 * running until `releaseFrames`, which runs them and then waits one real frame.
 */
export const holdFrames = (page) => page.evaluate(() => {
  const queue = new Map();
  let ids = 0;
  window.__frames = { queue, raf: window.requestAnimationFrame, caf: window.cancelAnimationFrame };
  window.requestAnimationFrame = (cb) => { ids -= 1; queue.set(ids, cb); return ids; };
  window.cancelAnimationFrame = (id) => (id < 0 ? queue.delete(id) : window.__frames.caf.call(window, id));
});
export async function releaseFrames(page) {
  await page.evaluate(() => {
    const { queue, raf, caf } = window.__frames;
    Object.assign(window, { requestAnimationFrame: raf, cancelAnimationFrame: caf });
    delete window.__frames;
    for (const cb of queue.values()) cb(performance.now());
  });
  await nextFrame(page);
}

/**
 * A real click on the column's empty space: well below the last block, or at (`x`, `y`). The rows
 * are measured once they are placed: until then a note sits at the column's top, and a spot read
 * off that lands on one of its rows when the click comes after the layout.
 */
export async function clickEmptySpace(page, { x, y } = {}) {
  await nextFrame(page);
  const spot = await page.evaluate(() => {
    const col = document.querySelector('#notes-column').getBoundingClientRect();
    const texts = [...document.querySelectorAll('#notes-column .ne-text')];
    const last = texts.at(-1).getBoundingClientRect();
    return { x: col.left + col.width / 2, y: Math.min(col.bottom - 40, last.bottom + 200) };
  });
  await page.mouse.click(x ?? spot.x, y ?? spot.y);
  await page.waitForTimeout(SETTLE_MS);
}

/** Which block (index) holds focus, or -1. */
export const focusedBlock = (page) => page.evaluate(() => [...document.querySelectorAll('#notes-column .ne-text')]
  .indexOf(document.activeElement));

/** Where the margin notes are drawn: each one's viewport top, the first one's anchor, the column's own scroll. */
export const notePlaces = (page) => page.evaluate(() => {
  const doc = document.querySelector('#notes-column .ne-doc');
  const notes = [...doc.querySelectorAll('.ne-note')];
  const wrap = window.kokoro.pdfView.pageWrapEl(Number(notes[0].dataset.page))?.getBoundingClientRect();
  return {
    scrollTop: doc.scrollTop,
    tops: notes.map((note) => note.getBoundingClientRect().top),
    anchor: wrap ? wrap.top + (Number(notes[0].dataset.y) || 0) * wrap.height : doc.getBoundingClientRect().top,
  };
});

/** Pick a menu entry with a real mouse click. */
export async function clickMenuItem(page, id) {
  const box = await (await page.$(`#notes-column .ne-slash-item[data-command="${id}"]`)).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Where the open menu sits: fully on screen and inside the column, and do clicks on its first/last item reach it? */
export const menuPlacement = (page) => page.evaluate(() => {
  const menu = document.querySelector('#notes-column .ne-slash');
  if (!menu || menu.hidden) return null;
  const r = menu.getBoundingClientRect();
  const col = document.querySelector('#notes-column').getBoundingClientRect();
  const hits = [menu.firstElementChild, menu.lastElementChild].every((item) => {
    const b = item.getBoundingClientRect();
    return item.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
  });
  const inside = r.top >= Math.max(0, col.top) && r.bottom <= Math.min(innerHeight, col.bottom)
    && r.height > 0;
  const row = menu.parentElement.getBoundingClientRect();
  return { inside, hits, above: r.bottom <= row.top, rect: [r.top, r.bottom].map(Math.round), vh: innerHeight };
});
export const placedWell = (placed) => Boolean(placed?.inside && placed.hits);

export const type = (page, text) => page.keyboard.type(text, { delay: TYPE_DELAY_MS });

/** Fire a paste at the focused block, carrying the given clipboard parts. */
export const paste = (page, parts) => page.evaluate((data) => {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: (kind) => data[kind] ?? '' } });
  document.activeElement.dispatchEvent(event);
}, parts);

export const hasMarkup = (page) => page.evaluate(() => ({
  img: document.querySelectorAll('#notes-column img').length,
  bold: document.querySelectorAll('#notes-column .ne-text b').length,
  ran: window.__xss !== undefined,
}));

export async function openPaper(page, path) {
  await page.goto(BASE_URL);
  await page.setInputFiles('#file-input', path);
  await page.waitForFunction(() => !document.getElementById('ppBtn').disabled, null, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelectorAll('.pdf-page-wrap[data-page="1"] .textLayer > span').length > 0,
    null, { timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('#notes-column .ne-doc')?.hidden === false,
    null, { timeout: STEP_TIMEOUT_MS });
}

/** Drag across the first long line of page 1 and highlight it. Returns its first two words. */
export async function makeHighlight(page, color) {
  const line = await page.evaluate(({ minChars, minWidth, margin }) => {
    const spans = [...document.querySelectorAll('.pdf-page-wrap[data-page="1"] .textLayer > span')]
      .map((s) => ({ text: s.textContent, r: s.getBoundingClientRect() }))
      .filter(({ text, r }) => text.trim().length >= minChars && r.width >= minWidth
        && r.top > margin && r.bottom < innerHeight - margin);
    const hit = spans[0];
    return hit ? { text: hit.text, left: hit.r.left, top: hit.r.top, width: hit.r.width, height: hit.r.height } : null;
  }, { minChars: MIN_SPAN_CHARS, minWidth: MIN_SPAN_WIDTH_PX, margin: VIEW_MARGIN_PX });
  if (!line) return null;

  const from = { x: line.left + EDGE_INSET_PX, y: line.top + line.height / 2 };
  const to = { x: line.left + line.width - EDGE_INSET_PX, y: line.top + line.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= DRAG_STEPS; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / DRAG_STEPS, to.y);
  }
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
  if (!(await page.$('.hl-toolbar.is-open'))) return null;
  await page.click(`.hl-toolbar.is-open .hl-swatch[data-color="${color}"]`);
  await page.waitForTimeout(SETTLE_MS);
  return line.text.trim().split(/\s+/).slice(0, 2).join(' ');
}

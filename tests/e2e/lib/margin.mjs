// The margin notes, seen from outside: where each note is drawn against where its anchor is,
// and the gestures margin_notes.mjs and its cases make on the paper and the column.

import { BASE_URL, VIEWPORT, must, requireEnv } from './harness.mjs';

export const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const LOAD_TIMEOUT_MS = 90000;
const STEP_TIMEOUT_MS = 30000;
export const SETTLE_MS = 400;
export const PANEL_MS = 600;
const TYPE_DELAY_MS = 12;
export const EDGE_INSET_PX = 3;
/** The brief's tolerance: a note sits beside its anchor to within this. */
export const DRIFT_PX = 8;
export const GAP_PX = 10;             // anchors.js NOTE_GAP_PX
const MIN_SPAN_CHARS = 12;
const MIN_SPAN_WIDTH_PX = 80;
export const VIEW_MARGIN_PX = 60;     // keep clear of the floating corner cluster and the toolbar
const DRAG_STEPS = 8;
const HL_COLOR = 'yellow';
const PREF_KEY = 'kokoro.prefs.v2';
export const NOTE_A = 'the estimator is biased here';
export const NOTE_B = 'and this line is the reason why';
export const FAR_SCROLL_PX = 2600;    // far enough to be reading another page of the paper

export async function openPaper(page) {
  await page.goto(BASE_URL);
  await page.setInputFiles('#file-input', PDF);
  await page.waitForFunction(() => !document.getElementById('ppBtn').disabled, null, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelectorAll('.pdf-page-wrap[data-page="1"] .textLayer > span').length > 0,
    null, { timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('#notes-column .ne-doc')?.hidden === false,
    null, { timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
}

// ── What the window actually looks like ──────────────────────────────────────

/**
 * Every note, where it is pinned, where it is drawn, and how far that is from where
 * its anchor is on screen right now. `drift` is the number the ±8px claim is made of.
 */
export const layout = (page) => page.evaluate(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const anchorTop = (pageNo, y) => {
    const wrap = document.querySelector(`.pdf-page-wrap[data-page="${pageNo}"]`);
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect();
    return r.top + y * r.height;
  };
  // R3: an anchor on screen but above the notes (behind the Highlights section) is drawn at their top edge.
  const docTop = document.querySelector('#notes-column .ne-doc')?.getBoundingClientRect().top ?? 0;
  const shown = (at) => (at !== null && at >= 0 && at < docTop ? docTop : at);
  const notes = [...document.querySelectorAll('#notes-column .ne-note')].map((note) => {
    const pageNo = Number(note.dataset.page) || 0;
    const y = Number(note.dataset.y) || 0;
    const want = pageNo ? shown(anchorTop(pageNo, y)) : null;
    const b = box(note);
    return {
      page: pageNo,
      y,
      text: note.textContent,
      box: b,
      positioned: getComputedStyle(note).position,
      want,
      drift: want === null ? null : b.top - want,
    };
  });
  const doc = document.querySelector('#notes-column .ne-doc');
  const caretRow = document.activeElement?.closest?.('.ne-block');
  return {
    notes,
    caret: caretRow ? { box: box(caretRow), text: caretRow.textContent } : null,
    docBox: doc ? box(doc) : null,
    docScroll: doc ? doc.scrollTop : 0,
    readingPage: window.kokoro.pdfView.currentPage(),
    sections: [...document.querySelectorAll('#notes-column .ne-section')].map((s) => s.textContent),
    highlights: [...document.querySelectorAll('.hl-rect')].map((r) => ({ id: r.dataset.hlId, box: box(r) })),
    view: window.kokoro.state.get().notesView,
    zoom: window.kokoro.state.get().zoom,
    scrollTop: document.getElementById('content-area').scrollTop,
    shown: document.querySelector('#notes-view [aria-checked="true"]')?.dataset.view || '',
    columnScroll: document.getElementById('notes-column').scrollHeight
      - document.getElementById('notes-column').clientHeight,
  };
});

export const prefs = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), PREF_KEY);

/** The worst |drift| over the notes that nothing is stacked on top of. */
export function worstDrift(notes) {
  let floor = -Infinity;
  let worst = 0;
  for (const note of notes) {
    if (note.drift === null) continue;
    if (note.want >= floor) worst = Math.max(worst, Math.abs(note.drift));
    floor = note.box.bottom + GAP_PX;
  }
  return worst;
}

/** A real press-move-release, so the engine builds a live text selection. */
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= DRAG_STEPS; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / DRAG_STEPS, from.y + ((to.y - from.y) * i) / DRAG_STEPS);
  }
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Wait until page `n`'s text layer has finished rendering — after a far scroll or a zoom it is
 * repainted lazily, and an empty layer reads as "no lines". A span counts only once the viewer
 * has registered it, which pdfview.js does after renderTextLayer lands. Logs the wait in ms.
 */
async function textLayerReady(page, n) {
  const start = Date.now();
  await page.waitForFunction((k) => {
    const span = document.querySelector(`.pdf-page-wrap[data-page="${k}"] .textLayer span:not(.markedContent)`);
    return Boolean(span) && window.kokoro.pdfView.itemIndexOf(k, span) >= 0;
  }, n, { timeout: STEP_TIMEOUT_MS }).catch((err) => {
    throw new Error(`page ${n}'s text layer never rendered: ${err.message}`);
  });
  console.log(`  wait  page ${n} text layer ready after ${Date.now() - start}ms`);
}

/** The lines of one page that are on screen and long enough to drag a selection across. */
export async function spansOnScreen(page, pageNo = 1) {
  await textLayerReady(page, pageNo);
  return page.evaluate(({ minChars, minWidth, margin, pageNo: n }) =>
    [...document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`)]
      .map((el) => ({ r: el.getBoundingClientRect(), text: el.textContent }))
      .filter(({ text, r }) => text.trim().length >= minChars && r.width >= minWidth
        && r.top > margin && r.bottom < innerHeight - margin)
      .map(({ r }) => ({ left: r.left, top: r.top, width: r.width, height: r.height })),
  { minChars: MIN_SPAN_CHARS, minWidth: MIN_SPAN_WIDTH_PX, margin: VIEW_MARGIN_PX, pageNo });
}

/** Highlight one line and leave it as the highlight the reader last touched. */
export async function highlight(page, span) {
  const y = span.top + span.height / 2;
  await drag(page, { x: span.left + EDGE_INSET_PX, y }, { x: span.left + span.width - EDGE_INSET_PX, y });
  if (!(await page.$('.hl-toolbar.is-open'))) return false;
  await page.click(`.hl-toolbar.is-open .hl-swatch[data-color="${HL_COLOR}"]`);
  await page.waitForTimeout(SETTLE_MS);
  return true;
}

/** Put the caret at the end of the last block of the editor. */
export async function focusEditor(page) {
  const texts = await page.$$('#notes-column .ne-text');
  const box = await texts[texts.length - 1].boundingBox();
  await page.mouse.click(box.x + Math.max(0, box.width - EDGE_INSET_PX), box.y + box.height / 2);
  await page.waitForTimeout(SETTLE_MS);
}

/** Highlight the first of `spans` the engine will actually build a selection across. */
export async function highlightOneOf(page, spans) {
  for (const span of spans) {
    if (await highlight(page, span)) return true;
  }
  return false;
}

/** Put the caret at the end of the last row of the note that says `text`. */
export async function focusNote(page, text) {
  const handle = await page.evaluateHandle((needle) => {
    const note = [...document.querySelectorAll('#notes-column .ne-note')]
      .find((n) => n.textContent.includes(needle));
    return [...(note?.querySelectorAll('.ne-text') || [])].pop() || null;
  }, text);
  const el = handle.asElement();
  const box = el && await el.boundingBox();
  const view = page.viewportSize();
  must(`the note saying "${text}" has a row on screen to click`,
    Boolean(box) && box.y >= 0 && box.y + box.height <= view.height, JSON.stringify(box));
  await page.mouse.click(box.x + Math.max(0, box.width - EDGE_INSET_PX), box.y + box.height / 2);
  await page.waitForTimeout(SETTLE_MS);
}

export async function type(page, text) {
  await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
  await page.waitForTimeout(SETTLE_MS);
}

/** Zoom with the keyboard, which only works while the caret is out of the editor. */
export async function zoomTo(page, key) {
  await page.mouse.click(VIEW_MARGIN_PX, VIEWPORT.height / 2);   // out of the editor, off the text
  const before = await page.evaluate(() => window.kokoro.pdfView.scale());
  await page.keyboard.press(key);
  await page.waitForFunction((s) => window.kokoro.pdfView.scale() !== s, before, { timeout: STEP_TIMEOUT_MS })
    .catch(() => {});
  await page.waitForTimeout(PANEL_MS);
}

export async function scrollBy(page, by) {
  await page.evaluate((px) => document.getElementById('content-area').scrollBy(0, px), by);
  await page.waitForTimeout(SETTLE_MS);
}

/** Every note drawn inside the column, by the text it holds. */
export const notesOnScreen = (now) => now.notes
  .filter((n) => n.box.bottom > now.docBox.top && n.box.top < now.docBox.bottom)
  .map((n) => n.text.slice(0, 24));

/** Turn to page `n` and wait until the viewer agrees that it is the page being read. */
export async function turnTo(page, n) {
  await page.evaluate((k) => window.kokoro.pdfView.scrollToPage(k, 'auto'), n);
  await page.waitForFunction((k) => window.kokoro.pdfView.currentPage() === k, n, { timeout: STEP_TIMEOUT_MS })
    .catch(() => {});
  await page.waitForTimeout(PANEL_MS);
}

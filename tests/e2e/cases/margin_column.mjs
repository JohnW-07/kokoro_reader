// Cases 9-11 of margin_notes.mjs (U8 / U30), kept apart so that file stays small: the row being
// typed in stays inside the column — in a note taller than the column, and further down the
// same page — and a click on an empty column starts a note at the reading position.

import { VIEWPORT, api, check, docIdOf, must } from '../lib/harness.mjs';
import {
  DRIFT_PX, EDGE_INSET_PX, FAR_SCROLL_PX, NOTE_A, NOTE_B, PANEL_MS, PDF, SETTLE_MS, VIEW_MARGIN_PX, focusNote, layout,
  notesOnScreen, scrollBy, turnTo, type, worstDrift,
} from '../lib/margin.mjs';

const NOTE_E = 'and this is carried on further down the very same page';
const NOTE_F = 'clicked into an empty column, pages past every note';
const PAGES_PAST_NOTES = 3;    // far enough past the last note that none of them is on screen
const SAME_PAGE_SCROLL_PX = 420;  // far enough to drag a note off the top, not far enough to turn the page
const TALL_ROWS = 14;          // enough wrapped rows to run a note off the bottom of a short column
const TALL_ROW_TEXT = 'a long paragraph about the method that wraps over several lines of the column';
const SHORT_VIEWPORT = { width: 1440, height: 560 };

/** 9. A note longer than the column: the caret stays in, the note above stays visible. */
export async function tallNoteCase(page) {
  console.log('\n9. a note taller than the column keeps the caret in without covering its neighbour');
  // Home first, then shorten the window: a resize re-fits the pages and re-anchors the
  // scroll on the page being read, so scrolling home afterwards would be undone.
  await scrollBy(page, -FAR_SCROLL_PX * 2);
  await page.waitForTimeout(PANEL_MS);
  await page.setViewportSize(SHORT_VIEWPORT);
  await page.waitForTimeout(PANEL_MS);
  const home = await layout(page);
  // The caret is still in the last note written, which is pinned pages below: it must
  // not have dragged the column with it.
  must('the first note is back on screen in a column too short to hold it',
    home.notes[0].box.top > 0 && home.docBox.height < 600,
    JSON.stringify({ note: Math.round(home.notes[0].box.top), column: Math.round(home.docBox.height) }));

  await focusNote(page, NOTE_A);
  for (let i = 0; i < TALL_ROWS; i += 1) {
    await page.keyboard.press('Enter');
    await type(page, `${i} ${TALL_ROW_TEXT}`);
  }

  const now = await layout(page);
  // Whichever note the typing ended up in: this case is about the layout, and it holds
  // whatever the anchoring rules decided.
  const tall = now.notes.reduce((a, b) => (b.box.height > a.box.height ? b : a), now.notes[0]);
  must('the note really is taller than the column',
    tall && tall.box.height > now.docBox.height,
    JSON.stringify({ column: Math.round(now.docBox.height),
      notes: now.notes.map((n) => [Math.round(n.box.height), n.text.slice(0, 24)]) }));
  check('the row being typed in is still inside the column',
    now.caret && now.caret.box.top >= now.docBox.top - 1 && now.caret.box.bottom <= now.docBox.bottom + 1,
    JSON.stringify({ caret: now.caret && [Math.round(now.caret.box.top), Math.round(now.caret.box.bottom)],
      column: [Math.round(now.docBox.top), Math.round(now.docBox.bottom)] }));
  const overlaps = now.notes.filter((n, i) => i > 0 && n.box.top < now.notes[i - 1].box.bottom - 1);
  check('no note is covered by the one before it', overlaps.length === 0,
    JSON.stringify(now.notes.map((n) => [Math.round(n.box.top), Math.round(n.box.bottom)])));
  check('the column itself never scrolls out from under the anchors', now.docScroll === 0,
    String(now.docScroll));

  // The caret leaves: every note goes straight back to its own anchor.
  await page.mouse.click(VIEW_MARGIN_PX, SHORT_VIEWPORT.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  const after = await layout(page);
  check('with the caret out, every note is beside its anchor again',
    worstDrift(after.notes) <= DRIFT_PX, `drift ${worstDrift(after.notes).toFixed(1)}px`);
  check('… and the column is still where it was', after.docScroll === 0, String(after.docScroll));
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(PANEL_MS);
}

/** 10. Case 7's gesture, minus the page change: the note stays put and the caret must not. */
export async function samePageCase(page) {
  console.log('\n10. writing on further down the same page keeps the row being typed in on screen');
  await scrollBy(page, -FAR_SCROLL_PX * 4);
  await page.waitForTimeout(PANEL_MS);
  const home = await layout(page);
  must('the paper is back at the top of page 1', home.readingPage === 1, String(home.readingPage));
  const held = home.notes.find((n) => n.text.includes(NOTE_B));
  must('the note to write on in is pinned near the top of page 1',
    held?.page === 1 && held.y < 0.5, JSON.stringify({ page: held?.page, y: held?.y }));

  // Open a line in it, read on down the page, then write — the reader has not changed
  // page, so the note is not re-pinned and its rows ride the paper off the top instead.
  await focusNote(page, NOTE_B);
  await page.keyboard.press('Enter');
  await scrollBy(page, SAME_PAGE_SCROLL_PX);
  const moved = await layout(page);
  must('the reader moved down the paper but is still on the same page',
    moved.readingPage === 1 && moved.scrollTop - home.scrollTop > SAME_PAGE_SCROLL_PX / 2,
    JSON.stringify({ page: moved.readingPage, was: home.scrollTop, now: moved.scrollTop }));
  const anchored = moved.notes.find((n) => n.text.includes(NOTE_B));
  must('its anchor has been carried off the top of the column',
    anchored && anchored.want < moved.docBox.top,
    JSON.stringify({ anchor: Math.round(anchored?.want), column: Math.round(moved.docBox.top) }));

  const before = moved.notes.map((n) => ({ text: n.text.slice(0, 24), page: n.page, y: n.y }));
  await type(page, NOTE_E);
  const now = await layout(page);
  const written = now.notes.find((n) => n.text.includes(NOTE_E));
  must('the writing carried on in the note it was opened in, as the same page means it must',
    Boolean(written) && now.notes.length === before.length && written.text.includes(NOTE_B)
      && written.page === anchored.page && Math.abs(written.y - anchored.y) < 1e-6,
    JSON.stringify({ notes: now.notes.length, was: [anchored.page, anchored.y],
      now: [written?.page, written?.y] }));
  check('the row being typed in is on screen, not above the top of the column',
    now.caret && now.caret.box.top >= now.docBox.top - 1 && now.caret.box.bottom <= now.docBox.bottom + 1,
    JSON.stringify({ caret: now.caret && [Math.round(now.caret.box.top), Math.round(now.caret.box.bottom)],
      column: [Math.round(now.docBox.top), Math.round(now.docBox.bottom)] }));
  check('… and it is the row the text went into', now.caret?.text.includes(NOTE_E),
    now.caret?.text.slice(0, 40));
  const overlaps = now.notes.filter((n, i) => i > 0 && n.box.top < now.notes[i - 1].box.bottom - 1);
  check('holding it on screen did not push one note over another', overlaps.length === 0,
    JSON.stringify(now.notes.map((n) => [Math.round(n.box.top), Math.round(n.box.bottom)])));
  check('the column itself never scrolls out from under the anchors', now.docScroll === 0,
    String(now.docScroll));
  check('nothing was re-pinned to make room', before.every((was, i) =>
    now.notes[i].page === was.page && Math.abs(now.notes[i].y - was.y) < 1e-6),
  JSON.stringify({ was: before.map((n) => [n.page, n.y]), now: now.notes.map((n) => [n.page, n.y]) }));

  // The move is transient: the notes the reader was not typing in are shifted with the
  // stack, and must be back beside their own anchors the moment the caret leaves.
  await page.mouse.click(VIEW_MARGIN_PX, VIEWPORT.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  const after = await layout(page);
  check(`with the caret out, every note is beside its anchor again (±${DRIFT_PX}px)`,
    worstDrift(after.notes) <= DRIFT_PX, `drift ${worstDrift(after.notes).toFixed(1)}px`);
  check('… and the column is still where it was', after.docScroll === 0, String(after.docScroll));
}

/** 11. Nothing on screen to click: the click starts a note where the reader is. */
export async function emptyColumnCase(page) {
  console.log('\n11. a click on an empty column starts a note at the reading position');
  await page.mouse.click(VIEW_MARGIN_PX, VIEWPORT.height / 2);   // out of the editor, off the text
  await page.waitForTimeout(SETTLE_MS);
  const home = await layout(page);
  const last = await page.evaluate(() => window.kokoro.pdfView.numPages());
  const target = Math.max(...home.notes.map((n) => n.page)) + PAGES_PAST_NOTES;
  must('the paper has a page well past every note', target <= last, JSON.stringify({ target, last }));
  await turnTo(page, target);
  const away = await layout(page);
  must('the reader is on that page', away.readingPage === target, JSON.stringify({ reading: away.readingPage, target }));
  must('no note is drawn in the column', notesOnScreen(away).length === 0, JSON.stringify(notesOnScreen(away)));
  const before = away.notes.map((n) => ({ text: n.text, page: n.page, y: n.y }));

  const centre = { x: away.docBox.left + away.docBox.width / 2, y: away.docBox.top + away.docBox.height / 2 };
  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(SETTLE_MS);
  const clicked = await layout(page);
  check('the caret is in a row inside the column, not in a note off screen',
    clicked.caret && clicked.caret.box.top >= clicked.docBox.top - 1 && clicked.caret.box.bottom <= clicked.docBox.bottom + 1,
    JSON.stringify({ caret: clicked.caret && [Math.round(clicked.caret.box.top), Math.round(clicked.caret.box.bottom)],
      column: [Math.round(clicked.docBox.top), Math.round(clicked.docBox.bottom)] }));
  check('... and it is an empty row', clicked.caret?.text === '', JSON.stringify(clicked.caret?.text));

  await type(page, NOTE_F);
  const now = await layout(page);
  const note = now.notes.find((n) => n.text.includes(NOTE_F));
  must('the writing opened a note of its own', Boolean(note) && now.notes.length === before.length + 1
    && note.text === NOTE_F, JSON.stringify(now.notes.map((n) => n.text.slice(0, 24))));
  check('it is pinned to the page being read', note.page === target, JSON.stringify({ pinned: note.page, target }));
  check(`it is drawn beside that place (±${DRIFT_PX}px)`, Math.abs(note.drift) <= DRIFT_PX,
    `drift ${note.drift?.toFixed(1)}px`);
  check('no note already written changed a word or moved', before.every((was) => now.notes.some((n) =>
    n.text === was.text && n.page === was.page && Math.abs(n.y - was.y) < 1e-6)),
  JSON.stringify({ was: before.map((n) => [n.text.slice(0, 24), n.page]), now: now.notes.map((n) => [n.text.slice(0, 24), n.page]) }));

  await page.mouse.click(VIEW_MARGIN_PX, VIEWPORT.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  const blurred = await layout(page);
  const kept = blurred.notes.find((n) => n.text.includes(NOTE_F));
  check(`with the caret out it stays beside its anchor, in the column (±${DRIFT_PX}px)`,
    kept && Math.abs(kept.drift) <= DRIFT_PX && notesOnScreen(blurred).some((t) => NOTE_F.startsWith(t)),
    JSON.stringify({ drift: kept?.drift, top: kept && Math.round(kept.box.top) }));

  // A note on screen is still what a click beside it goes into.
  const row = await page.evaluateHandle((needle) => [...document.querySelectorAll('#notes-column .ne-note')]
    .find((n) => n.textContent.includes(needle))?.querySelector('.ne-text'), NOTE_F);
  const rowBox = await row.asElement().boundingBox();
  await page.mouse.click(blurred.docBox.left + EDGE_INSET_PX, rowBox.y + rowBox.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  const beside = await layout(page);
  check('a click in the padding beside a note on screen puts the caret in that note',
    beside.caret?.text === NOTE_F && beside.notes.length === now.notes.length,
    JSON.stringify({ caret: beside.caret?.text, notes: beside.notes.length }));

  // Clicked, never written in: the row must not stay behind as an empty note.
  await page.mouse.click(VIEW_MARGIN_PX, VIEWPORT.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  await turnTo(page, target + 1);
  const further = await layout(page);
  must('no note is drawn in the column a page further on', notesOnScreen(further).length === 0,
    JSON.stringify(notesOnScreen(further)));
  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(SETTLE_MS);
  const armed = await layout(page);
  check('the click gives a row to type in there as well', armed.caret?.text === ''
    && armed.caret.box.top >= armed.docBox.top - 1 && armed.caret.box.bottom <= armed.docBox.bottom + 1,
    JSON.stringify(armed.caret && { text: armed.caret.text, top: Math.round(armed.caret.box.top) }));
  await page.mouse.click(VIEW_MARGIN_PX, VIEWPORT.height / 2);
  await page.waitForTimeout(PANEL_MS);   // and let the debounced save land
  const left = await layout(page);
  check('clicking away without writing leaves no empty note behind',
    left.notes.length === now.notes.length && left.notes.every((n) => n.text !== ''),
    JSON.stringify(left.notes.map((n) => n.text.slice(0, 24))));
  const saved = (await api(`api/notes/${docIdOf(PDF)}`)).blocks;
  check('... on disk either', !saved.some((b) => b.anchor?.page === target + 1),
    JSON.stringify(saved.map((b) => [b.text.slice(0, 16), b.anchor?.page])));
}

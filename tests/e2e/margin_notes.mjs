// Real-browser check for U8: "notes should be google style — they float up and down with
// the section … Add a button to toggle to a formal section-by-section view."
//
// It drives, on the paper named by KOKORO_E2E_PDF:
//   1. a note typed after highlighting sits beside that highlight (D1), pinned in
//      page-relative terms rather than in pixels.
//   2. it stays beside it while the paper is scrolled — the whole point of "google style".
//   3. it stays beside it while the paper is zoomed, which is what normalised anchoring buys.
//   4. two notes whose anchors are too close to each other stack instead of overlapping.
//   5. the switch goes to the section view: the paper's own headings, notes under them,
//      in page order, standing still while the paper scrolls — and back, with every edit intact.
//   6. the notes, their anchors and the chosen view all survive a reload.
//   7. a note written with no highlight at all, about another page, gets its own anchor
//      there (D1's other half) and the row being typed in stays inside the column.
//   8. a highlight made after a reload never re-pins a note that is already written.
//   9. a note taller than the column keeps the caret in view without covering the note
//      above it, and without the column scrolling out from under the anchors.
//  10. writing on in a note after scrolling further down the *same* page — case 7's gesture
//      without the page change, so the note stays where it is and its rows are dragged off
//      the top of the column — still keeps the row being typed in on screen, and every note
//      that was only pushed aside is back at its anchor the moment the caret leaves.
//  11. a click on the empty column while every note has scrolled away starts a new note at
//      the reading position, instead of putting the caret into a note off the top of the
//      column; a click beside a note on screen still goes into it; a click that is never
//      written in leaves no empty note behind.
//  12. a click never written in is not saved, not even by a reload with the caret in it.
//  13. no console errors.
//
// A case that cannot set up its own precondition fails loudly and stops the run: a short
// report is a failed report, never a pass.
//
// Run (no repo npm deps; Playwright comes from outside the repo):
//   KOKORO_DATA_DIR=$(mktemp -d) KOKORO_LLM=0 venv/bin/python -m uvicorn app:app --port 8765
//   PLAYWRIGHT_DIR=/path/to/node_modules node tests/e2e/margin_notes.mjs
// Env: KOKORO_URL, PLAYWRIGHT_DIR, CHROMIUM_PATH, BROWSER (chromium|webkit), KOKORO_E2E_PDF,
//      EMULATE_PYWEBVIEW, SHOT_DIR — as in notes_collapse.mjs.
// The paper must have no notes record on that server: the check refuses to touch an existing
// one and deletes the record it creates. Exit code 0 = pass, 1 = fail.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { emptyColumnCase, samePageCase, tallNoteCase } from './cases/margin_column.mjs';
import { unwrittenReloadCase } from './cases/unwritten_reload.mjs';
import {
  ENGINE, SHOT_DIR, api, check, docIdOf, finish, launch, must,
} from './lib/harness.mjs';
import {
  DRIFT_PX, FAR_SCROLL_PX, GAP_PX, NOTE_A, NOTE_B, PANEL_MS, PDF, SETTLE_MS, focusEditor, focusNote,
  highlight, highlightOneOf, layout, notesOnScreen, openPaper, prefs, scrollBy, spansOnScreen, type, worstDrift, zoomTo,
} from './lib/margin.mjs';

const SCROLL_BY_PX = 320;
const NEAR_SPAN_PX = 90;       // how far below the first line the second one may be
const NOTE_C = 'this page argues something else entirely';
const NOTE_D = 'written after a reload, about a new line';

// ── The cases ────────────────────────────────────────────────────────────────

/** 1. A note written after a highlight is pinned beside that highlight. */
async function anchorCase(page) {
  console.log('\n1. a note sits beside the highlight it was made from');
  const spans = await spansOnScreen(page);
  must('page 1 has lines on screen to highlight', spans.length >= 2, String(spans.length));
  must('the highlight is made', await highlight(page, spans[0]));
  await focusEditor(page);
  await type(page, NOTE_A);

  const now = await layout(page);
  const note = now.notes.find((n) => n.text.includes(NOTE_A));
  must('the note carries the anchor it was written at', Boolean(note?.page),
    JSON.stringify(now.notes.map((n) => ({ page: n.page, y: n.y }))));
  check('it is lifted out of the flow so it can float', note.positioned === 'absolute', note.positioned);

  const hl = now.highlights[0];
  // R3: a highlight behind the Highlights section has its note at the notes' top edge instead.
  const besideTop = hl && Math.max(hl.box.top, now.docBox?.top ?? -Infinity);
  check('it is drawn beside the highlight itself (or at the notes\' top edge when that is lower), within ±8px',
    hl && Math.abs(note.box.top - besideTop) <= DRIFT_PX,
    JSON.stringify({ note: Math.round(note.box.top), highlight: hl && Math.round(hl.box.top) }));
  check('… which is where its anchor says it should be',
    Math.abs(note.drift) <= DRIFT_PX, `drift ${note.drift?.toFixed(1)}px`);
  check('the column does not scroll: the notes are placed against the paper',
    now.columnScroll <= 0, String(now.columnScroll));
}

/** 2. It rides the paper. */
async function scrollCase(page) {
  console.log('\n2. it moves with the paper when the paper scrolls');
  const before = await layout(page);
  await scrollBy(page, SCROLL_BY_PX);
  const after = await layout(page);
  check('the paper scrolled', after.scrollTop - before.scrollTop > SCROLL_BY_PX / 2,
    JSON.stringify({ was: before.scrollTop, now: after.scrollTop }));
  check('the note moved up with it, not stayed put',
    Math.abs(after.notes[0].box.top - before.notes[0].box.top) > SCROLL_BY_PX / 2,
    JSON.stringify({ was: Math.round(before.notes[0].box.top), now: Math.round(after.notes[0].box.top) }));
  check(`it is still beside its anchor (±${DRIFT_PX}px)`, worstDrift(after.notes) <= DRIFT_PX,
    `drift ${worstDrift(after.notes).toFixed(1)}px`);

  await scrollBy(page, -SCROLL_BY_PX);
  const back = await layout(page);
  check('and scrolling back puts it back', worstDrift(back.notes) <= DRIFT_PX
    && Math.abs(back.notes[0].box.top - before.notes[0].box.top) <= DRIFT_PX,
    JSON.stringify({ drift: worstDrift(back.notes), was: Math.round(before.notes[0].box.top), now: Math.round(back.notes[0].box.top) }));
}

/** 3. And it survives zoom, which is what normalised anchoring is for. */
async function zoomCase(page) {
  console.log('\n3. it stays beside its anchor while the paper is zoomed');
  const before = await layout(page);
  await zoomTo(page, 'Meta+Equal');
  const bigger = await layout(page);
  check('the paper zoomed in', bigger.zoom > before.zoom, JSON.stringify({ was: before.zoom, now: bigger.zoom }));
  check(`the note followed its anchor (±${DRIFT_PX}px)`, worstDrift(bigger.notes) <= DRIFT_PX,
    `drift ${worstDrift(bigger.notes).toFixed(1)}px`);

  await zoomTo(page, 'Meta+Minus');
  await zoomTo(page, 'Meta+Minus');
  const smaller = await layout(page);
  check('the paper zoomed out past where it started', smaller.zoom < before.zoom,
    JSON.stringify({ was: before.zoom, now: smaller.zoom }));
  check(`the note followed it back (±${DRIFT_PX}px)`, worstDrift(smaller.notes) <= DRIFT_PX,
    `drift ${worstDrift(smaller.notes).toFixed(1)}px`);

  await zoomTo(page, 'Meta+Digit0');
  const fit = await layout(page);
  check('back at fit width it is still beside its anchor', worstDrift(fit.notes) <= DRIFT_PX,
    `drift ${worstDrift(fit.notes).toFixed(1)}px`);
}

/** 4. Two notes that want the same strip of column do not sit on each other. */
async function stackCase(page) {
  console.log('\n4. a second note nearby stacks instead of covering the first');
  // Scrolling and zooming have moved everything since case 1, so the line to highlight
  // is found afresh: the next line under the first highlight, wherever that now is.
  await page.evaluate(() => document.querySelector('.hl-rect')
    ?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(SETTLE_MS);
  const first = (await layout(page)).highlights[0];
  const near = (await spansOnScreen(page))
    .find((s) => s.top > first.box.top + 1 && s.top < first.box.top + NEAR_SPAN_PX);
  must('there is a line just under the first highlight', Boolean(near),
    JSON.stringify({ highlight: Math.round(first.box.top) }));
  must('the second highlight is made', await highlight(page, near));

  // A blank row ends a note: writing about a second line of the same page carries the
  // note in hand on unless the reader deliberately breaks it, which is this keypress.
  await focusEditor(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await type(page, NOTE_B);

  const now = await layout(page);
  must('there are two notes', now.notes.length === 2, JSON.stringify(now.notes.map((n) => n.text)));
  const [a, b] = now.notes;
  check('they are in page order, down the paper', a.page < b.page || (a.page === b.page && a.y <= b.y),
    JSON.stringify([{ page: a.page, y: a.y }, { page: b.page, y: b.y }]));
  must('the two anchors really are close enough to collide',
    b.want - a.want < a.box.height + GAP_PX,
    JSON.stringify({ apart: Math.round(b.want - a.want), tall: Math.round(a.box.height) }));
  check('neither note covers the other', b.box.top >= a.box.bottom - 1,
    JSON.stringify({ firstBottom: Math.round(a.box.bottom), secondTop: Math.round(b.box.top) }));
  check('the first is still exactly beside its own anchor', Math.abs(a.drift) <= DRIFT_PX,
    `drift ${a.drift.toFixed(1)}px`);
  check('the second is pushed down, never up', b.drift >= -DRIFT_PX, `drift ${b.drift.toFixed(1)}px`);
}

/** 5. The switch, and the edits surviving it. */
async function viewCase(page) {
  console.log('\n5. the switch goes to the section view and back');
  const margin = await layout(page);
  check('it shows the margin view as the current one', margin.shown === 'margin', margin.shown);

  await page.click('#notes-view [data-view="sections"]');
  await page.waitForTimeout(PANEL_MS);
  const sections = await layout(page);
  check('the view changed', sections.view === 'sections', sections.view);
  check('both notes are still there, word for word',
    sections.notes.length === 2 && sections.notes[0].text.includes(NOTE_A)
    && sections.notes[1].text.includes(NOTE_B), JSON.stringify(sections.notes.map((n) => n.text)));
  check('the notes are back in the flow, under a heading',
    sections.notes.every((n) => n.positioned === 'static'),
    JSON.stringify(sections.notes.map((n) => n.positioned)));
  check('a heading from the paper stands over them', sections.sections.length >= 1,
    JSON.stringify(sections.sections));
  check('the switch now shows the section view as current', sections.shown === 'sections', sections.shown);
  check('the choice is remembered', (await prefs(page)).notesView === 'sections',
    JSON.stringify(await prefs(page)));

  const top = (await layout(page)).notes[0].box.top;
  await scrollBy(page, SCROLL_BY_PX);
  const scrolled = await layout(page);
  check('this view does not scroll with the paper (D2)', Math.abs(scrolled.notes[0].box.top - top) <= 1,
    JSON.stringify({ was: Math.round(top), now: Math.round(scrolled.notes[0].box.top) }));
  await scrollBy(page, -SCROLL_BY_PX);

  await page.click('#notes-view [data-view="margin"]');
  await page.waitForTimeout(PANEL_MS);
  const back = await layout(page);
  check('back in the margin, the edits are intact',
    back.notes.length === 2 && back.notes[0].text.includes(NOTE_A) && back.notes[1].text.includes(NOTE_B),
    JSON.stringify(back.notes.map((n) => n.text)));
  check('… and every note is beside its anchor again', worstDrift(back.notes) <= DRIFT_PX,
    `drift ${worstDrift(back.notes).toFixed(1)}px`);
  check('no section headings are left behind', back.sections.length === 0, JSON.stringify(back.sections));
}

/** 6. It is all on disk. */
async function reloadCase(page) {
  console.log('\n6. the notes and their anchors survive a reload');
  const before = await layout(page);
  await page.waitForTimeout(PANEL_MS);   // let the debounced save land
  await openPaper(page);
  const after = await layout(page);

  check('both notes came back', after.notes.length === 2
    && after.notes[0].text.includes(NOTE_A) && after.notes[1].text.includes(NOTE_B),
    JSON.stringify(after.notes.map((n) => n.text)));
  check('each came back pinned where it was', after.notes.every((note, i) =>
    note.page === before.notes[i].page && Math.abs(note.y - before.notes[i].y) < 1e-6),
  JSON.stringify({ was: before.notes.map((n) => [n.page, n.y]), now: after.notes.map((n) => [n.page, n.y]) }));
  check(`and each is drawn beside its anchor (±${DRIFT_PX}px)`, worstDrift(after.notes) <= DRIFT_PX,
    `drift ${worstDrift(after.notes).toFixed(1)}px`);
  check('the view came back as it was left', after.view === 'margin', after.view);
}


/** 7. The other half of D1: no highlight at all, and the reader has moved on. */
async function readingAnchorCase(page) {
  console.log('\n7. a note about another page is pinned there, not left on the last one');
  const before = await layout(page);
  const pinned = before.notes.map((n) => ({ text: n.text, page: n.page, y: n.y }));

  // The gesture the reader actually makes: open a line, read on, then write. The row is
  // still the one the caret was left in, and by the time it is typed into it is about
  // somewhere else entirely.
  await focusNote(page, NOTE_B);
  await page.keyboard.press('Enter');
  await scrollBy(page, FAR_SCROLL_PX);
  const moved = await layout(page);
  must('the reader is on another page of the paper now',
    moved.readingPage > Math.max(...pinned.map((n) => n.page)),
    JSON.stringify({ reading: moved.readingPage, notes: pinned.map((n) => n.page) }));
  await type(page, NOTE_C);

  const now = await layout(page);
  const note = now.notes.find((n) => n.text.includes(NOTE_C));
  must('the writing opened a note of its own', Boolean(note) && now.notes.length === pinned.length + 1,
    JSON.stringify(now.notes.map((n) => ({ page: n.page, text: n.text.slice(0, 20) }))));
  check('it is pinned to the page being read, not to the note before it',
    note.page === moved.readingPage, JSON.stringify({ pinned: note.page, reading: moved.readingPage }));
  check(`it is drawn beside that place (±${DRIFT_PX}px)`, Math.abs(note.drift) <= DRIFT_PX,
    `drift ${note.drift?.toFixed(1)}px`);
  check('the row being typed in is inside the column, not off the top of it',
    now.caret && now.caret.box.top >= now.docBox.top - 1 && now.caret.box.bottom <= now.docBox.bottom + 1,
    JSON.stringify({ caret: now.caret && Math.round(now.caret.box.top), column: Math.round(now.docBox.top) }));
  check('nothing already written was re-pinned', pinned.every((was) => {
    const still = now.notes.find((n) => n.text.includes(was.text.slice(0, 20)));
    return still && still.page === was.page && Math.abs(still.y - was.y) < 1e-6;
  }), JSON.stringify({ was: pinned.map((n) => [n.page, n.y]), now: now.notes.map((n) => [n.page, n.y]) }));
}

/** 8. A note read back from disk is written, and written notes do not move. */
async function settledCase(page) {
  console.log('\n8. a highlight made after a reload does not re-pin what is already written');
  await page.waitForTimeout(PANEL_MS);   // let the debounced save land
  await openPaper(page);
  const fresh = await layout(page);
  const pinned = fresh.notes.map((n) => ({ text: n.text, page: n.page, y: n.y }));
  must('the three notes came back from disk', pinned.length === 3,
    JSON.stringify(pinned.map((n) => n.text.slice(0, 20))));

  // Down to the note that was pinned by reading alone: the one a new highlight used to
  // pick up and carry off, taking a page of written text with it.
  await scrollBy(page, FAR_SCROLL_PX);
  const there = await layout(page);
  const spans = await spansOnScreen(page, there.readingPage);
  must('there is a line on the page being read to highlight', spans.length >= 1,
    JSON.stringify({ page: there.readingPage, spans: spans.length }));
  must('the third highlight is made', await highlightOneOf(page, [...spans].reverse()));

  await focusNote(page, NOTE_C);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await type(page, NOTE_D);

  const now = await layout(page);
  check('every note that was already written is pinned exactly where it was', pinned.every((was) => {
    const still = now.notes.find((n) => n.text.includes(was.text.slice(0, 20)));
    return still && still.page === was.page && Math.abs(still.y - was.y) < 1e-6;
  }), JSON.stringify({ was: pinned.map((n) => [n.page, n.y]), now: now.notes.map((n) => [n.page, n.y]) }));
  const note = now.notes.find((n) => n.text.includes(NOTE_D));
  must('the new writing opened a note of its own', Boolean(note) && now.notes.length === 4,
    JSON.stringify(now.notes.map((n) => n.text.slice(0, 20))));
  check('… and it did not take the note it was written under with it',
    !note.text.includes(NOTE_C), note.text.slice(0, 60));
  const hl = now.highlights.find((h) => Math.abs(h.box.top - note.want) <= DRIFT_PX);
  check('… it is beside the line just highlighted (D1)', Boolean(hl),
    JSON.stringify({ note: Math.round(note.want), highlights: now.highlights.map((h) => Math.round(h.box.top)) }));
  check(`… and drawn there (±${DRIFT_PX}px)`, Math.abs(note.drift) <= DRIFT_PX,
    `drift ${note.drift?.toFixed(1)}px`);
}

async function run() {
  const docId = docIdOf(PDF);
  const { docs } = await api('api/notes');
  if ((docs || []).some((d) => d.doc_id === docId)) {
    throw new Error('the server already holds a notes record for this paper; run it against a scratch KOKORO_DATA_DIR');
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  const errors = [];
  const { browser, page } = await launch(errors);
  try {
    await openPaper(page);
    await anchorCase(page);
    await scrollCase(page);
    await zoomCase(page);
    await page.screenshot({ path: join(SHOT_DIR, `margin-${ENGINE}.png`) });
    await stackCase(page);
    await viewCase(page);
    await page.screenshot({ path: join(SHOT_DIR, `sections-${ENGINE}.png`) });
    await reloadCase(page);
    await readingAnchorCase(page);
    await settledCase(page);
    await tallNoteCase(page);
    await samePageCase(page);
    await emptyColumnCase(page);
    const saved = async () => (await api(`api/notes/${docId}`)).blocks;
    await unwrittenReloadCase(page, { check, must, layout, openPaper, notesOnScreen, saved });
    console.log('');
    check('no console errors', errors.length === 0, errors.join(' | '));
    console.log(`  screenshots in ${SHOT_DIR}`);
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
  }
}

await finish(run);

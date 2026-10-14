// Case 15 of notes_editor.mjs (T7 / U30), kept apart so that file stays small: "、" opens the
// `/` menu too, and the menu stays fully on screen and clickable — typed in the same frame as
// an Enter, with room below, at the end of a long note (it opens above) while it filters, and on
// a block near the window's bottom edge. Then ArrowDown into a row below the column's edge
// scrolls no note off its anchor.

import { check } from '../lib/harness.mjs';
import {
  SETTLE_MS, SLASH_COMMAND_COUNT, blocks, clickMenuItem, focusBlock, focusedBlock, holdFrames, menuItems,
  menuPlacement, notePlaces, placedWell, releaseFrames, type,
} from '../lib/editor.mjs';

const LONG_NOTE_BLOCKS = 39;
const ROOMY_SCROLL_PX = 200;
const NEAR_EDGE_PX = 60;   // well past the editor's save debounce
const DRIFT_PX = 8;        // as margin_notes.mjs: a note this close to its anchor is at it
const NOTE_STILL_PX = 1;   // subpixel rounding: a note that moved less has not moved
const BELOW_EDGE_PX = 2;   // past subpixel rounding: the row's top is under the column's edge

/** The margin rows' [top, bottom] in the viewport, and the column's bottom edge. */
const rowSpans = (page) => page.evaluate(() => {
  const doc = document.querySelector('#notes-column .ne-doc');
  const spans = [...doc.querySelectorAll('.ne-text')].map((el) => el.getBoundingClientRect()).map((r) => [r.top, r.bottom]);
  return { edge: doc.getBoundingClientRect().top + doc.clientHeight, spans };
});
const middle = ([top, bottom]) => (top + bottom) / 2;
async function scrollPaper(page, top) {
  await page.evaluate((by) => document.querySelector('#content-area').scrollBy({ top: by, behavior: 'instant' }), top);
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * A key alone, no typing, moves the caret into a row wholly below the column's edge. The browser
 * scrolls the column to show it after focusin; the layout must undo that, or every note leaves
 * its anchor. The paper is scrolled once to hand the column back to the anchors, then down until
 * the first row wholly below the edge sits just under it (the paper may be at its top, so never
 * up): the notes ride the paper one to one.
 */
async function arrowBelowEdgeCase(page) {
  await scrollPaper(page, -ROOMY_SCROLL_PX);
  const placed = await rowSpans(page);
  const next = placed.spans.find(([top]) => top >= placed.edge) ?? [placed.edge];
  await scrollPaper(page, Math.max(0, Math.round(next[0] - placed.edge) - BELOW_EDGE_PX));
  const cutAt = await rowSpans(page);
  const crossing = cutAt.spans.findIndex((span, i) => middle(span) < cutAt.edge && cutAt.spans[i + 1]?.[0] >= cutAt.edge);
  check('a row on screen has the next one wholly below the column\'s edge', crossing >= 0, JSON.stringify({
    edge: cutAt.edge, rows: cutAt.spans.length, next, near: cutAt.spans.filter((span) => Math.abs(middle(span) - cutAt.edge) < NEAR_EDGE_PX),
  }));
  if (crossing < 0) return;   // a failed precondition, not a crash: case 16 still runs
  await focusBlock(page, crossing);
  await page.keyboard.press('End');
  await page.waitForTimeout(SETTLE_MS);
  const placesBefore = await notePlaces(page);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(SETTLE_MS);
  const placesAfter = await notePlaces(page);
  check('ArrowDown into a row below the edge moves the caret there without scrolling the column',
    (await focusedBlock(page)) === crossing + 1 && placesAfter.scrollTop === 0,
    JSON.stringify({ focused: await focusedBlock(page), crossing, scrollTop: placesAfter.scrollTop }));
  check('... and the notes stay at their anchors', Math.abs(placesAfter.tops[0] - placesAfter.anchor) <= DRIFT_PX
    && placesAfter.tops.every((top, i) => Math.abs(top - placesBefore.tops[i]) <= NOTE_STILL_PX),
    JSON.stringify({ before: placesBefore, after: placesAfter }));
}

/** Case 15, on paper B's note as case 14 left it, the caret at the end of its last block. */
export async function slashMenuCase(page) {
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('、');
  check('"、" (the / key with Pinyin punctuation) opens the menu', (await menuItems(page)).length === SLASH_COMMAND_COUNT,
    String((await menuItems(page)).length));
  await type(page, 'h2');
  await page.keyboard.press('Enter');
  await type(page, 'Wide');
  check('... and picks a command like "/" does', JSON.stringify((await blocks(page)).at(-1)) === JSON.stringify(
    { type: 'h2', text: 'Wide', checked: false }), JSON.stringify((await blocks(page)).at(-1)));
  // Enter re-renders the notes; a "/" typed before the next frame must not be placed against
  // the notes as they were before the layout put them back beside the paper.
  await holdFrames(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await releaseFrames(page);
  const raced = await menuPlacement(page);
  check('a "/" typed in the same frame as Enter still opens the menu on screen', placedWell(raced),
    JSON.stringify(raced));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  check('... and backing out of it leaves the note as it was', (await blocks(page)).at(-1)?.text === 'Wide',
    JSON.stringify((await blocks(page)).at(-1)));
  // The note rides the paper from 35% down the document area, which starts below the view
  // strip, so it sits too low for a full menu under its last row: scroll the paper to lift it.
  await page.evaluate((top) => document.querySelector('#content-area').scrollBy({ top, behavior: 'instant' }),
    ROOMY_SCROLL_PX);
  await page.waitForTimeout(SETTLE_MS);
  await page.keyboard.press('Enter');
  await type(page, '/');
  const roomy = await menuPlacement(page);
  check('with room below, the menu opens below the block', placedWell(roomy) && !roomy.above, JSON.stringify(roomy));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  for (let i = 0; i < LONG_NOTE_BLOCKS; i += 1) {
    await page.keyboard.type(`line ${i}`);
    await page.keyboard.press('Enter');
  }
  await type(page, '/');
  const atBottom = await menuPlacement(page);
  check(`at the end of a ${LONG_NOTE_BLOCKS}-block note the menu is fully on screen and clickable`,
    placedWell(atBottom), JSON.stringify(atBottom));
  check('... opening above the block', Boolean(atBottom?.above), JSON.stringify(atBottom));
  await type(page, 'h');
  check('... and stays so as the filter narrows it', placedWell(await menuPlacement(page)),
    JSON.stringify(await menuPlacement(page)));
  await clickMenuItem(page, 'h3');
  await type(page, 'Last');
  check('... and a click on it picks the command', (await blocks(page)).at(-1)?.type === 'h3',
    JSON.stringify((await blocks(page)).at(-1)));
  const nearEdge = await page.evaluate((inset) => {
    const rows = [...document.querySelectorAll('#notes-column .ne-text')];
    const row = rows.findLast((el) => el.getBoundingClientRect().bottom < innerHeight - inset);
    return rows.indexOf(row);
  }, NEAR_EDGE_PX);
  await focusBlock(page, nearEdge);
  await page.keyboard.press('End');
  await type(page, ' /');
  const edge = await menuPlacement(page);
  check(`on a block ${NEAR_EDGE_PX}px from the bottom edge the menu is fully on screen and clickable`,
    placedWell(edge), JSON.stringify(edge));
  await page.keyboard.press('Escape');
  await arrowBelowEdgeCase(page);
}

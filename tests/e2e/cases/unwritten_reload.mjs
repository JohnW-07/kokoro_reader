// Case 12 of margin_notes.mjs, kept apart so that file stays under its size limit.
// A click on an empty column opens a row to write in (case 11). If the app is reloaded or
// closed while the caret is still in it, nothing has been written, so nothing may have been
// saved: the debounced save must not put the empty note on disk, where no focusout would
// ever come to take it away again.

/** Well past the editor's save debounce (notesync.js, 600 ms). */
const SAVE_WAIT_MS = 1500;
const SETTLE_MS = 400;

/** Anchored rows with nothing written in them: what an unwritten note leaves behind. */
const emptyNotes = (blocks) => blocks.filter((b) => b.anchor && b.text === '');

/**
 * @param {import('playwright').Page} page
 * @param {object} t  the helpers margin_notes.mjs runs every case with
 */
export async function unwrittenReloadCase(page, { check, must, layout, openPaper, notesOnScreen, saved }) {
  console.log('\n12. a click that is never written in is not saved, even across a reload');
  const home = await layout(page);
  must('no note is drawn in the column', notesOnScreen(home).length === 0, JSON.stringify(notesOnScreen(home)));
  const centre = { x: home.docBox.left + home.docBox.width / 2, y: home.docBox.top + home.docBox.height / 2 };
  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(SETTLE_MS);
  const armed = await layout(page);
  must('the click gives an empty row to type in', armed.caret?.text === '', JSON.stringify(armed.caret?.text));
  await page.waitForTimeout(SAVE_WAIT_MS);   // the caret stays in the row while the save lands
  const whileFocused = emptyNotes(await saved());
  check('the save that lands while the caret is in it leaves it out', whileFocused.length === 0,
    JSON.stringify(whileFocused.map((b) => b.anchor)));

  await openPaper(page);   // reloaded with the row still focused: no focusout ever comes
  await page.waitForTimeout(SAVE_WAIT_MS);
  const after = await layout(page);
  const shown = after.notes.filter((n) => n.text === '');
  check('after a reload no empty note is drawn', shown.length === 0 && after.notes.length === home.notes.length,
    JSON.stringify({ empty: shown.length, notes: after.notes.length, was: home.notes.length }));
  const disk = emptyNotes(await saved());
  check('... or kept on disk', disk.length === 0, JSON.stringify(disk.map((b) => b.anchor)));
}

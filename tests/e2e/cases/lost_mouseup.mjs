// A case of notes_editor.mjs §14, kept apart so that file stays under its size limit.
// A drag from the padding beside a row selects in that row (U10b): the press pins the start
// and every mousemove moves the end. If the mouseup never reaches the page (released over
// another window, a dialog taking the pointer), the moves that follow come with no button
// down. They must not keep extending the selection, and the drag must be over for good.

const PRIMARY = 1;   // MouseEvent.buttons bit for the primary button

/**
 * @param {import('playwright').Page} page
 * @param {object} t  what notes_editor.mjs already measured for its padding drags
 */
export async function lostMouseupCase(page, { check, docBox, row, y, selected, inset, steps }) {
  const moveBy = (x, buttons) => page.evaluate(([cx, cy, b]) => document.dispatchEvent(new MouseEvent('mousemove',
    { clientX: cx, clientY: cy, buttons: b, bubbles: true, cancelable: true })), [x, y, buttons]);
  await page.evaluate(() => { document.activeElement?.blur(); getSelection().removeAllRanges(); });
  await page.mouse.move(docBox.left + inset, y);
  await page.mouse.down();
  await page.mouse.move(row.x + row.width - 1, y, { steps });
  const dragged = await selected();
  check('(precondition) a padding drag selected text in the row', dragged.length > 0, JSON.stringify(dragged));

  await moveBy(row.x + 1, 0);   // the button came up where the page never saw it
  const unpressed = await selected();
  check('a move with no button down does not extend the selection', unpressed === dragged,
    JSON.stringify({ dragged, now: unpressed }));
  await moveBy(row.x + 1, PRIMARY);
  const later = await selected();
  check('... and the drag is over: a later move does not extend it either', later === dragged,
    JSON.stringify({ dragged, now: later }));
  await page.mouse.up();
}

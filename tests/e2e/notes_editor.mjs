// Real-browser check for T7: the per-paper block editor in the notes column.
//
// It drives, on GR00TN1:
//   1. no paper open → the editor is disabled and says so; opening one turns it on.
//   2. typing saves: the readout goes "Saving…" → "Saved" and the server holds the blocks.
//   3. the `/` menu: opens on "/", filters as you type, ↑ ↓ move, Esc closes, Enter inserts
//      (here: Heading 1).
//   4. markdown shortcuts at the start of a block: "- ", "[] ", "> ", "## ", "### " — and Enter
//      continues a list.
//   5. a to-do is ticked by clicking its box; a row measured in the frame of that render is the
//      row a click there lands in.
//   6. "Quote current highlight" pulls the last highlight's text and page into a quote block.
//   7. paste inserts text/plain only (the text/html part and its <img onerror> are dropped), and
//      markup pasted as plain text is shown as literal text, never parsed.
//   8. editor keystrokes are not global shortcuts: Space types a space and asks for no /api/tts,
//      "b" types a b and leaves the sidebar alone — also with a to-do checkbox focused — while "b"
//      outside the editor still collapses it.
//   9. with the sidebar collapsed the column is wider and the editor still takes typing.
//  10. the lost-update hazard: a writer that PUTs the record without blocks (an older client, or a
//      resume-position save) does not erase them, and the editor's own save does not drop a
//      highlight made while its debounce was pending.
//  11. a reload brings every block back, including the tick, the quote and the literal markup.
//  12. opening a second paper inside the save debounce: paper A keeps the note typed just before
//      the switch, and paper B does not inherit it.
//  13. clicking the column's empty space (below, or beside a block) puts the caret in the editor, and so
//      does a click below a closing divider (a new paragraph); drags inside a block still select; "/#",
//      "/##", "/-", "/>", "/[]" find the command their hint shows; a real mouse click picks a menu item;
//      an Enter an input method is composing with is left alone.
//  14. "、" opens the menu too; the menu stays fully on screen and clickable with room below, at the end
//      of a long note (it opens above) while it filters, and on a block near the window's bottom edge;
//      ArrowDown into a row below the column's edge scrolls no note off its anchor.
//  15. no console errors. Screenshots at 1440×900, expanded and collapsed.
//
// Run (no repo npm deps; Playwright comes from outside the repo):
//   KOKORO_DATA_DIR=$(mktemp -d) KOKORO_LLM=0 venv/bin/python -m uvicorn app:app --port 8765
//   PLAYWRIGHT_DIR=/path/to/node_modules node tests/e2e/notes_editor.mjs
// Env: KOKORO_URL, PLAYWRIGHT_DIR, CHROMIUM_PATH, BROWSER (chromium|webkit), KOKORO_E2E_PDF,
//      KOKORO_E2E_PDF2 (the second paper), EMULATE_PYWEBVIEW, SHOT_DIR (where the screenshots go).
// Neither paper may have a notes record on that server: the check refuses to touch an existing one
// and deletes the records it created. Exit code 0 = pass, 1 = fail.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { lostMouseupCase } from './cases/lost_mouseup.mjs';
import { slashMenuCase } from './cases/slash_menu.mjs';
import {
  BASE_URL, ENGINE, SHOT_DIR, api, check, docIdOf, finish, launch, requireEnv,
} from './lib/harness.mjs';
import {
  DRAG_STEPS, EDGE_INSET_PX, LOAD_TIMEOUT_MS, SETTLE_MS, SLASH_COMMAND_COUNT, STEP_TIMEOUT_MS, blockEnd, blocks,
  clickEmptySpace, clickMenuItem, focusBlock, focusedBlock, hasMarkup, holdFrames, makeHighlight, menuItems,
  openPaper, paste, releaseFrames, savedState, type, waitForSaved,
} from './lib/editor.mjs';

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const PDF2 = requireEnv('KOKORO_E2E_PDF2', 'Point it at a second, different PDF.');
const POSITION_FROM_OTHER_WRITER = 7;
const FIRST_NOTE = 'Reading notes';
const HEADING = 'Method';
const APPENDED = ' — checked twice';
const SUBHEADING = 'Results';
const SUBSUBHEADING = 'Ablations';
const PASTED_PLAIN = 'pasted words ';
const XSS = '<img src=x onerror="window.__xss = 1">';
const LAST_WORDS = ' — typed just before switching';
const SWITCH_MARGIN_MS = 1500;

async function run() {
  const docId = docIdOf(PDF);
  const docId2 = docIdOf(PDF2);
  const ours = [docId, docId2];
  const { docs } = await api('api/notes');
  if ((docs || []).some((d) => ours.includes(d.doc_id))) {
    throw new Error('the server already holds a notes record for one of the papers; '
      + 'run it against a scratch KOKORO_DATA_DIR');
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  const errors = [];
  const ttsRequests = [];
  const { browser, page } = await launch(errors);
  try {
    page.on('request', (req) => { if (req.url().includes('/api/tts')) ttsRequests.push(req.url()); });

    console.log('\n1. with no paper open');
    await page.goto(BASE_URL);
    await page.waitForSelector('#notes-column .ne-panel');
    check('the editor is disabled', await page.$eval('#notes-column .ne-panel', (el) => el.classList.contains('is-disabled')));
    check('... and says why', (await page.$eval('#notes-column .ne-hint', (el) => el.textContent)).includes('Open a paper'));
    check('... with nothing to type into', (await page.$$('#notes-column .ne-text')).length === 0);

    console.log('\n2. typing the first note');
    await openPaper(page, PDF);
    check('opening a paper enables the editor',
      !(await page.$eval('#notes-column .ne-panel', (el) => el.classList.contains('is-disabled'))));
    check('the empty block prompts for the menu',
      (await page.$eval('#notes-column .ne-text', (el) => el.dataset.placeholder)) === "Type '/' for commands");
    await focusBlock(page, 0);
    await type(page, FIRST_NOTE);
    check('the text lands in the first block', (await blocks(page))[0].text === FIRST_NOTE, JSON.stringify(await blocks(page)));
    check('the save state shows progress', ['Saving…', 'Saved'].includes(await savedState(page)), await savedState(page));

    console.log('\n3. a highlight made while the note is still saving');
    const quoted = await makeHighlight(page, 'green');
    check('a highlight was made on page 1', Boolean(quoted), String(quoted));
    await waitForSaved(page);
    const afterBoth = await api(`api/notes/${docId}`);
    check('the record holds the note', (afterBoth.blocks || []).some((b) => b.text === FIRST_NOTE),
      JSON.stringify(afterBoth.blocks));
    check('... and the highlight the editor save could have dropped', (afterBoth.highlights || []).length === 1,
      String((afterBoth.highlights || []).length));

    console.log('\n4. the / menu');
    await focusBlock(page, 0);
    await page.keyboard.press('Enter');
    await type(page, '/');
    check('typing "/" opens the menu', (await menuItems(page)).length === SLASH_COMMAND_COUNT,
      String((await menuItems(page)).length));
    await page.keyboard.press('ArrowDown');
    check('↓ moves the selection', (await menuItems(page))[1]?.selected === true,
      JSON.stringify((await menuItems(page)).map((i) => i.selected)));
    await page.keyboard.press('ArrowUp');
    check('↑ moves it back', (await menuItems(page))[0]?.selected === true);
    await page.keyboard.press('Escape');
    check('Esc closes it', (await menuItems(page)).length === 0);
    await type(page, 'x');
    check('... and it stays dismissed while the same block is typed in', (await menuItems(page)).length === 0);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await type(page, '/h1');
    const filtered = await menuItems(page);
    check('typing filters, Heading 1 first', filtered[0]?.id === 'h1' && filtered.length < SLASH_COMMAND_COUNT,
      JSON.stringify(filtered.map((i) => i.id)));
    await page.keyboard.press('Enter');
    await type(page, HEADING);
    const withHeading = await blocks(page);
    check('Enter inserts the heading, and the "/h1" text is gone',
      withHeading[1]?.type === 'h1' && withHeading[1].text === HEADING, JSON.stringify(withHeading));

    console.log('\n5. markdown shortcuts');
    await page.keyboard.press('Enter');
    await type(page, '- first point');
    await page.keyboard.press('Enter');
    await type(page, 'second point');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');           // an empty item leaves the list
    await type(page, '[] reread section 4');
    await page.keyboard.press('Enter');
    await type(page, '> a quoted line');
    await page.keyboard.press('Enter');
    await type(page, `## ${SUBHEADING}`);
    await page.keyboard.press('Enter');
    await type(page, `### ${SUBSUBHEADING}`);
    const typed = await blocks(page);
    check('"- " makes a bullet and Enter continues the list',
      typed.filter((b) => b.type === 'ul').map((b) => b.text).join('|') === 'first point|second point',
      JSON.stringify(typed));
    check('an empty bullet drops back to a paragraph, so "[] " can make a to-do',
      typed.some((b) => b.type === 'todo' && b.text === 'reread section 4'));
    check('"> " makes a quote', typed.some((b) => b.type === 'quote' && b.text === 'a quoted line'));
    check('"## " makes a heading 2', typed.some((b) => b.type === 'h2' && b.text === SUBHEADING), JSON.stringify(typed));
    check('"### " makes a heading 3', typed.some((b) => b.type === 'h3' && b.text === SUBSUBHEADING));

    console.log('\n6. ticking the to-do');
    await holdFrames(page);   // the tick re-renders the notes; case 7 measures a row in that same frame
    await page.$eval('#notes-column .ne-todo .ne-check', (el) => el.click());
    check('the box is checked', (await blocks(page)).some((b) => b.type === 'todo' && b.checked));

    console.log('\n7. quoting the current highlight');
    const lastIndex = (await blocks(page)).length - 1;
    const lastEnd = await blockEnd(page, lastIndex);
    await releaseFrames(page);
    await page.mouse.click(lastEnd.x, lastEnd.y);
    check('a row measured in the frame of a render is the row a click there lands in',
      (await focusedBlock(page)) === lastIndex, JSON.stringify({ focused: await focusedBlock(page), lastIndex }));
    await page.keyboard.press('Enter');
    await type(page, '/quote current');
    check('the action is the first match', (await menuItems(page))[0]?.id === 'highlight',
      JSON.stringify((await menuItems(page)).map((i) => i.id)));
    await page.keyboard.press('Enter');
    const withQuote = await blocks(page);
    const quoteBlock = withQuote.find((b) => b.type === 'quote' && b.text.includes('— p. 1'));
    check('a quote block cites the highlight and its page', Boolean(quoteBlock), JSON.stringify(withQuote));
    check('... with the highlighted words in it', Boolean(quoteBlock && quoteBlock.text.includes(quoted)),
      `${JSON.stringify(quoteBlock?.text)} vs ${JSON.stringify(quoted)}`);

    console.log('\n8. paste keeps text only');
    await page.keyboard.press('Enter');
    await paste(page, { 'text/html': `<b>bold</b>${XSS}`, 'text/plain': PASTED_PLAIN });
    await paste(page, { 'text/html': `<b>only markup</b>${XSS}` });
    await page.waitForTimeout(SETTLE_MS);
    const lastText = async () => (await blocks(page)).at(-1).text;
    check('a rich paste inserts its plain text only', (await lastText()) === PASTED_PLAIN, JSON.stringify(await lastText()));
    await paste(page, { 'text/plain': XSS });
    await page.waitForTimeout(SETTLE_MS);
    check('markup pasted as plain text is shown literally', (await lastText()) === PASTED_PLAIN + XSS,
      JSON.stringify(await lastText()));
    const markup = await hasMarkup(page);
    check('... no element was made from it and no handler ran', !markup.img && !markup.bold && !markup.ran,
      JSON.stringify(markup));

    console.log('\n9. editor keys are not global shortcuts');
    const ttsBefore = ttsRequests.length;
    const collapsedNow = () => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'));
    const ticked = async () => (await blocks(page)).some((b) => b.type === 'todo' && b.checked);
    // WebKit types at the page selection even when a button has focus, so drop the caret first.
    const focusCheckbox = () => page.evaluate(() => {
      getSelection().removeAllRanges();
      document.querySelector('#notes-column .ne-check').focus();
      return document.activeElement.classList.contains('ne-check');
    });
    let checkboxFocused = true;
    for (const key of ['b', 'ArrowRight', 'Space']) {
      checkboxFocused = (await focusCheckbox()) && checkboxFocused;
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(SETTLE_MS);
    check('the checkbox held focus for each key', checkboxFocused);
    check('... and nothing was typed', !(await blocks(page)).some((b) => /b$/.test(b.text)),
      JSON.stringify((await blocks(page)).map((b) => b.text)));
    check('keys on a focused to-do checkbox leave the sidebar alone', (await collapsedNow()) === false);
    check('... and start no playback (no /api/tts)', ttsRequests.length === ttsBefore, ttsRequests.join());
    if (!(await ticked())) await page.click('#notes-column .ne-todo .ne-check');   // Space toggled it
    check('... and the to-do is ticked again', await ticked());
    await focusBlock(page, 0);
    await page.keyboard.press('End');
    await type(page, ' b');
    await page.keyboard.press('Space');
    await page.waitForTimeout(SETTLE_MS);
    check('Space and "b" typed in a block are text, not shortcuts',
      (await blocks(page))[0].text === `${FIRST_NOTE} b `, JSON.stringify((await blocks(page))[0].text));
    check('... no playback started (no /api/tts)', ttsRequests.length === ttsBefore, ttsRequests.join());
    check('... and the sidebar is untouched', (await collapsedNow()) === false);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('b');
    await page.waitForTimeout(SETTLE_MS);
    check('the same key outside the editor still collapses the sidebar', (await collapsedNow()) === true);

    console.log('\n10. the notes column is wider with the sidebar collapsed');
    const width = () => page.$eval('#notes-column', (el) => el.getBoundingClientRect().width);
    const wide = await width();
    await page.screenshot({ path: join(SHOT_DIR, `notes-editor-collapsed-${ENGINE}.png`) });
    await focusBlock(page, 0);
    await type(page, '!');
    check('the editor still takes typing while collapsed',
      (await blocks(page))[0].text.endsWith('!'), JSON.stringify((await blocks(page))[0].text));
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('b');
    await page.waitForFunction(() => !document.body.classList.contains('sidebar-collapsed'), null, { timeout: STEP_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    const narrow = await width();
    check('collapsing widens the column', wide > narrow, `${wide} vs ${narrow}`);
    await page.screenshot({ path: join(SHOT_DIR, `notes-editor-expanded-${ENGINE}.png`) });

    console.log('\n11. a position-only writer does not erase the notes');
    await waitForSaved(page);
    const before = await api(`api/notes/${docId}`);
    // Exactly what a writer that knows nothing about blocks sends: the whole record, no blocks key.
    await api(`api/notes/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc_id: docId, title: before.title, highlights: before.highlights,
        last_index: POSITION_FROM_OTHER_WRITER, options: before.options,
      }),
    });
    const merged = await api(`api/notes/${docId}`);
    check('the blocks survived the position save',
      JSON.stringify(merged.blocks) === JSON.stringify(before.blocks), JSON.stringify(merged.blocks));
    check('... and the position was taken', merged.last_index === POSITION_FROM_OTHER_WRITER, String(merged.last_index));
    await focusBlock(page, 0);
    await page.keyboard.press('End');
    await type(page, APPENDED);
    await waitForSaved(page);
    const after = await api(`api/notes/${docId}`);
    check('a later editor save keeps every block it had', after.blocks.length === before.blocks.length,
      `${after.blocks.length} vs ${before.blocks.length}`);
    check('... with the new text in the first one', after.blocks[0].text.endsWith(APPENDED), after.blocks[0].text);
    check('... and still the highlight', (after.highlights || []).length === 1);

    console.log('\n12. everything comes back after a reload');
    await openPaper(page, PDF);
    const reloaded = await blocks(page);
    check('the same number of blocks', reloaded.length === after.blocks.length,
      `${reloaded.length} vs ${after.blocks.length}`);
    check('the headings are still headings', reloaded.some((b) => b.type === 'h1' && b.text === HEADING)
      && reloaded.some((b) => b.type === 'h2' && b.text === SUBHEADING)
      && reloaded.some((b) => b.type === 'h3' && b.text === SUBSUBHEADING));
    check('the pasted markup is still literal text', reloaded.some((b) => b.text === PASTED_PLAIN + XSS)
      && JSON.stringify(await hasMarkup(page)) === JSON.stringify({ img: 0, bold: 0, ran: false }),
      JSON.stringify({ markup: await hasMarkup(page), texts: reloaded.map((b) => b.text) }));
    check('the to-do is still ticked', reloaded.some((b) => b.type === 'todo' && b.checked));
    check('the quote still cites the page', reloaded.some((b) => b.type === 'quote' && b.text.includes('— p. 1')));
    check('the first note kept everything typed into it',
      reloaded[0].text.startsWith(FIRST_NOTE) && reloaded[0].text.endsWith(APPENDED),
      JSON.stringify(reloaded[0].text));

    console.log('\n13. opening a second paper inside the save debounce');
    await focusBlock(page, 0);
    await page.keyboard.press('End');
    await type(page, LAST_WORDS);
    await page.setInputFiles('#file-input', PDF2);   // at once: the note's save is still pending
    await page.waitForFunction(() => !document.getElementById('ppBtn').disabled
      && document.querySelector('#notes-column .ne-doc')?.hidden === false
      && [...document.querySelectorAll('#notes-column .ne-text')].every((el) => el.textContent === ''),
    null, { timeout: LOAD_TIMEOUT_MS });
    await page.waitForTimeout(SWITCH_MARGIN_MS);
    const recordA = await api(`api/notes/${docId}`);
    check('paper A kept the note typed just before the switch', recordA.blocks[0]?.text.endsWith(LAST_WORDS),
      JSON.stringify(recordA.blocks[0]?.text));
    const listed = (await api('api/notes')).docs || [];
    const recordB = listed.some((d) => d.doc_id === docId2) ? await api(`api/notes/${docId2}`) : { blocks: [] };
    check('paper B did not inherit it', !(recordB.blocks || []).some((b) => b.text.includes(LAST_WORDS)),
      JSON.stringify(recordB.blocks));
    const shownB = (await blocks(page)).map((b) => b.text).join('');
    check('the editor shows paper B\'s own (empty) notes', shownB === '', JSON.stringify(shownB));

    console.log('\n14. clicks on empty space, and the markdown the menu shows');
    await page.evaluate(() => document.activeElement?.blur());
    await clickEmptySpace(page);
    check('a click far below the only block focuses it', (await focusedBlock(page)) === 0, String(await focusedBlock(page)));
    await type(page, '/#');
    check('"/#" keeps the menu open with Heading 1 first', (await menuItems(page))[0]?.id === 'h1',
      JSON.stringify((await menuItems(page)).map((i) => i.id)));
    await page.keyboard.press('Enter');
    await type(page, 'Top');
    check('... and Enter makes the heading', JSON.stringify((await blocks(page))[0]) === JSON.stringify(
      { type: 'h1', text: 'Top', checked: false }), JSON.stringify(await blocks(page)));
    await page.evaluate(() => document.activeElement?.blur());
    await clickEmptySpace(page);
    await page.keyboard.press('Enter');
    await type(page, '/##');
    check('"/##" puts Heading 2 first', (await menuItems(page))[0]?.id === 'h2',
      JSON.stringify((await menuItems(page)).map((i) => i.id)));
    await clickMenuItem(page, 'h2');
    await type(page, 'Sub');
    await page.keyboard.press('Enter');
    await type(page, '/-');
    check('"/-" puts the bulleted list first', (await menuItems(page))[0]?.id === 'ul',
      JSON.stringify((await menuItems(page)).map((i) => i.id)));
    await clickMenuItem(page, 'ul');
    await type(page, 'item');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await type(page, '/>');
    await page.keyboard.press('Enter');
    await type(page, 'q');
    await page.keyboard.press('Enter');
    await type(page, '/[]');
    await page.keyboard.press('Enter');
    await type(page, 't');
    const built = (await blocks(page)).map((b) => `${b.type}:${b.text}`).join('|');
    check('a mouse-picked item applies, and "/-", "/>", "/[]" each work',
      built === 'h1:Top|h2:Sub|ul:item|quote:q|todo:t', built);

    const headRow = await (await page.$$('#notes-column .ne-text'))[0].boundingBox();
    const docLeft = await page.$eval('#notes-column .ne-doc', (el) => el.getBoundingClientRect().left);
    await clickEmptySpace(page, { x: docLeft + EDGE_INSET_PX, y: headRow.y + headRow.height / 2 });
    check('a click in the padding beside a block focuses that block', (await focusedBlock(page)) === 0,
      String(await focusedBlock(page)));
    await type(page, 'A');
    check('... with the caret at the start of the line', (await blocks(page))[0].text === 'ATop',
      JSON.stringify((await blocks(page))[0].text));
    const subRow = await (await page.$$('#notes-column .ne-text'))[1].boundingBox();
    await page.mouse.move(subRow.x + 1, subRow.y + subRow.height / 2);
    await page.mouse.down();
    await page.mouse.move(subRow.x + subRow.width - 1, subRow.y + subRow.height / 2, { steps: DRAG_STEPS });
    await page.mouse.up();
    check('a drag inside a block still selects its text',
      (await page.evaluate(() => getSelection().toString())) === 'Sub', await page.evaluate(() => getSelection().toString()));
    const docBox = await page.$eval('#notes-column .ne-doc', (el) => el.getBoundingClientRect().toJSON());
    // Each padding drag starts with nothing selected, so the selection left by the drag above
    // cannot pass for one. DRAG_STEPS' coarse strides step clean over the "S": only a drag
    // whose selection starts at the press, not at the first sample in the text, gets "Sub".
    const subY = subRow.y + subRow.height / 2;
    const selected = () => page.evaluate(() => getSelection().toString());
    const padDrag = async () => {
      await page.mouse.move(docBox.left + EDGE_INSET_PX, subY);
      await page.mouse.down();
      await page.mouse.move(subRow.x + subRow.width - 1, subY, { steps: DRAG_STEPS });
      await page.mouse.up();
      return selected();
    };
    await page.mouse.click(subRow.x + subRow.width - EDGE_INSET_PX, subY);
    check('(precondition) a click in the row leaves a caret and no selection', (await selected()) === ''
      && (await focusedBlock(page)) === 1, JSON.stringify({ sel: await selected(), block: await focusedBlock(page) }));
    const fromCaret = await padDrag();
    check('a drag that starts in the padding selects the text it crosses', fromCaret === 'Sub', JSON.stringify(fromCaret));
    await page.evaluate(() => { document.activeElement?.blur(); getSelection().removeAllRanges(); });
    check('(precondition) the editor is blurred with nothing selected', (await selected()) === ''
      && (await focusedBlock(page)) === -1, JSON.stringify({ sel: await selected(), block: await focusedBlock(page) }));
    const fromCold = await padDrag();
    check('... and so does one made with the editor blurred', fromCold === 'Sub', JSON.stringify(fromCold));
    await lostMouseupCase(page, { check, docBox, row: subRow, y: subY, selected, inset: EDGE_INSET_PX, steps: DRAG_STEPS });
    const count = (await blocks(page)).length;
    await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
    check('Enter that an input method is composing with does not split the block',
      (await blocks(page)).length === count, String((await blocks(page)).length));

    await waitForSaved(page);
    await page.goto(BASE_URL);   // leave the paper first: its unload save must not overwrite the edit below
    await page.waitForTimeout(SETTLE_MS);
    const recordB2 = await api(`api/notes/${docId2}`);
    await api(`api/notes/${docId2}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...recordB2, blocks: [...recordB2.blocks, { id: 'e2e-rule', type: 'divider', text: '' }] }),
    });
    await openPaper(page, PDF2);
    const ruled = (await blocks(page)).length;
    check('a note that ends in a divider loads that way', (await blocks(page)).at(-1)?.type === 'divider');
    await clickEmptySpace(page);
    await type(page, 'end');
    const ended = await blocks(page);
    check('a click below a closing divider adds a paragraph to type in',
      ended.length === ruled + 1 && ended.at(-1).type === 'p' && ended.at(-1).text === 'end', JSON.stringify(ended.slice(-2)));

    console.log('\n15. "、" opens the menu, and the menu stays on screen');
    await slashMenuCase(page);

    console.log('\n16. housekeeping');
    check('no console errors', errors.length === 0, errors.join(' | '));
    console.log(`  screenshots in ${SHOT_DIR}`);
  } finally {
    await browser.close();
    const left = await api('api/notes').then(({ docs: all }) => (all || []).map((d) => d.doc_id), () => ours);
    for (const id of ours.filter((d) => left.includes(d))) {
      await api(`api/notes/${id}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
    }
  }
}

await finish(run);

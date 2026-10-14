// Real-browser check for N7 (jump to a chapter) and N8 (the page numbers the book prints).
//
// On Think Stats (no PDF page labels, no outline: both come from the text):
//   1. the four sidebar tabs (Read, Subs, Summary, Settings) fit, none of their labels cut off.
//   2. "Go to page" from the pill: printed "11" lands on PDF page 23, and the pill then reads
//      "p. 11 · 23/<n>"; Escape closes the form without moving.
//   3. R2: the contents sit in the Read tab and list the chapters; a single click selects an
//      entry without moving the voice; a double-click while paused moves the cursor to its
//      heading, renders and scrolls its page into view, and marks the entry current.
//   4. the arrow keys walk the tree without also stepping the reading cursor; Enter jumps.
//   5. no console errors.
//
// Run: tests/e2e/run.sh <repo> chromium contents <port>, with KOKORO_E2E_TOC_PDF pointing at
// thinkstats.pdf (default below). Deletes the notes record it creates.
// Exit code 0 = pass, 1 = fail.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, finish, check, must, api, docIdOf, SHOT_DIR, ENGINE } from './lib/harness.mjs';

const PDF = process.env.KOKORO_E2E_TOC_PDF || join(process.env.HOME || '', 'UMD/Courses/CMSC320/text/thinkstats.pdf');
const LOAD_TIMEOUT_MS = 120000;
const STEP_TIMEOUT_MS = 20000;
const PRINTED = '11';
const PRINTED_AT = 23;                // thinkstats: PDF page 23 opens chapter 2, printed page 11
const CHAPTER = 'Chapter 2';

const ready = (page) => page.waitForFunction(
  () => !document.getElementById('ppBtn').disabled && !window.kokoro.state.get().loading
    && window.kokoro.state.get().sentences.length > 0, null, { timeout: LOAD_TIMEOUT_MS });
const cursorPage = (page) => page.evaluate(() => {
  const s = window.kokoro.state.get();
  return s.sentences[s.index]?.page ?? null;
});
/** Whether page `n` comes into view within STEP_TIMEOUT_MS (follow scrolls are smooth: N12). */
const pageInView = (page, n) => page.waitForFunction((num) => {
  const wrap = window.kokoro.pdfView.pageWrapEl(num);
  const box = wrap?.getBoundingClientRect();
  return Boolean(box) && box.bottom > 0 && box.top < innerHeight;
}, n, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false);

await finish(async () => {
  must('the Think Stats PDF is here', existsSync(PDF), PDF);
  const errors = [];
  const { browser, page } = await launch(errors);
  const docId = docIdOf(PDF);
  try {
    await page.goto(process.env.KOKORO_URL || 'http://127.0.0.1:8765/');
    await page.waitForFunction(() => Boolean(window.kokoro));
    await page.setInputFiles('#file-input', PDF);
    await ready(page);

    console.log('\n1. four tabs in the sidebar');
    const tabs = await page.$$eval('.tab', (els) => els.map((t) => ({ name: t.textContent, cut: t.scrollWidth > t.clientWidth })));
    check('Read, Subs, Summary, Settings', tabs.map((t) => t.name).join() === 'Read,Subs,Summary,Settings', JSON.stringify(tabs));
    check('... and no label is cut off', tabs.every((t) => !t.cut), JSON.stringify(tabs));

    console.log('\n2. "Go to page" from the pill');
    await page.click('#page-pill');
    check('the pill opens the form, focused', await page.evaluate(() => document.activeElement?.id === 'page-go-input'));
    await page.keyboard.press('Escape');
    check('Escape closes it', await page.locator('#page-go').isHidden());
    await page.click('#page-pill');
    await page.fill('#page-go-input', PRINTED);
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => {
      const s = window.kokoro.state.get();
      return s.sentences[s.index]?.page === n;
    }, PRINTED_AT, { timeout: STEP_TIMEOUT_MS });
    check(`printed ${PRINTED} is PDF page ${PRINTED_AT}`, (await cursorPage(page)) === PRINTED_AT);
    const pill = await page.textContent('#page-pill');
    check('the pill shows the printed number first', new RegExp(`^p\\. ${PRINTED} · ${PRINTED_AT}/\\d+$`).test(pill.trim()), pill);
    check('... and the page is in view', await pageInView(page, PRINTED_AT));

    console.log('\n3. the contents in the Read tab');
    check('the contents show in the Read tab', await page.locator('#tab-read #toc-panel').isVisible());
    const link = page.locator('#toc-panel .toc-tree > .toc-item > .toc-link', { hasText: CHAPTER }).first();
    must(`"${CHAPTER}" is a top-level entry`, (await link.count()) === 1);
    await page.evaluate(() => window.kokoro.player.setIndex(0));
    await link.click();
    check('a single click selects the entry', await link.evaluate((el) => el.classList.contains('is-selected')));
    check('... and leaves the cursor where it was', (await page.evaluate(() => window.kokoro.state.get().index)) === 0);
    await link.dblclick();
    await page.waitForFunction((n) => {
      const s = window.kokoro.state.get();
      return s.sentences[s.index]?.page === n;
    }, PRINTED_AT, { timeout: STEP_TIMEOUT_MS });
    check('a paused double-click moves the cursor to the chapter', (await cursorPage(page)) === PRINTED_AT);
    check('... renders and scrolls its page into view', await pageInView(page, PRINTED_AT));
    check('... and marks the entry current', (await link.getAttribute('aria-current')) === 'location');
    await page.screenshot({ path: join(SHOT_DIR, `contents-${ENGINE}.png`) });

    console.log('\n4. the keyboard');
    const before = await page.evaluate(() => window.kokoro.state.get().index);
    await link.focus();
    await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => document.activeElement?.classList.contains('toc-link'));
    check('ArrowDown moves to the next entry', focused);
    check('... and the reading cursor stays put', (await page.evaluate(() => window.kokoro.state.get().index)) === before);
    await page.keyboard.press('Enter');
    await page.waitForFunction((was) => window.kokoro.state.get().index !== was, before, { timeout: STEP_TIMEOUT_MS })
      .catch(() => {});
    check('Enter jumps the voice to the focused entry', (await page.evaluate(() => window.kokoro.state.get().index)) !== before);

    console.log('');
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch(() => {});
  }
});

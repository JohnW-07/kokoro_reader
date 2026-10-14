// Real-browser check for N4: "sentences cross pages shouldn't be broken up".
//
// On the paper it drives it finds the first sentence the script joined across a page turn
// (two spans, on consecutive pages) and checks:
//   1. it is one sentence: no other sentence holds any of its items on either page.
//   2. read from here on a word of its second half (right-click, Enter) starts that sentence,
//      and /api/tts is asked for its whole text.
//   3. the reading highlight paints both halves, each on its own page, and nothing else.
//   4. no console errors.
// KOKORO_E2E_TURN_TEXT, when set, pins the sentence: the first joined one whose text starts so.
//
// Run: tests/e2e/run.sh <repo-dir> <chromium|webkit> page_turn <port> [log-dir]
// Env: as notes_highlight.mjs (KOKORO_URL, PLAYWRIGHT_DIR, CHROMIUM_PATH, BROWSER, KOKORO_E2E_PDF,
// EMULATE_PYWEBVIEW). The paper must have no notes record on that server: the check refuses to
// touch an existing one, and deletes the record it created when it ends. Exit 0 = pass, 1 = fail.

import { api, check, docIdOf, finish, launch, must, requireEnv } from './lib/harness.mjs';
import { SETTLE_MS, STEP_TIMEOUT_MS, openPaper } from './lib/editor.mjs';

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const TURN_TEXT = process.env.KOKORO_E2E_TURN_TEXT || '';
const MENU = '.read-menu.is-open';
const VIEW_MARGIN_PX = 60;
const MIN_WORD_CHARS = 3;

/** The first sentence joined over a page turn: its index, text and two {page, items} parts. */
const joinedSentence = (page) => page.evaluate((prefix) => {
  const sentences = window.kokoro.state.get().sentences;
  const index = sentences.findIndex((s) => s.spans?.length === 2 && s.spans[1].page === s.spans[0].page + 1
    && s.spans.every((p) => p.items?.length) && s.text.startsWith(prefix));
  if (index < 0) return null;
  const partsOf = (s) => s.spans || [{ page: s.page, items: s.items }];
  const { spans } = sentences[index];
  // A line can end one sentence and start the next, so a neighbour may share the boundary item.
  const boundary = { [index - 1]: [spans[0].page, spans[0].items[0]], [index + 1]: [spans.at(-1).page, spans.at(-1).items.at(-1)] };
  const common = (p) => spans.flatMap(({ page: n, items }) => (p.page === n ? (p.items || []).filter((it) => items.includes(it)) : []));
  const shared = sentences.flatMap((s, i) => (i === index ? [] : partsOf(s)
    .filter((p) => {
      const both = common(p);
      const [bp, bi] = boundary[i] || [];
      return both.length > 0 && !(both.length === 1 && p.page === bp && both[0] === bi);
    })
    .map((p) => `#${i} p${p.page} items ${JSON.stringify(p.items)}: "${s.text.slice(0, 60)}"`)));
  return { index, text: sentences[index].text, spans: sentences[index].spans, shared };
}, TURN_TEXT);

async function showPage(page, n) {
  await page.evaluate((n) => document.querySelector(`.pdf-page-wrap[data-page="${n}"]`).scrollIntoView({ block: 'start' }), n);
  await page.waitForFunction((n) => document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`).length > 0,
    n, { timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
}

/** The pdf.js item indices of the spans the reading highlight marks on page `n`. */
const readingItems = (page, n) => page.evaluate((n) => [...document.querySelectorAll(
  `.pdf-page-wrap[data-page="${n}"] .textLayer .reading`)].map((el) => window.kokoro.pdfView.itemIndexOf(n, el)), n);

/** A word of `part` on screen, as a point to click. */
const wordOf = (page, part) => page.evaluate(({ n, items, margin, minChars }) => {
  const hit = [...document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer span:not(.markedContent)`)]
    .map((el) => ({ el, r: el.getBoundingClientRect(), item: window.kokoro.pdfView.itemIndexOf(n, el) }))
    .find(({ el, r, item }) => items.includes(item) && el.textContent.trim().length >= minChars
      && r.top > margin && r.bottom < innerHeight - margin);
  return hit ? { x: hit.r.left + hit.r.width / 2, y: hit.r.top + hit.r.height / 2, item: hit.item } : null;
}, { n: part.page, items: part.items, margin: VIEW_MARGIN_PX, minChars: MIN_WORD_CHARS });

/** Wait for a /api/tts request for `text`, or the deadline. */
async function ttsRequestFor(page, requests, text) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!requests.includes(text) && Date.now() < deadline) await page.waitForTimeout(SETTLE_MS);
  return requests.includes(text);
}

async function run() {
  const docId = docIdOf(PDF);
  const { docs } = await api('api/notes');
  if ((docs || []).some((d) => d.doc_id === docId)) {
    throw new Error('the server already holds a notes record for this paper; run it against a scratch KOKORO_DATA_DIR');
  }
  const errors = [];
  const { browser, page } = await launch(errors);
  const ttsTexts = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/api/tts') ttsTexts.push(url.searchParams.get('text'));
  });
  try {
    await openPaper(page, PDF);
    console.log('\n1. a sentence over a page turn is one sentence');
    const joined = await joinedSentence(page);
    must('the script holds a sentence joined over a page turn', Boolean(joined), TURN_TEXT && `starting "${TURN_TEXT}"`);
    const [head, tail] = joined.spans;
    console.log(`        #${joined.index}, pages ${head.page}|${tail.page}: "${joined.text.slice(0, 80)}"`);
    console.log(`        spans ${JSON.stringify(joined.spans)}`);
    check('no other sentence holds any of its items on either page', joined.shared.length === 0, joined.shared.join(' | '));

    console.log(`\n2. read from here on its half on page ${tail.page}`);
    await showPage(page, tail.page);
    const word = await wordOf(page, tail);
    must(`a word of the page ${tail.page} half is on screen`, Boolean(word));
    await page.mouse.click(word.x, word.y, { button: 'right' });
    must('the read menu opens', await page.waitForSelector(MENU, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false));
    await page.keyboard.press('Enter');
    await page.waitForFunction((want) => window.kokoro.state.get().index === want, joined.index, { timeout: STEP_TIMEOUT_MS })
      .catch(() => {});
    const index = await page.evaluate(() => window.kokoro.state.get().index);
    check(`it starts the joined sentence #${joined.index}`, index === joined.index, `index ${index}`);
    check('/api/tts is asked for the whole sentence', await ttsRequestFor(page, ttsTexts, joined.text));
    await page.evaluate(() => window.kokoro.player.pause());   // hold the place while the pages are looked at
    check('pausing holds the place on it', await page.evaluate(() => window.kokoro.state.get().index) === joined.index);

    console.log('\n3. the reading highlight paints both halves');
    for (const part of joined.spans) {
      await showPage(page, part.page);
      const marked = await readingItems(page, part.page);
      check(`page ${part.page} is highlighted`, marked.length > 0);
      check(`... only on that half's items`, marked.every((it) => part.items.includes(it)),
        JSON.stringify({ marked, items: part.items }));
    }
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
  }
}

await finish(run);

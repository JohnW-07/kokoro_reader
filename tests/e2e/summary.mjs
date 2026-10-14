// Real-browser check for N9 (the Summary tab). UNRUN as written (S2): no browser was started.
//
// On KOKORO_E2E_PDF, with /api/tts answered by a long silent WAV and /api/summary by a canned
// reply (no model is loaded):
//   1. the four sidebar tabs fit, none cut off, and Summary opens its panel.
//   2. "Summarise this page" posts the cursor page's text and shows the summary, its source
//      and the "may omit details" note.
//   3. with the main reader playing, Play on the summary pauses the main reader first.
//   4. starting the main reader again pauses the summary.
//   5. a 503 shows its reason in the panel.
//   no console errors through step 4 (step 5's 503 logs one by design).
//
// Run: tests/e2e/run.sh <repo> chromium summary <port>, with KOKORO_E2E_PDF set.
// Exit code 0 = pass, 1 = fail.

import { api, check, docIdOf, finish, launch, must, requireEnv } from './lib/harness.mjs';
import { STEP_TIMEOUT_MS, openPaper } from './lib/editor.mjs';

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const WAV_RATE = 8000;
const SENTENCE_AUDIO_MS = 20000;   // no sentence ends by itself during a case
const CANNED = 'The page reports 12 runs. Accuracy was 91.4 percent.';
const UNAVAILABLE = 'Apple Intelligence is turned off in System Settings';

/** A mono 16-bit PCM WAV of silence (as media_keys.mjs). */
function silentWav(ms) {
  const bytes = Math.round((WAV_RATE * ms) / 1000) * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(WAV_RATE, 24); b.writeUInt32LE(WAV_RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

const mainRunning = (page) => page.evaluate(() => window.kokoro.player.state().isRunning);
const waitMain = (page, on) => page.waitForFunction((want) => window.kokoro.player.state().isRunning === want,
  on, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false);
const playLabel = (page) => page.$eval('.summary-play', (el) => el.textContent);

/** Space with nothing focused: the transport's Play button lives in the Read tab, hidden here. */
const toggleMain = async (page) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Space');
};

await finish(async () => {
  const docId = docIdOf(PDF);
  const errors = [];
  const { browser, page } = await launch(errors);
  const posts = [];
  const reply = { status: 200, body: { summary: CANNED, backend: 'apple', cached: false } };
  const wav = silentWav(SENTENCE_AUDIO_MS);
  await page.route('**/api/tts?**', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }));
  await page.route('**/api/summary', (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
  });
  try {
    await openPaper(page, PDF);

    console.log('\n1. four tabs');
    const tabs = await page.$$eval('.tab', (els) => els.map((t) => ({ name: t.textContent, cut: t.scrollWidth > t.clientWidth })));
    check('Read, Subs, Summary, Settings', tabs.map((t) => t.name).join() === 'Read,Subs,Summary,Settings', JSON.stringify(tabs));
    check('... and no label is cut off', tabs.every((t) => !t.cut), JSON.stringify(tabs));
    await page.click('.tab[data-tab="summary"]');
    must('the Summary panel opens', await page.isVisible('#tab-summary .summary-btn'));

    console.log('\n2. summarise this page');
    const cursorPage = await page.evaluate(() => {
      const s = window.kokoro.state.get();
      return s.sentences[s.index]?.page;
    });
    await page.click('#tab-summary .summary-btn');
    await page.waitForSelector('.summary-result:not([hidden])', { timeout: STEP_TIMEOUT_MS });
    check('one POST, for the cursor page, asking Apple', posts.length === 1 && posts[0].page === cursorPage
      && posts[0].backend === 'apple' && posts[0].text.length > 0, JSON.stringify(posts.map((p) => ({ ...p, text: p.text.length }))));
    check('the summary is shown', (await page.textContent('.summary-text')).trim() === CANNED);
    check('... with its source', /Apple on-device model/.test(await page.textContent('.summary-heading')));
    check('... and the "may omit details" note', /may omit details/i.test(await page.textContent('.summary-note')));

    console.log('\n3. Play pauses the main reader first');
    await toggleMain(page);
    must('the main reader starts', await waitMain(page, true));
    await page.click('.summary-play');
    check('the main reader is paused', await waitMain(page, false));
    check('the summary plays', await page.waitForFunction(() => document.querySelector('.summary-play').textContent === 'Pause summary',
      null, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false));

    console.log('\n4. the main reader pauses the summary');
    await toggleMain(page);
    must('the main reader starts again', await waitMain(page, true));
    check('the summary is paused', await page.waitForFunction(() => document.querySelector('.summary-play').textContent === 'Play summary',
      null, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false), await playLabel(page));
    await toggleMain(page);
    check('... and stays the only voice', !(await mainRunning(page)) && (await playLabel(page)) === 'Play summary');

    console.log('');
    check('no console errors', errors.length === 0, errors.join(' | '));   // before the 503 logs its own

    console.log('\n5. an unavailable backend says why');
    Object.assign(reply, { status: 503, body: { detail: UNAVAILABLE } });
    await page.evaluate((opts) => window.kokoro.state.set({ options: { ...window.kokoro.state.get().options, ...opts } }), { use_llm: false });
    await page.click('#tab-summary .summary-btn');
    check('the reason is shown', await page.waitForFunction((why) => document.querySelector('.summary-status').textContent.includes(why),
      UNAVAILABLE, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch(() => {});
  }
});

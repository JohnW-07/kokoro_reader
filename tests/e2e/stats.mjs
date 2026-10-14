// Real-browser check for W1, the Reading Wrapped stats page.
//
// With /api/tts answered by a short silent WAV, it plays a few sentences of a paper and then:
//   1. the sidebar's stats button (Enter on it) flushes the listening log and opens stats.html
//      in a modal dialog; the page shows non-zero listening time, sentences and a top paper,
//      and the server summary agrees (seconds no more than the wall time played).
//   1b. (N11) the reader's status bar shows an ETA, and the dialog's "This paper" section shows
//      this paper's listening time, % heard and sentences left, matching the server's paper.
//   2. Escape inside the page closes the dialog and the focus returns to the button.
//   3. Reset asks first: Cancel keeps the numbers, Reset clears them (page and server).
//   3b. leaving the page (pagehide) sends the pending batch without opening stats (J10).
//   4. the standalone page has no horizontal scroll at phone width, and it stays light under a
//      dark system appearance (light only, like the reader: D6).
//   5. no console errors.
// Screenshots (dialog, standalone wide/narrow, and under a dark system scheme) go to SHOT_DIR.
//
// Run: tests/e2e/run.sh <repo-dir> <chromium|webkit> stats <port> [log-dir]
// Env: as highlight_order.mjs. The server must be a scratch one: the check resets its stats, and
// refuses to run if the paper already has a notes record (it deletes the one it creates).

import { join } from 'node:path';
import { BASE_URL, ENGINE, SHOT_DIR, api, check, docIdOf, finish, launch, must, requireEnv } from './lib/harness.mjs';
import { SETTLE_MS, STEP_TIMEOUT_MS, openPaper } from './lib/editor.mjs';

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const WAV_RATE = 8000;
const SENTENCE_AUDIO_MS = 1000;
const SENTENCES_TO_PLAY = 4;
const PLAY_SLACK_MS = 1500;
const POLL_MS = 200;
const NARROW = { width: 390, height: 844 };
const WIDE = { width: 1440, height: 900 };

/** A mono 16-bit PCM WAV of silence: a canonical 44-byte RIFF header, then zeros. */
function silentWav(ms) {
  const bytes = Math.round((WAV_RATE * ms) / 1000) * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(WAV_RATE, 24); b.writeUInt32LE(WAV_RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

const shot = (page, name) => page.screenshot({ path: join(SHOT_DIR, `stats_${ENGINE}_${name}.png`), fullPage: true });

/** Wait until stats.html (a page, or the dialog's frame) has rendered. */
async function rendered(frame) {
  await frame.waitForFunction(() => document.getElementById('st-hero-sub')?.textContent
    && !document.body.hasAttribute('aria-busy'), null, { timeout: STEP_TIMEOUT_MS });
}

async function openDialog(page) {
  await page.focus('#statsBtn');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('stats-dialog')?.open, null, { timeout: STEP_TIMEOUT_MS });
  const frame = await (await page.$('#stats-dialog iframe')).contentFrame();
  must('the dialog holds a frame', Boolean(frame));
  await frame.waitForURL(/\/static\/stats\.html/, { timeout: STEP_TIMEOUT_MS });
  await rendered(frame);
  return frame;
}

async function heroText(frame) {
  return frame.evaluate(() => ({
    value: document.getElementById('st-hero-value').textContent,
    sub: document.getElementById('st-hero-sub').textContent,
    papers: document.querySelectorAll('#st-top .st-paper').length,
    peak: document.querySelectorAll('#st-hours .st-bar.is-peak').length,
  }));
}

async function playSome(page) {
  const started = Date.now();
  await page.click('#ppBtn');
  await page.waitForTimeout(SENTENCES_TO_PLAY * SENTENCE_AUDIO_MS + PLAY_SLACK_MS);
  await page.click('#ppBtn');
  await page.waitForTimeout(SETTLE_MS);
  return (Date.now() - started) / 1000;
}

/** Listening seconds on the server once they turn non-zero, or 0 after `timeoutMs`. */
async function pollSeconds(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { listening } = await api('api/stats');
    if (listening.seconds > 0) return listening.seconds;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return 0;
}

async function checkNarrow(page, scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize(NARROW);
  await page.goto(new URL('static/stats.html', BASE_URL).href);
  await rendered(page);
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    closeHidden: document.getElementById('st-close').hidden,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  check(`${scheme}, ${NARROW.width}px: no horizontal scroll`, layout.overflow <= 0, `overflow ${layout.overflow}px`);
  check(`${scheme}: standalone page hides its Close button`, layout.closeHidden);
  await shot(page, `${scheme}_narrow`);
  await page.setViewportSize(WIDE);
  await shot(page, `${scheme}_wide`);
  return layout.bg;
}

async function run() {
  const docId = docIdOf(PDF);
  const { docs } = await api('api/notes');
  if ((docs || []).some((d) => d.doc_id === docId)) {
    throw new Error('the server already holds a notes record for this paper; run it against a scratch KOKORO_DATA_DIR');
  }
  await api('api/stats/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'reset' }) });
  const errors = [];
  const { browser, page } = await launch(errors);
  const wav = silentWav(SENTENCE_AUDIO_MS);
  await page.context().route('**/api/tts?**', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }));
  try {
    await openPaper(page, PDF);
    const played = await playSome(page);

    console.log('\n1. the stats button opens Wrapped with what was just heard');
    const frame = await openDialog(page);
    const hero = await heroText(frame);
    const summary = await api('api/stats');
    check('the hero number is not zero', hero.value !== '0', JSON.stringify(hero));
    check('server: listening seconds > 0 and no more than the time played',
      summary.listening.seconds > 0 && summary.listening.seconds <= played,
      `${summary.listening.seconds} s of ${played} s`);
    check('server: at least 2 sentences heard, with words', summary.listening.sentences >= 2
      && summary.listening.words > summary.listening.sentences, JSON.stringify(summary.listening));
    check('server: the paper was opened and is the top paper',
      summary.papers.opened >= 1 && summary.top_papers[0]?.doc_id === docId, JSON.stringify(summary.top_papers));
    check('the page lists the top paper and marks a peak hour', hero.papers === 1 && hero.peak === 1, JSON.stringify(hero));
    check('the hero line counts the sentences', hero.sub.startsWith(`${summary.listening.sentences} sentences`), hero.sub);
    const voiceRows = await frame.evaluate(() => ({
      hidden: document.getElementById('st-voices').hidden,
      rows: document.querySelectorAll('#st-voices-body tr').length,
    }));
    check('R8: the by-voice table has one row per server row, hidden when there are none',
      voiceRows.rows === summary.tts.by_voice.length && voiceRows.hidden === (voiceRows.rows === 0),
      `${JSON.stringify(voiceRows)} vs ${summary.tts.by_voice.length}`);
    await shot(page, 'light_dialog');

    console.log('\n1b. N11: the ETA beside the page pill, and "This paper" in the dialog');
    const etaPill = await page.evaluate(() => {
      const pill = document.getElementById('eta-pill');
      return { hidden: pill.hidden, text: pill.textContent };
    });
    check('the status bar shows the ETA', !etaPill.hidden && /^≈.+ left on page · .+ in paper$/.test(etaPill.text),
      JSON.stringify(etaPill));
    const paper = await frame.evaluate(() => ({
      hidden: document.getElementById('st-paper-panel').hidden,
      cards: [...document.querySelectorAll('#st-paper .st-card')].map((c) => [
        c.querySelector('.st-label').textContent, c.querySelector('.st-value').textContent]),
    }));
    const byLabel = Object.fromEntries(paper.cards);
    const server = (await api(`api/stats?doc=${docId}`)).paper;
    check('"This paper" shows five cards', !paper.hidden && paper.cards.length === 5, JSON.stringify(paper));
    check('server: the paper\'s seconds match the summary',
      Math.abs((server?.seconds ?? -1) - summary.listening.seconds) < 1,
      `${server?.seconds} vs ${summary.listening.seconds}`);
    check('heard is a non-zero share and sentences are left',
      /^[1-9]\d*%$/.test(byLabel.Heard || '') && Number((byLabel['Sentences left'] || '').replace(/,/g, '')) > 0,
      JSON.stringify(byLabel));
    check('the paper ETAs read as approximate durations',
      /^≈/.test(byLabel['Left on this page'] || '') && /^≈/.test(byLabel['Left in the paper'] || ''), JSON.stringify(byLabel));

    console.log('\n2. Escape closes it and gives the focus back');
    await frame.focus('#st-year');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('stats-dialog').open, null, { timeout: STEP_TIMEOUT_MS });
    check('the focus is back on the stats button',
      await page.evaluate(() => document.activeElement?.id === 'statsBtn'));

    console.log('\n3. Reset asks first');
    const again = await openDialog(page);
    await again.click('#st-reset-start');
    check('the confirm step shows, focused on Cancel', await again.evaluate(() =>
      !document.getElementById('st-confirm').hidden && document.activeElement?.id === 'st-reset-cancel'));
    await again.click('#st-reset-cancel');
    check('Cancel keeps the numbers', (await api('api/stats')).listening.seconds > 0);
    await again.click('#st-reset-start');
    await again.click('#st-reset-go');
    await again.waitForFunction(() => document.getElementById('st-status').textContent === 'Stats reset.',
      null, { timeout: STEP_TIMEOUT_MS });
    check('the page shows zero', (await heroText(again)).value === '0');
    check('server: zero after reset', (await api('api/stats')).listening.seconds === 0);
    await page.keyboard.press('Escape');

    console.log('\n3b. leaving the page sends the pending batch (pagehide beacon, J10)');
    await page.waitForFunction(() => !document.getElementById('stats-dialog').open, null, { timeout: STEP_TIMEOUT_MS });
    await playSome(page);
    await page.goto('about:blank');
    const beaconed = await pollSeconds(STEP_TIMEOUT_MS);
    check('server: listening seconds > 0 after leaving, without opening stats', beaconed > 0, `${beaconed} s`);

    console.log('\n4. standalone page at phone width; it stays light under a dark system scheme');
    const light = await checkNarrow(page, 'light');
    const dark = await checkNarrow(page, 'dark');
    check('a dark system scheme leaves the page light (D6)', light === dark, `${light} vs ${dark}`);
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
  }
}

await finish(run);

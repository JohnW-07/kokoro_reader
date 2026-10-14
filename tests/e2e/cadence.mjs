// Real-browser measurement for N5 stage 1 (docs/14-feedback-2026-10-09.md, C1): "cadence from
// sentence to sentence is a bit choppy".
//
// It drives, on KOKORO_E2E_PDF, with /api/tts answered by a silent WAV of known length:
//   1. every request names a pause tier (sentence | paragraph | section).
//   2. the hand-over: for consecutive sentences, (next element's media-clock start) −
//      (previous element's clock start + its duration). A clock start is dated from the
//      element itself: the earliest performance.now() − currentTime over every probe while
//      it plays (Chromium steps currentTime ~64 ms, so a single reading is up to that late).
//      `playing` is not used: WebKit fires it ~240 ms before its clock moves (C1b).
//      Printed per boundary with the `playing`-based figure beside it. The lead is learnt
//      from these gaps (cadence.nextLead), so the first WARMUP_BOUNDARIES are printed, not
//      bounded (WebKit: 293–547 ms at the 50 ms default); after them the check bounds every
//      gap on both sides. Both engines start a clock on a ~64 ms grid here (gaps cluster at
//      −28/+36, −50/+36), so ±one step is the floor, not jitter to tune away.
//   3. no console errors.
// NOT a test of what is audible: the clock is when the element consumes samples, not when
// the sound reaches the speaker (the same output latency for both elements); and the silent
// WAV carries no server-side pause, so the pause itself needs John's ear test.
//
// Run: tests/e2e/run.sh <repo-dir> <chromium|webkit> cadence <port> [log-dir]
// Env: as media_keys.mjs. The paper must have no notes record on that server. Exit 0 = pass.

import { api, check, docIdOf, finish, launch, must, requireEnv } from './lib/harness.mjs';
import { STEP_TIMEOUT_MS, openPaper } from './lib/editor.mjs';

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const WAV_RATE = 8000;
const SENTENCE_AUDIO_MS = 1500;
const BOUNDARIES = 10;
const WARMUP_BOUNDARIES = 2;                    // the lead converges over these
const PROBE_MS = 10;                            // clock probe period (WebKit clamps it to ~110)
const MAX_LATE_MS = 60;                         // after the end: start-up latency left uncovered
const MAX_EARLY_MS = 100;                       // before the end: eats into the silent tail
const PAUSES = new Set(['sentence', 'paragraph', 'section']);

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

/**
 * Date every sentence's media-clock start, per element and src, and record `playing` (media
 * events do not bubble, but they do capture) for the comparison.
 */
const recordStarts = (probeMs) => {
  const clocks = new Map();   // src → {start, ms}, in the order sentences started
  window.__clocks = () => [...clocks.values()];
  window.__starts = [];
  setInterval(() => {
    for (const el of document.querySelectorAll('audio')) {
      const src = el.currentSrc || el.src;
      if (!src || el.paused || !(el.currentTime > 0)) continue;
      const start = performance.now() - el.currentTime * 1000;
      const seen = clocks.get(src);
      if (!seen || start < seen.start) clocks.set(src, { start, ms: el.duration * 1000 });
    }
  }, probeMs);
  document.addEventListener('playing', (ev) => {
    window.__starts.push({ at: performance.now(), src: ev.target.currentSrc || ev.target.src });
  }, true);
};

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function handoverCase(page) {
  await page.click('#ppBtn');
  await page.waitForFunction((n) => window.kokoro.player.state().index >= n, BOUNDARIES,
    { timeout: STEP_TIMEOUT_MS + BOUNDARIES * SENTENCE_AUDIO_MS });
  const { clocks, starts } = await page.evaluate(() => ({ clocks: window.__clocks(), starts: window.__starts }));
  const gaps = clocks.slice(1, BOUNDARIES).map((c, i) => Math.round(c.start - (clocks[i].start + clocks[i].ms)));
  const fresh = starts.filter((s, i) => i === 0 || s.src !== starts[i - 1].src);   // one per sentence
  const byPlaying = fresh.slice(1, BOUNDARIES).map((s, i) => Math.round(s.at - (fresh[i].at + SENTENCE_AUDIO_MS)));
  console.log(`  clock gaps (ms, next clock start − previous clock end): ${gaps.join(', ')}  median ${median(gaps)}`);
  console.log(`  \`playing\`-based, for comparison: ${byPlaying.join(', ')}  median ${median(byPlaying)}`);
  must('measured every boundary', gaps.length === BOUNDARIES - 1, JSON.stringify(clocks));
  const settled = gaps.slice(WARMUP_BOUNDARIES);
  console.log(`  after ${WARMUP_BOUNDARIES} warm-up boundaries: ${settled.join(', ')}  median ${median(settled)}`);
  check(`no boundary starts more than ${MAX_EARLY_MS} ms before the end (inside the silent tail)`,
    settled.every((g) => g >= -MAX_EARLY_MS), settled.join(','));
  check(`no boundary lags its end by more than ${MAX_LATE_MS} ms`, settled.every((g) => g <= MAX_LATE_MS),
    settled.join(','));
}

async function run() {
  const docId = docIdOf(PDF);
  const { docs } = await api('api/notes');
  must('no notes record for this paper yet', !(docs || []).some((d) => d.doc_id === docId));
  const errors = [];
  const { browser, page } = await launch(errors);
  const wav = silentWav(SENTENCE_AUDIO_MS);
  const pauses = [];
  await page.route('**/api/tts?**', (route) => {
    pauses.push(new URL(route.request().url()).searchParams.get('pause'));
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  await page.addInitScript(recordStarts, PROBE_MS);
  try {
    await openPaper(page, PDF);
    await handoverCase(page);
    check('every request names a pause tier', pauses.length > 0 && pauses.every((p) => PAUSES.has(p)),
      pauses.join(','));
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
  }
}

await finish(run);

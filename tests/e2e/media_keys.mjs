// Real-browser check for N6 (docs/14-feedback-2026-10-09.md): "play button behavior isn't perfect,
// especially when pressing the play pause button on my laptop" (F8, via navigator.mediaSession).
//
// It drives, on KOKORO_E2E_PDF, with /api/tts answered by a long silent WAV (held on demand):
//   1. a pause from outside the player (the live <audio> paused by the page, as the OS does on F8)
//      turns #ppBtn to Play and the status to "Paused"; an outside play turns it back.
//   2. the registered mediaSession handlers (captured by an init script) pause, play, and step
//      next / previous; playbackState and the metadata title follow. Skipped where the engine
//      has no navigator.mediaSession.
//   3. a pause while a sentence is still loading is kept: when the audio arrives nothing plays,
//      and Play then starts that sentence.
//   4. no console errors.
// NOT a test of the real F8 key: whether pywebview's WKWebView routes it to mediaSession needs a
// manual check in the desktop app.
//
// Run: tests/e2e/run.sh <repo-dir> <chromium|webkit> media_keys <port> [log-dir]
// Env: as voice_status.mjs. The paper must have no notes record on that server. Exit 0 = pass.

import { api, check, docIdOf, finish, launch, must, requireEnv } from './lib/harness.mjs';
import { SETTLE_MS, STEP_TIMEOUT_MS, openPaper } from './lib/editor.mjs';

/** ~5 s when healthy; headless WebKit can deadlock its GPU process mid-run (C1b). */
const RUN_DEADLINE_MS = 2 * 60 * 1000;

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const WAV_RATE = 8000;
const SENTENCE_AUDIO_MS = 20000;   // no sentence ends by itself during a case
const JUMP = 10;                   // past the prefetch window, so the jump really loads

/** A mono 16-bit PCM WAV of silence (as follow.mjs). */
function silentWav(ms) {
  const bytes = Math.round((WAV_RATE * ms) / 1000) * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(WAV_RATE, 24); b.writeUInt32LE(WAV_RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

/** Record every mediaSession action handler the app registers, as window.__mediaHandlers. */
const captureHandlers = () => {
  window.__mediaHandlers = {};
  const session = navigator.mediaSession;
  if (!session) return;
  // WebKit garbage-collects an unreferenced navigator.mediaSession wrapper, and with it the
  // override below — the app then registers on a fresh wrapper and nothing is captured.
  window.__mediaSession = session;
  const register = session.setActionHandler.bind(session);
  session.setActionHandler = (name, fn) => { window.__mediaHandlers[name] = fn; register(name, fn); };
};

const ui = (page) => page.evaluate(() => ({
  pressed: document.getElementById('ppBtn').getAttribute('aria-pressed'),
  isPlaying: window.kokoro.player.state().isPlaying,
  index: window.kokoro.player.state().index,
  sounding: [...document.querySelectorAll('audio')].filter((a) => !a.paused).length,
  session: navigator.mediaSession?.playbackState ?? null,
  title: navigator.mediaSession?.metadata?.title ?? null,
  docName: window.kokoro.state.get().docName,
}));
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: STEP_TIMEOUT_MS });
// Headless WebKit can deadlock (GPU process, AVPlayer rateChanged) when an element is paused or
// re-src-ed while its play() is still starting, ~30-90 ms in (C1b). A person can't press that
// fast, so each case lets the sound settle before it interrupts it.
const playing = async (page) => {
  await until(page, () => window.kokoro.player.state().isPlaying);
  await page.waitForTimeout(SETTLE_MS);
};

async function outsidePauseCase(page) {
  await page.click('#ppBtn');
  await playing(page);
  await page.evaluate(() => { window.__live = [...document.querySelectorAll('audio')].find((a) => !a.paused); window.__live.pause(); });
  await page.waitForTimeout(SETTLE_MS);
  const paused = await ui(page);
  check('an outside pause shows Play, and the player knows', paused.pressed === 'false' && !paused.isPlaying, JSON.stringify(paused));
  check('…and the status says Paused', /Paused/.test(await page.textContent('#status-bar')));
  // The same element: the spare holds a src too. Not awaited in the page: a play() promise
  // WebKit never settles would hang evaluate() — the 3.5 h hang (C1b).
  await page.evaluate(() => { window.__live.play().catch(() => {}); });
  await page.waitForTimeout(SETTLE_MS);
  const resumed = await ui(page);
  check('an outside play shows Pause again', resumed.pressed === 'true' && resumed.isPlaying, JSON.stringify(resumed));
}

async function sessionCase(page) {
  if (!(await page.evaluate(() => 'mediaSession' in navigator))) {
    console.log('  SKIP  no navigator.mediaSession in this engine');
    return;
  }
  const names = await page.evaluate(() => Object.keys(window.__mediaHandlers).sort().join(','));
  check('play, pause, next and previous are registered', names === 'nexttrack,pause,play,previoustrack', names);
  await page.evaluate(() => window.__mediaHandlers.pause({ action: 'pause' }));
  await page.waitForTimeout(SETTLE_MS);
  const paused = await ui(page);
  check('the pause handler pauses: button, audio and playbackState agree',
    paused.pressed === 'false' && paused.sounding === 0 && paused.session === 'paused', JSON.stringify(paused));
  await page.evaluate(() => window.__mediaHandlers.play({ action: 'play' }));
  await playing(page);
  const resumed = await ui(page);
  check('the play handler resumes', resumed.pressed === 'true' && resumed.session === 'playing', JSON.stringify(resumed));
  check('metadata names the paper', resumed.title === resumed.docName, JSON.stringify(resumed));
  // Step while paused: during playback the cursor also moves on by itself, so +1 could be missed.
  await page.evaluate(() => window.__mediaHandlers.pause({ action: 'pause' }));
  await page.waitForTimeout(SETTLE_MS);
  const at = (await ui(page)).index;
  await page.evaluate(() => window.__mediaHandlers.nexttrack({ action: 'nexttrack' }));
  await until(page, (n) => window.kokoro.player.state().index === n + 1, at);
  await playing(page);
  await page.evaluate(() => window.__mediaHandlers.previoustrack({ action: 'previoustrack' }));
  await until(page, (n) => window.kokoro.player.state().index === n, at);
  check('next and previous step the cursor', true);
  await page.evaluate(() => window.__mediaHandlers.play({ action: 'play' }));   // the next case starts from playback
  await playing(page);
}

async function pauseWhileLoadingCase(page, gate) {
  gate.hold = true;
  await page.evaluate((n) => {   // a jump JUMP sentences on: nothing prefetched there
    window.kokoro.player.play(window.kokoro.player.state().index + n);
  }, JUMP);
  await until(page, () => window.kokoro.player.state().isLoading);
  await page.click('#ppBtn');
  gate.release();
  await page.waitForTimeout(SETTLE_MS * 3);
  const held = await ui(page);
  check('a pause mid-load is kept: nothing plays when the audio arrives',
    held.sounding === 0 && !held.isPlaying && held.pressed === 'false', JSON.stringify(held));
  await page.click('#ppBtn');
  await playing(page);
  check('Play then starts the sentence that was loading', (await ui(page)).index === held.index);
}

async function run() {
  const docId = docIdOf(PDF);
  const { docs } = await api('api/notes');
  must('no notes record for this paper yet', !(docs || []).some((d) => d.doc_id === docId));
  const errors = [];
  const { browser, page } = await launch(errors);
  const wav = silentWav(SENTENCE_AUDIO_MS);
  const waiting = [];
  const gate = { hold: false, release() { this.hold = false; waiting.splice(0).forEach((go) => go()); } };
  await page.route('**/api/tts?**', (route) => {
    const go = () => route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
    return gate.hold ? waiting.push(go) : go();
  });
  await page.addInitScript(captureHandlers);
  try {
    await openPaper(page, PDF);
    await outsidePauseCase(page);
    await sessionCase(page);
    await pauseWhileLoadingCase(page, gate);
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
  }
}

await finish(run, RUN_DEADLINE_MS);

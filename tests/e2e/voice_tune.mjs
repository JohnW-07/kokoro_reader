// Real-browser check for V1 (docs/18-feedback-2026-10-14.md): "Personalise voice" in Settings.
//   Stage B: the Pitch and Expressiveness sliders (voiceshape.js) reach /api/tts as `pitch`/`expr`,
//   the server renders them, and they survive a reload.
//
// It drives, on KOKORO_E2E_PDF:
//   1. the Settings tab shows "Personalise voice", folded; opening it shows both sliders at neutral.
//   2. moving Pitch to +10% and Expressiveness to 130% updates both labels and saves them.
//   3. Play: the sentence's /api/tts request carries pitch=1.1&expr=1.3 and is answered 200, and it plays.
//   4. a reload keeps both settings, in the sliders and their labels.
//   Stage C: Bass, Treble and Even out (voicefx.js), applied live through Web Audio.
//   5. at neutral nothing is routed through Web Audio (no AudioContext).
//   6. moving Bass/Treble/Even out builds the chain, sets its knobs live, and saves them.
//   7. reload with them saved (the context is made without a gesture), Play: the context runs and
//      sound actually flows through the chain (an AnalyserNode tapped after the compressor reads a
//      non-silent level) — the risk is a suspended context playing silence in WKWebView.
//   8. no console errors.
//
// Run: tests/e2e/run.sh <repo-dir> <chromium|webkit> voice_tune <port> [log-dir]
// Env: as voice_status.mjs (scratch KOKORO_DATA_DIR: the paper must have no notes record).
// Exit 0 = pass, 1 = fail.

import { api, check, docIdOf, finish, launch, must, requireEnv } from './lib/harness.mjs';
import { LOAD_TIMEOUT_MS, SETTLE_MS, STEP_TIMEOUT_MS, openPaper } from './lib/editor.mjs';

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const PITCH = '1.1';
const EXPR = '1.3';
const PREF_KEY = 'kokoro.prefs.v2';   // state.js
const BASS_DB = '6';
const TREBLE_DB = '-3';
const EVEN = '0.5';
const SILENT_RMS = 1e-4;              // below this the tap heard nothing
const LISTEN_MS = 3000;

/** Before any page script: keep a handle on each AudioContext and its filter/compressor nodes. */
function recordWebAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  window.__fx = { contexts: [], filters: [], comps: [] };
  const filter = Ctx.prototype.createBiquadFilter;
  const comp = Ctx.prototype.createDynamicsCompressor;
  Ctx.prototype.createBiquadFilter = function f(...a) { const n = filter.apply(this, a); window.__fx.filters.push(n); return n; };
  Ctx.prototype.createDynamicsCompressor = function c(...a) {
    const n = comp.apply(this, a);
    window.__fx.contexts.push(this);
    window.__fx.comps.push(n);
    return n;
  };
}

const fxChain = (page) => page.evaluate(() => {
  const r = window.__fx;
  const [low, high] = r.filters;
  const comp = r.comps[0];
  return {
    contexts: r.contexts.length,
    ...window.kokoro.voicefx.state(),
    bass: low?.gain.value, bassType: low?.type, treble: high?.gain.value, trebleType: high?.type,
    ratio: comp?.ratio.value,
  };
});

/** RMS after the compressor over `ms` of playback: the sound that reaches the speakers. */
const tapLevel = (page, ms) => page.evaluate((wait) => new Promise((resolve) => {
  const ctx = window.__fx.contexts[0];
  const tap = ctx.createAnalyser();
  window.__fx.comps[0].connect(tap);
  const buf = new Float32Array(tap.fftSize);
  let peak = 0;
  const timer = setInterval(() => {
    tap.getFloatTimeDomainData(buf);
    peak = Math.max(peak, Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length));
  }, 50);
  setTimeout(() => { clearInterval(timer); resolve(peak); }, wait);
}), ms);

/** The sliders live in the Settings tab, the Play button in the Read tab. */
const showTab = (page, name) => page.click(`.tab[data-tab="${name}"]`);

const tune = (page) => page.evaluate((key) => {
  const val = (id) => document.getElementById(id);
  const saved = JSON.parse(localStorage.getItem(key) || '{}');
  return {
    open: val('voiceTune').open,
    pitch: val('pitchSlider').value, pitchLabel: val('pitchVal').textContent,
    expr: val('exprSlider').value, exprLabel: val('exprVal').textContent,
    savedPitch: saved.voicePitch, savedExpr: saved.voiceExpr,
  };
}, PREF_KEY);

async function checkShape(page) {
  await showTab(page, 'settings');
  const folded = await tune(page);
  check('"Personalise voice" starts folded', folded.open === false, JSON.stringify(folded));
  await page.click('#voiceTune summary');
  const neutral = await tune(page);
  check('opened: both sliders at neutral', neutral.open && neutral.pitch === '1' && neutral.expr === '1'
    && neutral.pitchLabel === '0%' && neutral.exprLabel === '100%', JSON.stringify(neutral));

  await page.locator('#pitchSlider').fill(PITCH);
  await page.locator('#exprSlider').fill(EXPR);
  const moved = await tune(page);
  check('moved: labels follow and both are saved', moved.pitchLabel === '+10%' && moved.exprLabel === '130%'
    && moved.savedPitch === Number(PITCH) && moved.savedExpr === Number(EXPR), JSON.stringify(moved));

  await showTab(page, 'read');
  const shaped = page.waitForResponse((r) => r.url().includes('/api/tts?'), { timeout: LOAD_TIMEOUT_MS });
  await page.click('#ppBtn');
  const response = await shaped;
  const q = new URL(response.url()).searchParams;
  check('Play: /api/tts carries pitch and expr, answered 200',
    q.get('pitch') === PITCH && q.get('expr') === EXPR && response.status() === 200, response.url());
  const isPlaying = await page.waitForFunction(() => window.kokoro.player.state().isPlaying, null,
    { timeout: LOAD_TIMEOUT_MS }).then(() => true, () => false);
  check('... and it plays', isPlaying);
  await page.click('#ppBtn');
  await page.waitForFunction(() => !window.kokoro.player.state().isPlaying, null, { timeout: STEP_TIMEOUT_MS });

  await page.reload();
  await page.waitForTimeout(SETTLE_MS);
  const reloaded = await tune(page);
  check('a reload keeps both, in sliders and labels', reloaded.pitch === PITCH && reloaded.expr === EXPR
    && reloaded.pitchLabel === '+10%' && reloaded.exprLabel === '130%', JSON.stringify(reloaded));
}

async function checkEffects(page) {
  const neutral = await fxChain(page);
  check('neutral: no AudioContext, nothing routed', neutral.contexts === 0 && neutral.routed === 0, JSON.stringify(neutral));
  await showTab(page, 'settings');
  await page.click('#voiceTune summary');   // a reload folds it again

  await page.locator('#bassSlider').fill(BASS_DB);
  await page.locator('#trebleSlider').fill(TREBLE_DB);
  await page.locator('#evenSlider').fill(EVEN);
  const live = await fxChain(page);
  check('moved: one chain, both player elements routed, knobs set live',
    live.contexts === 1 && live.routed === 2 && live.bassType === 'lowshelf' && live.bass === Number(BASS_DB)
    && live.trebleType === 'highshelf' && live.treble === Number(TREBLE_DB) && live.ratio > 1, JSON.stringify(live));
  const labels = await page.evaluate(() => ['bassVal', 'trebleVal', 'evenVal'].map((id) => document.getElementById(id).textContent));
  check('labels', labels.join() === '+6 dB,−3 dB,50%', labels.join());

  await page.reload();
  await page.waitForTimeout(SETTLE_MS);
  await openPaper(page, PDF);
  const restored = await fxChain(page);
  check('reload: the saved effects are rebuilt before any gesture',
    restored.contexts === 1 && restored.bass === Number(BASS_DB) && restored.treble === Number(TREBLE_DB), JSON.stringify(restored));
  await showTab(page, 'read');
  await page.click('#ppBtn');
  await page.waitForFunction(() => window.kokoro.player.state().isPlaying, null, { timeout: LOAD_TIMEOUT_MS });
  const level = await tapLevel(page, LISTEN_MS);
  const playing = await fxChain(page);
  check('Play: the context runs and the routed elements are the player\'s',
    playing.context === 'running' && playing.routed >= 2, JSON.stringify(playing));
  check('... and sound flows through the effects chain', level > SILENT_RMS, `peak RMS ${level}`);
  await page.click('#ppBtn');
  await page.waitForFunction(() => !window.kokoro.player.state().isPlaying, null, { timeout: STEP_TIMEOUT_MS });
}

async function run() {
  const docId = docIdOf(PDF);
  const { docs } = await api('api/notes');
  must('the server holds no notes record for this paper (scratch KOKORO_DATA_DIR)',
    !(docs || []).some((d) => d.doc_id === docId));
  const errors = [];
  const { browser, page } = await launch(errors);
  try {
    await page.addInitScript(recordWebAudio);
    await openPaper(page, PDF);
    await checkShape(page);
    await checkEffects(page);
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
  }
}

await finish(run);

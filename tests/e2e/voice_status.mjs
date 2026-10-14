// Real-browser check for N1 and N2 (docs/14-feedback-2026-10-09.md):
//   N1 "loading bar upon loading new model or similar to indicate how much of the cached text has
//      been generated": a buffer meter (bufferbar.js), since R4 (docs/15) a thin fill along the
//      bottom edge of the "Sentence x / y" status field.
//   N2 "when using macos voice, switch the dropdown toggle to indicate so": the voice dropdown shows
//      "Siri · Nora (macOS)" selected while the macOS voice is in use. R5 (docs/15): Siri is an
//      option of that dropdown, in a macOS group, so the dropdown stays enabled.
//
// It drives, on KOKORO_E2E_PDF:
//   1. the meter is shown once a paper is open, empty, scaled to the player's look-ahead (3), along
//      the status field's bottom edge and below its text.
//   2. Play on a cold model shows "Loading voice model…" (is-loading) until audio arrives; on a warm
//      model it never does. Then the meter fills to 3 of 3.
//   3. a speed change (cache cleared) empties it.
//   4. picking Siri in the dropdown: it shows Siri; state.voice keeps the Kokoro voice; picking
//      the Kokoro voice again restores it, the Siri option still offered.
//   5. a reload with Siri saved on still shows it once /api/voices has rebuilt the list.
//   6. no console errors.
//
// Run: tests/e2e/run.sh <repo-dir> <chromium|webkit> voice_status <port> [log-dir]
// Env: as notes_highlight.mjs. The paper must have no notes record on that server (playback saves
// a resume position): the check refuses to touch an existing one and deletes the one it creates.
// Exit 0 = pass, 1 = fail.

import { api, check, docIdOf, finish, launch, must, requireEnv } from './lib/harness.mjs';
import { LOAD_TIMEOUT_MS, SETTLE_MS, STEP_TIMEOUT_MS, openPaper } from './lib/editor.mjs';

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const LOOK_AHEAD = '3';               // playback.js PRELOAD_AHEAD
const SIRI_VOICE = 'siri_nora';       // engineswitch.js
const LOADING_TEXT = 'Loading voice model…';
const SPEED_STEP = '1.25';
const EDGE_PX = 2;                    // the field's hairline border, plus sub-pixel rounding

const meter = (page) => page.$eval('#bufferbar', (el) => ({
  now: el.getAttribute('aria-valuenow'),
  max: el.getAttribute('aria-valuemax'),
  isLoading: el.classList.contains('is-loading'),
  label: el.querySelector('.bufferbar-label')?.textContent ?? null,
  height: el.getBoundingClientRect().height,
  ...(() => {
    const box = ({ top, bottom, left, right }) => ({ top, bottom, left, right });
    const field = document.getElementById('status-bar');
    const words = document.createRange();
    words.selectNodeContents(field);
    return { rect: box(el.getBoundingClientRect()), field: box(field.getBoundingClientRect()), text: box(words.getBoundingClientRect()) };
  })(),
}));

const dropdown = (page) => page.evaluate(() => {
  const sel = document.getElementById('voiceSelect');
  return {
    value: sel.value,
    disabled: sel.disabled,
    label: sel.selectedOptions[0]?.textContent ?? '',
    siriOptions: [...sel.options].filter((o) => o.value === 'siri_nora').length,
    stateVoice: window.kokoro.state.get().voice,
  };
});

/** R5: Siri and the Kokoro voices are all picked in the voice dropdown. */
async function pickVoice(page, voice) {
  await page.selectOption('#voiceSelect', voice);
  await page.waitForTimeout(SETTLE_MS);
}

async function checkMeter(page) {
  const before = await meter(page);
  must('the meter is shown once a paper is open', before.height > 0, JSON.stringify(before));
  const { rect, field, text } = before;
  check('it runs along the status field\'s bottom edge, inside the field (R4)',
    rect.left >= field.left && rect.right <= field.right && rect.bottom <= field.bottom && field.bottom - rect.bottom <= EDGE_PX,
    JSON.stringify({ rect, field }));
  check('... below the status text, not over it', text.bottom <= rect.top + EDGE_PX, JSON.stringify({ text, rect }));
  check('it starts empty, scaled to the look-ahead', before.now === '0' && before.max === LOOK_AHEAD, JSON.stringify(before));

  const { tts_ready: isWarm } = await api('api/health');
  await page.click('#ppBtn');
  if (isWarm) {
    await page.waitForFunction(() => window.kokoro.player.state().isPlaying, null, { timeout: LOAD_TIMEOUT_MS });
    check('warm model: no loading state', !(await meter(page)).isLoading);
  } else {
    const seen = await page.waitForSelector('#bufferbar.is-loading', { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false);
    check('cold model: "Loading voice model…" while it loads', seen && (await meter(page)).label === LOADING_TEXT);
    await page.waitForFunction(() => !document.getElementById('bufferbar').classList.contains('is-loading'),
      null, { timeout: LOAD_TIMEOUT_MS });
  }
  const filled = await page.waitForFunction((max) => document.getElementById('bufferbar').getAttribute('aria-valuenow') === max,
    LOOK_AHEAD, { timeout: LOAD_TIMEOUT_MS }).then(() => true, () => false);
  check('playing fills the meter to the look-ahead', filled, JSON.stringify(await meter(page)));

  await page.click('#ppBtn');
  await page.waitForFunction(() => !window.kokoro.player.state().isPlaying, null, { timeout: STEP_TIMEOUT_MS });
  await page.$eval('#speedSlider', (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, SPEED_STEP);
  await page.waitForTimeout(SETTLE_MS);
  check('a speed change (cache cleared) empties it', (await meter(page)).now === '0', JSON.stringify(await meter(page)));
}

async function checkDropdown(page) {
  const kokoro = (await dropdown(page)).value;
  await pickVoice(page, SIRI_VOICE);
  const on = await dropdown(page);
  check('Siri on: the dropdown shows the macOS voice, still enabled',
    on.value === SIRI_VOICE && !on.disabled && /macOS/.test(on.label) && on.siriOptions === 1, JSON.stringify(on));
  check('…and state.voice keeps the Kokoro voice', on.stateVoice === kokoro, JSON.stringify(on));

  await pickVoice(page, kokoro);
  const off = await dropdown(page);
  check('Siri off: the Kokoro voice is back, the Siri option still offered',
    off.value === kokoro && !off.disabled && off.siriOptions === 1, JSON.stringify(off));

  await pickVoice(page, SIRI_VOICE);
  const voices = page.waitForResponse((r) => r.url().includes('/api/voices'), { timeout: STEP_TIMEOUT_MS });
  await page.reload();
  await voices;
  await page.waitForTimeout(SETTLE_MS);
  const reloaded = await dropdown(page);
  check('a reload with Siri saved on still shows it after the voice list loads',
    reloaded.value === SIRI_VOICE && reloaded.siriOptions === 1, JSON.stringify(reloaded));
  await pickVoice(page, kokoro);
}

async function run() {
  const docId = docIdOf(PDF);
  const { docs } = await api('api/notes');
  if ((docs || []).some((d) => d.doc_id === docId)) {
    throw new Error('the server already holds a notes record for this paper; run it against a scratch KOKORO_DATA_DIR');
  }
  const errors = [];
  const { browser, page } = await launch(errors);
  try {
    await openPaper(page, PDF);
    await checkMeter(page);
    await checkDropdown(page);
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
  }
}

await finish(run);

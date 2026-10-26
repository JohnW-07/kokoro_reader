// Real-browser check: with the sidebar folded in, the rail's play button carries the buffer
// meter as a ring (bufferbar.js `ring`, docs/18 F3).
//   1. folded in, a paper open: the ring shows (has-ring).
//   2. Play on a fresh cache: the ring spins while the sentence being read loads (is-loading),
//      then fills as audio arrives (--ready > 0), and the voice plays.
//   3. no console errors.
// Run: tests/e2e/run.sh <repo-dir> <chromium|webkit> rail_ring <port> [log-dir]
// Env: KOKORO_E2E_PDF; a scratch KOKORO_DATA_DIR (run.sh makes one), so nothing is cached.
// Optional: KOKORO_E2E_SHOTS=<dir> saves the rail while loading and once filled.
// Exit 0 = pass, 1 = fail.

import { check, finish, launch, requireEnv } from './lib/harness.mjs';
import { LOAD_TIMEOUT_MS, STEP_TIMEOUT_MS, openPaper } from './lib/editor.mjs';

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const SHOTS = process.env.KOKORO_E2E_SHOTS;

const ring = (page) => page.evaluate(() => {
  const el = document.getElementById('railPpBtn');
  return { shown: el.classList.contains('has-ring'), isLoading: el.classList.contains('is-loading'),
    ready: Number(el.style.getPropertyValue('--ready')), visible: !!el.offsetParent };
});
const shot = (page, name) => SHOTS && page.locator('#rail').screenshot({ path: `${SHOTS}/rail_${name}.png` });

async function run() {
  const errors = [];
  const { browser, page } = await launch(errors);
  try {
    await openPaper(page, PDF);
    await page.click('#collapseBtn');
    await page.waitForFunction(() => document.body.classList.contains('sidebar-collapsed'), null, { timeout: STEP_TIMEOUT_MS });
    const folded = await ring(page);
    check('folded in: the rail play button shows the ring', folded.shown && folded.visible, JSON.stringify(folded));

    await page.click('#railPpBtn');
    const sawLoading = await page.waitForFunction(() => document.getElementById('railPpBtn').classList.contains('is-loading'),
      null, { timeout: STEP_TIMEOUT_MS, polling: 20 }).then(() => true, () => false);
    if (sawLoading) await shot(page, 'loading');
    check('Play on a fresh cache: the ring spins while the sentence loads', sawLoading);
    const isPlaying = await page.waitForFunction(() => window.kokoro.player.state().isPlaying, null,
      { timeout: LOAD_TIMEOUT_MS }).then(() => true, () => false);
    check('... and the voice plays', isPlaying);
    const filled = await page.waitForFunction(() => Number(document.getElementById('railPpBtn').style.getPropertyValue('--ready')) > 0,
      null, { timeout: LOAD_TIMEOUT_MS }).then(() => true, () => false);
    await shot(page, 'filled');
    const after = await ring(page);
    check('... then fills as audio arrives', filled && !after.isLoading, JSON.stringify(after));
    await page.click('#railPpBtn');
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
}

await finish(run);

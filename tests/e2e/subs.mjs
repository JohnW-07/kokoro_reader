// Real-browser check for T6: "a section next to READ and NOTES called SUBS that allows a user to
// replace specific text with a plain english that the model will read instead — in the GR00T paper
// the model reads G R zero zero T ... this really should be read 'groot'".
//
// It drives, on GR00TN1:
//   1. before: the script holds "GR00T".
//   2. Subs tab, keyboard only: type GR00T, Tab, groot, Enter → the row is listed, /api/script/build
//      is POSTed again with the substitution, and the rebuilt script says "groot" and no "GR00T"
//      while the page's text layer and each sentence's raw text still print "GR00T".
//   3. a duplicate is refused with a message; Space typed into a Subs field does not start playback.
//   4. reload: the substitution comes back from the saved prefs and the first build already uses it.
//   5. deleting the row rebuilds the script with "GR00T" again.
//   6. no console errors.
//
// Run (no repo npm deps; Playwright comes from outside the repo):
//   KOKORO_DATA_DIR=$(mktemp -d) KOKORO_LLM=0 venv/bin/python -m uvicorn app:app --port 8765
//   PLAYWRIGHT_DIR=/path/to/node_modules node tests/e2e/subs.mjs
// Env: KOKORO_URL, PLAYWRIGHT_DIR, CHROMIUM_PATH, BROWSER, KOKORO_E2E_PDF — as in read_from_here.mjs. The paper
// must have no notes record on that server: the check refuses to touch an existing one and deletes
// any record it creates. Exit code 0 = pass, 1 = fail.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE_URL = process.env.KOKORO_URL || 'http://127.0.0.1:8765/';
const PDF = process.env.KOKORO_E2E_PDF;
if (!PDF) {
    console.error('KOKORO_E2E_PDF is not set. Point it at the PDF this check should drive.');
    process.exit(2);
}
const VIEWPORT = { width: 1440, height: 900 };
const LOAD_TIMEOUT_MS = 90000;
const STEP_TIMEOUT_MS = 30000;
const SETTLE_MS = 600;
const FIND = 'GR00T';
const SAY = 'groot';
/** GR00T as a whole word, by the same rule the server uses (no word character either side). */
const WHOLE_FIND_RE = /(?<!\w)GR00T(?!\w)/g;

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures.push(name);
};

async function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_DIR;
  if (!dir) return import('playwright');
  const candidates = [join(dir, 'playwright', 'index.mjs'), join(dir, 'index.mjs')];
  const entry = candidates.find(existsSync);
  if (!entry) throw new Error(`PLAYWRIGHT_DIR=${dir} holds no playwright/index.mjs or index.mjs`);
  return import(pathToFileURL(entry).href);
}

async function api(path, init) {
  const res = await fetch(new URL(path, BASE_URL), init);
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} → HTTP ${res.status}`);
  return res.json();
}

const ready = (page) =>
  page.waitForFunction(() => !document.getElementById('ppBtn').disabled && !window.kokoro.state.get().loading,
    null, { timeout: LOAD_TIMEOUT_MS });

async function openPaper(page) {
  await page.setInputFiles('#file-input', PDF);
  await ready(page);
}

/** The script as it is read aloud, one sentence per line (R2: the script that showed it is gone). */
const readScript = (page) => page.evaluate(() => ({
  text: window.kokoro.state.get().sentences.map((s) => s.text).join('\n'),
  rows: window.kokoro.state.get().sentences.length,
  spoken: window.kokoro.state.get().sentences.map((s) => s.text).join(' '),
  raw: window.kokoro.state.get().sentences.map((s) => s.raw).join(' '),
}));

const count = (text, re) => (text.match(re) || []).length;
const ANY_FIND_RE = new RegExp(FIND, 'g');   // also inside longer tokens such as GR00TN1
const excerpt = (text, needle) => {
  const at = text.indexOf(needle);
  return at < 0 ? '' : JSON.stringify(text.slice(Math.max(0, at - 40), at + needle.length + 40));
};

/** Resolves once a full rebuild has been POSTed and the script is ready again. */
async function rebuildAfter(page, builds, act) {
  const before = builds.length;
  await act();
  await page.waitForFunction(() => window.kokoro.state.get().loading === false, null, { timeout: STEP_TIMEOUT_MS });
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (builds.length === before && Date.now() < deadline) await page.waitForTimeout(SETTLE_MS);
  await page.waitForFunction(() => /^Ready/.test(document.getElementById('status-bar').textContent), null,
    { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  return builds.slice(before);
}

async function run() {
  const bytes = readFileSync(PDF);
  const docId = createHash('sha1').update(bytes).digest('hex');
  const { docs } = await api('api/notes');
  if ((docs || []).some((d) => d.doc_id === docId)) {
    throw new Error('the server already holds a notes record for this paper; run it against a scratch KOKORO_DATA_DIR');
  }

  const { chromium, webkit } = await loadPlaywright();
  const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch(process.env.CHROMIUM_PATH && engine === chromium
    ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    const builds = [];
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/script/build') builds.push(JSON.parse(req.postData() || '{}').options);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      const favicon = /\/favicon\.ico$/.test(msg.location().url || '');
      if (msg.type() === 'error' && !favicon) errors.push(`console: ${msg.text()}`);
    });

    console.log(`${process.env.BROWSER || 'chromium'} · ${BASE_URL}`);
    await page.goto(BASE_URL);
    await openPaper(page);

    console.log('\n1. before');
    const before = await readScript(page);
    const beforeCount = count(before.text, WHOLE_FIND_RE);
    console.log(`        script: ${before.rows} rows, "${FIND}" ×${beforeCount}, "${SAY}" ×${count(before.text, /groot/g)}; e.g. ${excerpt(before.text, FIND)}`);
    check(`the script says "${FIND}"`, beforeCount > 0);
    check('the first build sent no substitutions', builds.length > 0 && builds.every((o) => (o.substitutions || []).length === 0),
      JSON.stringify(builds[0]));

    console.log('\n2. add GR00T → groot with the keyboard');
    await page.click('.tab[data-tab="subs"]');
    check('the Subs tab shows its panel', await page.isVisible('#tab-subs .sub-add'));
    await page.focus('#subAddFind');
    const added = await rebuildAfter(page, builds, async () => {
      await page.keyboard.type(FIND);
      await page.keyboard.press('Tab');
      await page.keyboard.type(SAY);
      await page.keyboard.press('Enter');
    });
    const rows = await page.$$eval('#tab-subs .sub-row .sub-input', (els) => els.map((e) => e.value));
    check('the row is listed', JSON.stringify(rows) === JSON.stringify([FIND, SAY]), JSON.stringify(rows));
    console.log(`        request options: ${JSON.stringify(added[0])}`);
    check('the rebuild POSTed the substitution with every batch', added.length > 0 && added.every((o) =>
      JSON.stringify(o.substitutions) === JSON.stringify([{ find: FIND, replace: SAY, ignore_case: false }])),
    JSON.stringify(added));
    const after = await readScript(page);
    const afterCount = count(after.text, WHOLE_FIND_RE);
    console.log(`        script: ${after.rows} rows, "${FIND}" ×${afterCount}, "${SAY}" ×${count(after.text, /groot/g)}; e.g. ${excerpt(after.text, SAY)}`);
    console.log(`        full script: "${FIND}" as a word ×${count(before.spoken, WHOLE_FIND_RE)} → ×${count(after.spoken, WHOLE_FIND_RE)}, `
      + `anywhere ×${count(before.spoken, ANY_FIND_RE)} → ×${count(after.spoken, ANY_FIND_RE)}, "${SAY}" ×${count(after.spoken, /groot/g)}`);
    check(`the script says "${SAY}" wherever it said "${FIND}"`, count(after.text, /groot/g) === beforeCount,
      `${count(after.text, /groot/g)} vs ${beforeCount}`);
    check(`... and no "${FIND}" anywhere in the script or the spoken script`,
      count(after.text, ANY_FIND_RE) === 0 && count(after.spoken, ANY_FIND_RE) === 0,
      `${excerpt(after.text, FIND)} ${excerpt(after.spoken, FIND)}`);
    check('the sentence count is unchanged', after.rows === before.rows, `${before.rows} → ${after.rows}`);
    check(`each sentence's raw text still prints "${FIND}"`, count(after.raw, WHOLE_FIND_RE) > 0);
    const layer = await page.$$eval('.textLayer span', (els) => els.map((e) => e.textContent).join(' '));
    check(`the page's text layer still prints "${FIND}"`, layer.includes(FIND));
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('kokoro.prefs.v2') || '{}').subs);
    check('the substitution is saved with the prefs', prefs?.[0]?.find === FIND, JSON.stringify(prefs));

    console.log('\n3. a duplicate, and Space typed into a Subs field');
    const buildsBeforeDup = builds.length;
    await page.focus('#subAddFind');
    await page.keyboard.type('gr00t');
    await page.check('#subAddCase');
    const message = await page.textContent('#subAddError');
    check('a case-insensitive duplicate is flagged as you type', /already has a substitution/.test(message), message);
    await page.focus('#subAddFind');
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(SETTLE_MS);
    check('Space in the field types a space and does not start playback',
      (await page.inputValue('#subAddFind')) === 'gr00t ' && !(await page.evaluate(() => document.getElementById('ppBtn').classList.contains('is-playing'))));
    check('... and Enter does not add the duplicate',
      (await page.$$('#tab-subs .sub-row')).length === 1 && builds.length === buildsBeforeDup);
    await page.fill('#subAddFind', '');
    await page.uncheck('#subAddCase');

    console.log('\n4. reload');
    const reloaded = await rebuildAfter(page, builds, async () => {
      await page.reload();
      await page.waitForSelector('#tab-subs .sub-row', { state: 'attached', timeout: STEP_TIMEOUT_MS });
      await openPaper(page);
    });
    check('the saved substitution is listed again', (await page.$$('#tab-subs .sub-row')).length === 1);
    check('the first build after a reload already applies it', reloaded.length > 0
      && reloaded.every((o) => o.substitutions?.[0]?.find === FIND), JSON.stringify(reloaded[0]));
    check(`the script says "${SAY}" straight away`, count((await readScript(page)).text, WHOLE_FIND_RE) === 0);

    console.log('\n5. delete');
    await page.click('.tab[data-tab="subs"]');
    const deleted = await rebuildAfter(page, builds, () => page.click('#tab-subs .sub-delete'));
    check('deleting the row rebuilds without it', deleted.length > 0 && deleted.every((o) => o.substitutions.length === 0),
      JSON.stringify(deleted[0]));
    check(`the script says "${FIND}" again`, count((await readScript(page)).text, WHOLE_FIND_RE) === beforeCount);

    console.log('');
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    const { docs: after } = await api('api/notes').catch(() => ({ docs: [] }));
    if ((after || []).some((d) => d.doc_id === docId)) {
      await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
    }
  }
}

try {
  await run();
} catch (err) {
  console.error(`ERROR  ${err.stack || err.message}`);
  failures.push(err.message);
}
console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
process.exit(failures.length === 0 ? 0 : 1);

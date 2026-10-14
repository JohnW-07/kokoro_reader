// Real-browser regression check for T4: "notes don't work, I can't highlight text on the PDF".
//
// Root cause: the desktop app is a pywebview window, and pywebview's default `text_select=False`
// injects `body { user-select: none }` (webview/js/customize.js). That inherits into the pdf.js
// text layer, so a drag selects nothing, the highlight toolbar never opens and no note is made.
// A plain browser never sees that rule, so this check injects pywebview's own CSS, read from the
// installed package, exactly as the host does.
//
// It drives: drag-select → colour → rect drawn over the selected words → Notes tab row → the
// highlights survive a full reload. Page 1 (one line), page 2 (several lines), then a page that
// was not rendered at load, reached by scrolling after collapsing the sidebar (a re-scale).
// Then a note made on a heading, filed under that heading in the Sections view (U15).
//
// Run (no repo npm deps; Playwright comes from outside the repo):
//   KOKORO_DATA_DIR=$(mktemp -d) KOKORO_LLM=0 venv/bin/python -m uvicorn app:app --port 8765
//   PLAYWRIGHT_DIR=/path/to/node_modules node tests/e2e/notes_highlight.mjs
// Env:
//   KOKORO_URL          server URL (default http://127.0.0.1:8765/)
//   PLAYWRIGHT_DIR      node_modules dir holding `playwright`, or the package dir (default: `playwright`)
//   CHROMIUM_PATH       browser executable, when Playwright's bundled revision is not installed
//   BROWSER             chromium (default) | webkit
//   KOKORO_E2E_PDF      paper to load (required)
//   EMULATE_PYWEBVIEW   set to 0 to skip the pywebview CSS (a plain browser)
//   WebKit also needs its browser: PLAYWRIGHT_BROWSERS_PATH=… npx playwright install webkit
// The paper must have no notes record on that server: the check refuses to touch an existing one,
// and deletes the record it created when it ends. Exit code 0 = pass, 1 = fail.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { headingNoteCase } from './cases/heading_note.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_URL = process.env.KOKORO_URL || 'http://127.0.0.1:8765/';
const PDF = process.env.KOKORO_E2E_PDF;
if (!PDF) {
    console.error('KOKORO_E2E_PDF is not set. Point it at the PDF this check should drive.');
    process.exit(2);
}
const EMULATE_PYWEBVIEW = process.env.EMULATE_PYWEBVIEW !== '0';
const VIEWPORT = { width: 1440, height: 900 };
const LOAD_TIMEOUT_MS = 90000;
const STEP_TIMEOUT_MS = 20000;
const SAVE_TIMEOUT_MS = 10000;
const SETTLE_MS = 400;
const DRAG_STEPS = 12;
const EDGE_INSET_PX = 3;
const MIN_SPAN_CHARS = 30;
const MIN_SPAN_WIDTH_PX = 200;
const VIEW_MARGIN_PX = 120;
const LINES_IN_MULTI = 3;
const LAZY_PAGE = 9;

// Each case: page, how many lines to drag across, colour, whether to collapse the sidebar first.
const CASES = [
  { page: 1, lines: 1, color: 'green', collapse: false },
  { page: 2, lines: LINES_IN_MULTI, color: 'blue', collapse: false },
  { page: LAZY_PAGE, lines: 1, color: 'pink', collapse: true },
];

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

/** The exact CSS pywebview injects when text_select is False, from the installed package. */
function pywebviewNoSelectCss() {
  const lib = join(ROOT, 'venv', 'lib');
  const python = existsSync(lib) ? readdirSync(lib).find((d) => d.startsWith('python')) : null;
  const file = python && join(lib, python, 'site-packages', 'webview', 'js', 'customize.js');
  if (!file || !existsSync(file)) throw new Error(`pywebview customize.js not found under ${lib}`);
  const css = /disableTextCss\s*=\s*'([^']+)'/.exec(readFileSync(file, 'utf8'));
  if (!css) throw new Error(`no disableTextCss in ${file}; pywebview changed how it disables selection`);
  return css[1];
}

async function api(path, init) {
  const res = await fetch(new URL(path, BASE_URL), init);
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} → HTTP ${res.status}`);
  return res.json();
}

/** Poll the server until it holds `want` highlights for the paper, or the deadline passes. */
async function savedCount(docId, want) {
  const deadline = Date.now() + SAVE_TIMEOUT_MS;
  for (;;) {
    const count = ((await api(`api/notes/${docId}`)).highlights || []).length;
    if (count === want || Date.now() > deadline) return count === want;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }
}

async function openPaper(page) {
  await page.goto(BASE_URL);
  await page.setInputFiles('#file-input', PDF);
  await page.waitForFunction(() => !document.getElementById('ppBtn').disabled, null, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelectorAll('.pdf-page-wrap[data-page="1"] .textLayer > span').length > 0,
    null, { timeout: STEP_TIMEOUT_MS });
}

const pageScale = (page) => page.evaluate(() =>
  document.querySelector('.pdf-page-wrap').style.getPropertyValue('--scale-factor'));

const spanCount = (page, n) =>
  page.evaluate((n) => document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`).length, n);

/** Scroll page `n` into view, wait for its text layer, and pick its first `lines` long text lines in view. */
async function targetLines(page, n, lines) {
  await page.evaluate((n) => document.querySelector(`.pdf-page-wrap[data-page="${n}"]`).scrollIntoView({ block: 'start' }), n);
  await page.waitForFunction((n) => document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`).length > 0,
    n, { timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
  return page.evaluate(({ n, lines, minChars, minWidth, margin }) => {
    const spans = [...document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`)]
      .map((s) => ({ text: s.textContent, r: s.getBoundingClientRect() }))
      .filter(({ text, r }) => text.trim().length >= minChars && r.width >= minWidth
        && r.top > margin && r.bottom < innerHeight - margin);
    if (spans.length < lines) return null;
    return spans.slice(0, lines).map(({ text, r }) => ({ text, left: r.left, top: r.top, width: r.width, height: r.height }));
  }, { n, lines, minChars: MIN_SPAN_CHARS, minWidth: MIN_SPAN_WIDTH_PX, margin: VIEW_MARGIN_PX });
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= DRAG_STEPS; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / DRAG_STEPS, from.y + ((to.y - from.y) * i) / DRAG_STEPS);
  }
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
}

/** Drawn highlight rects for one page, in viewport pixels. */
const drawnRects = (page, n, color) => page.evaluate(({ n, color }) =>
  [...document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .hl-rect[data-color="${color}"]`)]
    .map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }),
{ n, color });

const covers = (rects, x, y) => rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);

async function highlightCase(page, c) {
  console.log(`\npage ${c.page}: ${c.lines} line(s), ${c.color}${c.collapse ? ', sidebar collapsed' : ''}`);
  if (c.collapse) {
    check('page was not rendered at load (lazy)', (await spanCount(page, c.page)) === 0);
    const scale = await pageScale(page);
    await page.keyboard.press('b');
    await page.waitForFunction(() => document.body.classList.contains('sidebar-collapsed'), null, { timeout: STEP_TIMEOUT_MS });
    // The wider column re-fits the pages, which re-lays out every text layer: select after that.
    // setScale walks every page and then scrolls back to its anchor, so wait for all of it to land.
    const refit = await page.waitForFunction((before) => {
      const wraps = [...document.querySelectorAll('.pdf-page-wrap')];
      return wraps.every((w) => w.style.getPropertyValue('--scale-factor') !== before)
        && wraps.some((w) => w.querySelector('.textLayer > span'));
    }, scale, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false);
    await page.waitForTimeout(SETTLE_MS);
    check('collapsing re-fits the pages', refit, `scale stayed ${scale}`);
  }
  const lines = await targetLines(page, c.page, c.lines);
  check('found text lines to select', Boolean(lines));
  if (!lines) return null;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const from = { x: first.left + EDGE_INSET_PX, y: first.top + first.height / 2 };
  const to = { x: last.left + last.width - EDGE_INSET_PX, y: last.top + last.height / 2 };
  await drag(page, from, to);

  const selected = await page.evaluate(() => getSelection().toString());
  check('the drag selects text', selected.trim().length > 0, `selection length ${selected.length}`);
  const firstWords = first.text.trim().split(/\s+/).slice(0, 2).join(' ');
  check('the selection holds the first dragged words', selected.replace(/\s+/g, ' ').includes(firstWords), JSON.stringify(firstWords));
  // Engines differ on whether a drag ending inside the last glyph takes it, so compare the
  // drawn rects against the selection itself rather than against the pointer.
  const selectionEnd = await page.evaluate((inset) => {
    const boxes = [...(getSelection().rangeCount ? getSelection().getRangeAt(0).getClientRects() : [])].filter((r) => r.width > 0);
    const end = boxes[boxes.length - 1];
    return end ? { x: end.right - inset, y: end.top + end.height / 2 } : { x: NaN, y: NaN };
  }, EDGE_INSET_PX);
  const toolbarOpen = Boolean(await page.$('.hl-toolbar.is-open'));
  check('the highlight toolbar opens', toolbarOpen);
  if (!toolbarOpen) return null;

  await page.click(`.hl-toolbar.is-open .hl-swatch[data-color="${c.color}"]`);
  const rects = await drawnRects(page, c.page, c.color);
  // One bar per text line; a multi-line drag may also cross short lines between the picked ones.
  const rectsOk = c.lines === 1 ? rects.length === 1 : rects.length >= c.lines;
  check(`${c.lines === 1 ? 'one rect' : `at least ${c.lines} rects`} drawn`, rectsOk, `got ${rects.length}`);
  check('a rect covers the first dragged word', covers(rects, from.x, from.y));
  check('a rect reaches where the selection ends', covers(rects, selectionEnd.x, selectionEnd.y), JSON.stringify({ selectionEnd, rects }));
  const midLine = lines[Math.floor(lines.length / 2)];
  check('a rect covers the middle line', covers(rects, midLine.left + midLine.width / 2, midLine.top + midLine.height / 2));
  return { ...c, rects: rects.length, firstWords };
}

async function notesRows(page) {
  // R3: the list heads the notes column; open it if a saved profile left it folded.
  if ((await page.getAttribute('#notes-panel .nt-disclosure', 'aria-expanded')) === 'false') {
    await page.click('#notes-panel .nt-disclosure');
  }
  return page.$$eval('#notes-panel .nt-row', (rows) => rows.map((r) => r.textContent.replace(/\s+/g, ' ')));
}

async function run() {
  const bytes = readFileSync(PDF);
  const docId = createHash('sha1').update(bytes).digest('hex');
  // Cleanup deletes the whole record (highlights, resume position, read options), so any stored
  // record — even one with no highlights — means this is not a scratch data dir.
  const { docs } = await api('api/notes');
  if ((docs || []).some((d) => d.doc_id === docId)) {
    throw new Error('the server already holds a notes record for this paper; '
      + 'run it against a scratch KOKORO_DATA_DIR');
  }

  const { chromium, webkit } = await loadPlaywright();
  const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch(process.env.CHROMIUM_PATH && engine === chromium
    ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    if (EMULATE_PYWEBVIEW) {
      const css = pywebviewNoSelectCss();
      await context.addInitScript((rule) => addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = rule;
        document.head.appendChild(style);
      }), css);
    }
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      const favicon = /\/favicon\.ico$/.test(msg.location().url || '');
      if (msg.type() === 'error' && !favicon) errors.push(`console: ${msg.text()}`);
    });

    console.log(`${process.env.BROWSER || 'chromium'} · ${BASE_URL} · pywebview CSS ${EMULATE_PYWEBVIEW ? 'on' : 'off'}`);
    await openPaper(page);
    const made = [];
    for (const c of CASES) made.push(await highlightCase(page, c));
    const done = made.filter(Boolean);

    console.log('\nNotes tab and persistence');
    const expected = done.reduce((sum, c) => sum + c.rects, 0);
    const saved = await savedCount(docId, CASES.length);
    // An expanded sidebar holds the tab; the last case collapsed it.
    await page.keyboard.press('b');
    const rows = await notesRows(page);
    check(`the Notes tab lists ${CASES.length} highlights`, rows.length === CASES.length, `got ${rows.length}`);
    for (const c of done) check(`page ${c.page} row quotes "${c.firstWords}"`, rows.some((t) => t.includes(c.firstWords)));
    check(`the server holds ${CASES.length} highlights`, saved);

    await openPaper(page);
    const afterReload = await page.$$eval('.hl-rect', (els) => els.length);
    const rowsAfter = await notesRows(page);
    check(`after a reload: ${expected} rects redrawn`, expected > 0 && afterReload === expected, `got ${afterReload}`);
    check(`after a reload: ${CASES.length} rows in the Notes tab`, rowsAfter.length === CASES.length, `got ${rowsAfter.length}`);
    await headingNoteCase(page, { check, drag, settleMs: SETTLE_MS });
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
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

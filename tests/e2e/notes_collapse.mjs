// Real-browser check for U7: "Make the notes section collapsable."
//
// It drives, on the paper named by KOKORO_E2E_PDF:
//   1. the handle — present with a paper open, labelled "Hide notes", and clickable where it
//      is drawn (the corner cluster it joins must not cover it).
//   2. clicking it collapses the column: the panel leaves to the right, is `inert` and out of
//      the tab order, and the document area grows by exactly the width the column gave up.
//   3. collapsing costs exactly one re-fit, not one per animated frame.
//   4. the readouts (zoom pill, page pill) stay in the corner and on screen in both states,
//      and the handle rides the column's edge.
//   5. "N" toggles it, and "N" typed into the notes editor does not.
//   6. collapsing from inside the editor moves focus onto the handle rather than losing it.
//   7. the state persists across a reload, in the same prefs record as the sidebar's.
//   8. the sidebar still collapses, still persists, and both collapsed at once leaves the
//      rail and the handle facing each other across a full-width paper.
//  10. "N" with a highlight active goes to that highlight's note, not to the column.
//   0. (cases/welcome_state.mjs) no paper open: no transport, no contents, no MLX pill;
//      Highlights heads the notes column, not a sidebar tab (R3). A paper brings them back.
//  11. (cases/view_switch.mjs) the Margin | Sections switch shows, and switches, the view.
//   9. no console errors. Screenshots at 1440×900: expanded, notes collapsed, both collapsed.
//
// Run (no repo npm deps; Playwright comes from outside the repo):
//   KOKORO_DATA_DIR=$(mktemp -d) KOKORO_LLM=0 venv/bin/python -m uvicorn app:app --port 8765
//   PLAYWRIGHT_DIR=/path/to/node_modules node tests/e2e/notes_collapse.mjs
// Env: KOKORO_URL, PLAYWRIGHT_DIR, CHROMIUM_PATH, BROWSER (chromium|webkit), KOKORO_E2E_PDF,
//      EMULATE_PYWEBVIEW, SHOT_DIR (where the screenshots go) — as in notes_editor.mjs.
// The paper must have no notes record on that server: the check refuses to touch an existing
// one and deletes the record it creates. Exit code 0 = pass, 1 = fail.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { welcomeCase } from './cases/welcome_state.mjs';
import { viewSwitchCase } from './cases/view_switch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_URL = process.env.KOKORO_URL || 'http://127.0.0.1:8765/';
const PDF = process.env.KOKORO_E2E_PDF;
if (!PDF) {
  console.error('KOKORO_E2E_PDF is not set. Point it at the PDF this check should drive.');
  process.exit(2);
}
const EMULATE_PYWEBVIEW = process.env.EMULATE_PYWEBVIEW !== '0';
const SHOT_DIR = process.env.SHOT_DIR || join(tmpdir(), 'kokoro-e2e-shots');
const ENGINE = process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium';
const VIEWPORT = { width: 1440, height: 900 };
const LOAD_TIMEOUT_MS = 90000;
const STEP_TIMEOUT_MS = 30000;
const SETTLE_MS = 400;
const PANEL_MS = 600;          // the 320ms slide, with room for the re-fit debounce behind it
const TYPE_DELAY_MS = 12;
const EDGE_INSET_PX = 3;
const PX_TOLERANCE = 1;        // sub-pixel layout rounding
const GUTTER_MIN_PX = 8;       // the cluster keeps a margin from the window edge in both states
const GUTTER_MAX_PX = 48;
const MIN_SPAN_CHARS = 12;     // a span long enough to drag a selection across
const MIN_SPAN_WIDTH_PX = 80;
const VIEW_MARGIN_PX = 60;     // keep clear of the floating corner cluster and the toolbar
const DRAG_STEPS = 8;
const HL_COLOR = 'yellow';
const PREF_KEY = 'kokoro.prefs.v2';

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

async function openPaper(page) {
  await page.goto(BASE_URL);
  await page.setInputFiles('#file-input', PDF);
  await page.waitForFunction(() => !document.getElementById('ppBtn').disabled, null, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelectorAll('.pdf-page-wrap[data-page="1"] .textLayer > span').length > 0,
    null, { timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('#notes-column .ne-doc')?.hidden === false,
    null, { timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
}

// ── What the window actually looks like ──────────────────────────────────────

/** Everything a claim about the layout is made from, measured from the rendered page. */
const shape = (page) => page.evaluate(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
  };
  const hits = (el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(at && el.contains(at));
  };
  const notes = document.getElementById('notes-column');
  const main = document.getElementById('content-area');
  const handle = document.getElementById('notesToggleBtn');
  const status = document.getElementById('view-status');
  return {
    collapsed: document.body.classList.contains('notes-collapsed'),
    sidebarCollapsed: document.body.classList.contains('sidebar-collapsed'),
    inert: notes.inert === true,
    notes: box(notes),
    notesOpacity: Number(getComputedStyle(notes).opacity),
    main: box(main),
    mainInner: main.clientWidth,
    status: box(status),
    handle: box(handle),
    handleHits: hits(handle),
    handleExpanded: handle.getAttribute('aria-expanded'),
    handleLabel: handle.getAttribute('aria-label'),
    handleTitle: handle.getAttribute('title'),
    zoom: box(document.getElementById('zoom-pill')),
    pagePill: box(document.getElementById('page-pill')),
    rail: box(document.getElementById('rail')),
    pageWidth: document.querySelector('.pdf-page-wrap[data-page="1"]')?.getBoundingClientRect().width ?? 0,
    vw: innerWidth,
  };
});

/** True while the column is drawn off to the right and untouchable. */
const isPutAway = (s) => s.collapsed && s.inert && (s.notes.left >= s.vw - PX_TOLERANCE || s.notesOpacity === 0);

/** The gap the cluster keeps from the edge it faces: the column's, or the window's once it is gone. */
const gutterOf = (s) => (s.collapsed ? s.vw : s.notes.left) - s.status.right;

/** The corner cluster sits inside the window, clear of the notes column, above the page. */
const clusterIsWell = (s) => s.status.right <= s.vw
  && gutterOf(s) >= GUTTER_MIN_PX && gutterOf(s) <= GUTTER_MAX_PX
  && s.zoom.width > 0 && s.pagePill.width > 0 && s.handleHits;

/** Count the re-layouts `fn` provokes: one call to setScale is one re-fit of the document. */
async function countFits(page, fn) {
  await page.evaluate(() => {
    const view = window.kokoro.pdfView;
    if (!view.__realSetScale) view.__realSetScale = view.setScale;
    window.__fits = 0;
    view.setScale = (...args) => { window.__fits += 1; return view.__realSetScale(...args); };
  });
  await fn();
  await page.waitForTimeout(PANEL_MS);
  return page.evaluate(() => window.__fits);
}

const prefs = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), PREF_KEY);

const toggle = async (page) => {
  await page.click('#notesToggleBtn');
  await page.waitForTimeout(PANEL_MS);
};

const press = async (page, key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(PANEL_MS);
};

/** A real press-move-release, so the engine builds a live text selection. */
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= DRAG_STEPS; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / DRAG_STEPS, from.y + ((to.y - from.y) * i) / DRAG_STEPS);
  }
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
}

/** Put the caret at the end of the editor's first block. */
async function focusEditor(page) {
  const box = await (await page.$('#notes-column .ne-text')).boundingBox();
  await page.mouse.click(box.x + Math.max(0, box.width - EDGE_INSET_PX), box.y + box.height / 2);
}

// ── The cases ────────────────────────────────────────────────────────────────

/** 1 & 2 & 3 & 4. The handle, the collapse, the width it hands over, and the re-fit it costs. */
async function collapseCase(page) {
  console.log('\n1. the handle, with the notes open');
  const open = await shape(page);
  check('it is there and says what it does', open.handleLabel === 'Hide notes'
    && open.handleTitle === 'Hide notes (N)' && open.handleExpanded === 'true', JSON.stringify(
      { label: open.handleLabel, title: open.handleTitle, expanded: open.handleExpanded }));
  check('a click at its centre reaches it', open.handleHits === true);
  check('it rides the notes column\'s edge, not the middle of the page',
    open.handle.right <= open.notes.left + PX_TOLERANCE && open.notes.left - open.handle.right < 64,
    JSON.stringify({ handleRight: Math.round(open.handle.right), notesLeft: Math.round(open.notes.left) }));
  check('the column is on screen at its own width',
    open.notes.width > 0 && open.notes.right <= open.vw + PX_TOLERANCE && !open.collapsed,
    JSON.stringify(open.notes));

  console.log('\n2. one click puts the column away');
  const fits = await countFits(page, () => page.click('#notesToggleBtn'));
  const shut = await shape(page);
  check('the body says so, and the hidden column is inert', isPutAway(shut),
    JSON.stringify({ collapsed: shut.collapsed, inert: shut.inert, left: Math.round(shut.notes.left), opacity: shut.notesOpacity }));
  check('the handle flips to "show"', shut.handleExpanded === 'false'
    && shut.handleLabel === 'Show notes' && shut.handleTitle === 'Show notes (N)');
  check('the document area takes the freed width, to the pixel',
    Math.abs((shut.mainInner - open.mainInner) - open.notes.width) <= PX_TOLERANCE,
    JSON.stringify({ was: open.mainInner, now: shut.mainInner, freed: Math.round(open.notes.width) }));
  check('and the page is redrawn wider', shut.pageWidth > open.pageWidth,
    JSON.stringify({ was: Math.round(open.pageWidth), now: Math.round(shut.pageWidth) }));

  console.log('\n3. it costs one re-fit, not one per frame');
  check(`the 320ms slide re-laid the document out once (${fits})`, fits === 1, String(fits));

  console.log('\n4. the readouts keep their corner');
  check('open: the cluster is inside the window and clear of the column', clusterIsWell(open),
    JSON.stringify({ status: open.status, gutter: Math.round(gutterOf(open)) }));
  check('collapsed: it is still inside the window, now against its edge', clusterIsWell(shut),
    JSON.stringify({ status: shut.status, gutter: Math.round(gutterOf(shut)) }));
  check('… keeping the same gap from whichever edge it faces',
    Math.abs(gutterOf(open) - gutterOf(shut)) <= PX_TOLERANCE,
    JSON.stringify({ open: gutterOf(open), collapsed: gutterOf(shut) }));
  check('… and it moved right by exactly the column\'s width',
    Math.abs((shut.status.right - open.status.right) - open.notes.width) <= PX_TOLERANCE,
    JSON.stringify({ was: Math.round(open.status.right), now: Math.round(shut.status.right) }));

  await toggle(page);
  const back = await shape(page);
  check('clicking again brings it back where it left from',
    !back.collapsed && !back.inert && Math.abs(back.notes.left - open.notes.left) <= PX_TOLERANCE
    && back.handleLabel === 'Hide notes', JSON.stringify({ left: Math.round(back.notes.left), label: back.handleLabel }));
  check('the document area gives the width back', Math.abs(back.mainInner - open.mainInner) <= PX_TOLERANCE,
    JSON.stringify({ was: open.mainInner, now: back.mainInner }));
}

/** 5 & 6. The keyboard: N outside the editor, and not inside it. */
async function keyboardCase(page) {
  console.log('\n5. N toggles, and the editor keeps its own N');
  await page.click('#pdf-pages');
  await press(page, 'KeyN');
  check('N collapses it', (await shape(page)).collapsed === true);
  await press(page, 'KeyN');
  check('N brings it back', (await shape(page)).collapsed === false);

  await focusEditor(page);
  await page.keyboard.type('note', { delay: TYPE_DELAY_MS });
  await page.waitForTimeout(SETTLE_MS);
  const typed = await page.$eval('#notes-column .ne-text', (el) => el.textContent);
  check('an N typed in the editor is text, not a shortcut',
    (await shape(page)).collapsed === false && typed.includes('note'), JSON.stringify({ typed }));

  console.log('\n6. collapsing from inside the editor keeps the focus somewhere');
  const focused = await page.evaluate(() => document.activeElement?.className || '');
  check('the caret is in the editor to start with', focused.includes('ne-text'), focused);
  await toggle(page);
  const landed = await page.evaluate(() => document.activeElement?.id || '');
  check('focus lands on the handle, not on the body', landed === 'notesToggleBtn', landed);
  check('and nothing inside the put-away column is tabbable',
    await page.evaluate(() => document.getElementById('notes-column').inert === true));
}

/** 7. The state outlives the page. */
async function persistenceCase(page) {
  console.log('\n7. the state persists');
  const saved = await prefs(page);
  check('it is written to the prefs, beside the sidebar\'s', saved.notesCollapsed === true
    && 'sidebarCollapsed' in saved, JSON.stringify({ notesCollapsed: saved.notesCollapsed, sidebarCollapsed: saved.sidebarCollapsed }));

  await page.reload();
  await page.waitForFunction(() => Boolean(window.kokoro), null, { timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
  const after = await shape(page);
  check('the reloaded app comes back collapsed, with the handle saying "show"',
    after.collapsed === true && after.inert === true && after.handleLabel === 'Show notes',
    JSON.stringify({ collapsed: after.collapsed, label: after.handleLabel }));
  check('the state object agrees', (await page.evaluate(() => window.kokoro.state.get().notesCollapsed)) === true);
}

/** 8. The sidebar still works, and both collapsed at once is a deliberate-looking window. */
async function sidebarCase(page) {
  console.log('\n8. the sidebar, and both at once');
  await openPaper(page);
  const both = await shape(page);
  check('the notes are still collapsed with a paper open', both.collapsed === true);

  await page.click('#pdf-pages');
  await press(page, 'KeyB');
  const b = await shape(page);
  check('B still collapses the sidebar', b.sidebarCollapsed === true);
  check('the rail is on screen on the left', b.rail.left >= 0 && b.rail.width > 0, JSON.stringify(b.rail));
  check('… and the notes handle faces it from the right',
    b.handleHits && b.handle.left > b.vw / 2, JSON.stringify({ left: Math.round(b.handle.left), vw: b.vw }));
  check('the paper has the window: the page is wider than with both panels open',
    b.pageWidth >= both.pageWidth, JSON.stringify({ oneCollapsed: Math.round(both.pageWidth), both: Math.round(b.pageWidth) }));
  const saved = await prefs(page);
  check('both flags are saved together', saved.sidebarCollapsed === true && saved.notesCollapsed === true,
    JSON.stringify(saved));

  await page.screenshot({ path: join(SHOT_DIR, `notes-collapse-both-${ENGINE}.png`) });

  await press(page, 'KeyB');
  const out = await shape(page);
  check('B brings the sidebar back, and the notes stay collapsed',
    out.sidebarCollapsed === false && out.collapsed === true);
  check('the sidebar\'s state persisted the same way',
    (await prefs(page)).sidebarCollapsed === false);
  await page.screenshot({ path: join(SHOT_DIR, `notes-collapse-collapsed-${ENGINE}.png`) });

  await toggle(page);
  const open = await shape(page);
  check('and the notes come back to a full window', open.collapsed === false && clusterIsWell(open));
  await page.screenshot({ path: join(SHOT_DIR, `notes-collapse-expanded-${ENGINE}.png`) });
}

/**
 * 10. `N` belongs to an active highlight before it belongs to the column.
 *
 * Both handlers are `document` keydown listeners on the same node, so neither can
 * suppress the other by propagation: one press used to open the highlight's note *and*
 * collapse the column out from under it. main.js asks the highlighter whether the key is
 * already spoken for. This is the case the fake DOM cannot reach — the popover is built
 * from `innerHTML`, so it only exists in a real engine.
 */
async function highlightKeyCase(page) {
  console.log('\n10. N belongs to an active highlight before the column');
  if ((await shape(page)).collapsed) await toggle(page);

  const span = await page.evaluate(({ minChars, minWidth, margin }) => {
    const found = [...document.querySelectorAll('.pdf-page-wrap[data-page="1"] .textLayer > span')]
      .map((el) => ({ r: el.getBoundingClientRect(), text: el.textContent }))
      .find(({ text, r }) => text.trim().length >= minChars && r.width >= minWidth
        && r.top > margin && r.bottom < innerHeight - margin);
    return found ? { left: found.r.left, top: found.r.top, width: found.r.width, height: found.r.height } : null;
  }, { minChars: MIN_SPAN_CHARS, minWidth: MIN_SPAN_WIDTH_PX, margin: VIEW_MARGIN_PX });
  check('a line of page 1 is on screen to highlight', Boolean(span));
  if (!span) return;

  const y = span.top + span.height / 2;
  await drag(page, { x: span.left + EDGE_INSET_PX, y }, { x: span.left + span.width - EDGE_INSET_PX, y });
  const toolbarOpen = Boolean(await page.$('.hl-toolbar.is-open'));
  check('the highlight toolbar opens on the selection', toolbarOpen);
  if (!toolbarOpen) return;
  await page.click(`.hl-toolbar.is-open .hl-swatch[data-color="${HL_COLOR}"]`);
  await page.waitForTimeout(SETTLE_MS);

  const rect = await page.$(`.pdf-page-wrap[data-page="1"] .hl-rect[data-color="${HL_COLOR}"]`);
  check('the highlight is drawn', Boolean(rect));
  if (!rect) return;
  const box = await rect.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);   // this is what makes it active
  await page.waitForTimeout(SETTLE_MS);
  const popoverOpen = () => page.$('.hl-popover.is-open').then(Boolean);
  check('(setup) clicking the highlight opens its popover, column still open',
    (await popoverOpen()) && (await shape(page)).collapsed === false);

  await press(page, 'KeyN');
  const after = await shape(page);
  const stillOpen = await popoverOpen();
  check('N goes to the highlight note and leaves the column alone',
    after.collapsed === false && stillOpen, JSON.stringify({ collapsed: after.collapsed, popover: stillOpen }));

  await press(page, 'Escape');          // the highlight hands the keyboard back
  check('Escape closes the popover', (await popoverOpen()) === false);
  await press(page, 'KeyN');
  check('with no highlight active N toggles the column again', (await shape(page)).collapsed === true);
  await press(page, 'KeyN');
  check('… and back', (await shape(page)).collapsed === false);
}

async function run() {
  const docId = createHash('sha1').update(readFileSync(PDF)).digest('hex');
  const { docs } = await api('api/notes');
  if ((docs || []).some((d) => d.doc_id === docId)) {
    throw new Error('the server already holds a notes record for this paper; run it against a scratch KOKORO_DATA_DIR');
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  const { chromium, webkit } = await loadPlaywright();
  const engine = ENGINE === 'webkit' ? webkit : chromium;
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

    console.log(`${ENGINE} · ${BASE_URL} · pywebview CSS ${EMULATE_PYWEBVIEW ? 'on' : 'off'}`);
    await welcomeCase(page, { check, openPaper, baseUrl: BASE_URL, shotDir: SHOT_DIR, engine: ENGINE, join });
    await collapseCase(page);
    await keyboardCase(page);
    await persistenceCase(page);
    await sidebarCase(page);
    await highlightKeyCase(page);
    await viewSwitchCase(page, { check, openPaper, toggle, prefs, viewport: VIEWPORT, settleMs: SETTLE_MS,
      shotDir: SHOT_DIR, engine: ENGINE, join });
    console.log('');
    check('no console errors', errors.length === 0, errors.join(' | '));
    console.log(`  screenshots in ${SHOT_DIR}`);
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

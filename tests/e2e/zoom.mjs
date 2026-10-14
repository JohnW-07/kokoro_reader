// Real-browser check for U6: "I should be able to zoom on the pdf."
//
// It drives, on GR00TN1:
//   1. the zoom pill — hidden until a paper is open, then reading 100% (fit-to-width),
//      with the bounds shown as disabled buttons.
//   2. ⌘+ / ⌘− / ⌘0 and the pill's own buttons walk the ladder, and each step changes the
//      rendered page width by exactly that factor.
//   3. a trackpad pinch (ctrl-wheel) zooms, and keeps the content under the pointer still.
//   4. a user highlight keeps covering the same words at 50 / 100 / 200 / 300%, and so does
//      the sentence (reading) highlight — both compared against the pdf.js text layer.
//   5. read-from-here at 200% still starts at the sentence holding the clicked word.
//   6. zooming keeps the paragraph in the middle of the viewport in the middle of the viewport.
//   7. text selection still lands on the word under the pointer at 300%.
//   8. the level persists across a reload.
//   9. no console errors.
//
// Run (no repo npm deps; Playwright comes from outside the repo):
//   KOKORO_DATA_DIR=$(mktemp -d) KOKORO_LLM=0 venv/bin/python -m uvicorn app:app --port 8765
//   PLAYWRIGHT_DIR=/path/to/node_modules node tests/e2e/zoom.mjs
// Env: KOKORO_URL, PLAYWRIGHT_DIR, CHROMIUM_PATH, BROWSER, KOKORO_E2E_PDF, EMULATE_PYWEBVIEW — as in
// notes_highlight.mjs. The paper must have no notes record on that server: the check refuses to
// touch an existing one and deletes the record it creates.
// Exit code 0 = pass, 1 = fail.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const SETTLE_MS = 400;
const TEXT_PAGE = 2;
const VIEW_MARGIN_PX = 120;
const MIN_SPAN_CHARS = 8;
const MIN_SPAN_WIDTH_PX = 40;
const EDGE_INSET_PX = 3;
const DRAG_STEPS = 12;
const HL_COLOR = 'yellow';
const HL_LINES = 3;
// setScale floors to 1/100 of a scale unit and pageRect floors to whole pixels, so a width
// ratio is exact only to about a percent.
const WIDTH_TOLERANCE = 0.02;
const ANCHOR_TOLERANCE_PX = 12;
const SNAP_PAGES_AWAY = 2;             // far enough at 250% that the highlight is nowhere near the view
const SNAP_SETTLE_MS = 1500;           // snap scrolls smoothly; give the animation time to land
const SNAP_CENTRE_TOLERANCE_PX = 200;  // "centred" within a line or two, not to the pixel
const LADDER = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const SWEEP = [0.5, 1, 2, 3];
const MAX_LADDER_STEPS = LADDER.length;
const PINCH_DELTA = -120;      // one hard trackpad pinch outwards
// 110/100 is the double nearest 1.1, and 1.1 * 100 is 110.00000000000001: a zoom rounded
// to whole percents is only whole to within float error, so compare to the nearest percent.
const PERCENT_EPSILON = 1e-9;
const MENU = '.read-menu.is-open';

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
  await page.waitForTimeout(SETTLE_MS);
}

/** Scroll page `n` into view and wait for its (lazily rendered) text layer. */
async function showPage(page, n) {
  await page.evaluate((n) => document.querySelector(`.pdf-page-wrap[data-page="${n}"]`).scrollIntoView({ block: 'start' }), n);
  await page.waitForFunction((n) => document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`).length > 0,
    n, { timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
}

const zoomState = (page) => page.evaluate(() => {
  const wrap = document.querySelector('.pdf-page-wrap[data-page="1"]');
  const pill = document.getElementById('zoom-pill');
  return {
    zoom: window.kokoro.state.get().zoom,
    label: document.getElementById('zoomLevel').textContent,
    hidden: pill.hidden,
    outDisabled: document.getElementById('zoomOutBtn').disabled,
    inDisabled: document.getElementById('zoomInBtn').disabled,
    scale: window.kokoro.pdfView.scale(),
    width: wrap ? wrap.getBoundingClientRect().width : 0,
  };
});

/** Press a zoom shortcut and wait for the re-layout it triggers to land. */
async function pressZoom(page, key) {
  const before = await page.evaluate(() => window.kokoro.pdfView.scale());
  await page.keyboard.press(key);
  await page.waitForFunction((s) => window.kokoro.pdfView.scale() !== s, before, { timeout: STEP_TIMEOUT_MS })
    .catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

/** Walk the ladder to `target` with the keyboard, from wherever the reader is now. */
async function setZoom(page, target) {
  await pressZoom(page, 'Meta+Digit0');
  const key = target > 1 ? 'Meta+Equal' : 'Meta+Minus';
  for (let i = 0; i < MAX_LADDER_STEPS; i += 1) {
    if ((await page.evaluate(() => window.kokoro.state.get().zoom)) === target) return true;
    await pressZoom(page, key);
  }
  return (await page.evaluate(() => window.kokoro.state.get().zoom)) === target;
}

/**
 * The pdf.js item index of every text span on page `n` whose centre a drawn highlight rect
 * covers — "which words are under the highlight", measured in the live layout.
 */
const highlightedItems = (page, n) => page.evaluate((n) => {
  const wrap = document.querySelector(`.pdf-page-wrap[data-page="${n}"]`);
  if (!wrap) return null;
  const rects = [...wrap.querySelectorAll('.hl-rect')].map((el) => el.getBoundingClientRect());
  if (!rects.length) return null;
  const spans = [...wrap.querySelectorAll('.textLayer span:not(.markedContent)')];
  return spans
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
      return rects.some((h) => x >= h.left && x <= h.right && y >= h.top && y <= h.bottom);
    })
    .map((el) => window.kokoro.pdfView.itemIndexOf(n, el))
    .sort((a, b) => a - b);
}, n);

/** The item indices carrying the reading (sentence) highlight on page `n`. */
const readingItems = (page, n) => page.evaluate((n) => {
  const wrap = document.querySelector(`.pdf-page-wrap[data-page="${n}"]`);
  return wrap ? [...wrap.querySelectorAll('.textLayer .reading')]
    .map((el) => window.kokoro.pdfView.itemIndexOf(n, el)).sort((a, b) => a - b) : null;
}, n);

/** Text spans on page `n` well inside the viewport, with their boxes and holding sentences. */
const spansOn = (page, n) => page.evaluate(({ n, margin }) => {
  const k = window.kokoro;
  const sentences = k.state.get().sentences;
  // The notes column overlays the right of the window, so "clickable" means inside the
  // document column, not inside the window.
  const column = document.getElementById('content-area').getBoundingClientRect();
  return [...document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer span:not(.markedContent)`)]
    .map((el) => {
      const r = el.getBoundingClientRect();
      const item = k.pdfView.itemIndexOf(n, el);
      const holders = sentences.flatMap((s, i) => (s.page === n && (s.items || []).includes(item) ? [i] : []));
      return {
        item, holders, text: el.textContent,
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        left: r.left, top: r.top, width: r.width, height: r.height,
      };
    })
    // Vertically in view, and its centre clickable: zoomed in, a line is wider than the column.
    .filter((s) => s.top > margin && s.top + s.height < innerHeight - margin
      && s.x > column.left + margin && s.x < column.right - margin);
}, { n, margin: VIEW_MARGIN_PX });

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= DRAG_STEPS; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / DRAG_STEPS, from.y + ((to.y - from.y) * i) / DRAG_STEPS);
  }
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
}

/** 1 & 2. The pill, the ladder, and the width each step draws. */
async function ladderCase(page) {
  console.log('\n1. the zoom pill');
  const start = await zoomState(page);
  check('it is showing now a paper is open', start.hidden === false);
  check('it reads 100% — fit-to-width is the baseline', start.label === '100%', start.label);
  check('the state agrees', start.zoom === 1, String(start.zoom));

  console.log('\n2. ⌘+ / ⌘− / ⌘0 and the pill buttons walk the ladder');
  const fitWidth = start.width;
  for (const target of LADDER.filter((z) => z > 1)) {
    await pressZoom(page, 'Meta+Equal');
    const now = await zoomState(page);
    const ratio = now.width / fitWidth;
    check(`⌘+ → ${Math.round(target * 100)}%, page drawn ${ratio.toFixed(3)}× fit-width`,
      now.zoom === target && now.label === `${Math.round(target * 100)}%`
      && Math.abs(ratio - target) / target <= WIDTH_TOLERANCE,
      JSON.stringify({ zoom: now.zoom, label: now.label, ratio }));
  }
  check('at 300% zooming in is offered as unavailable, not silently ignored', (await zoomState(page)).inDisabled === true);
  await pressZoom(page, 'Meta+Equal');
  check('… and ⌘+ there is a no-op', (await zoomState(page)).zoom === 3);

  await pressZoom(page, 'Meta+Digit0');
  const reset = await zoomState(page);
  check('⌘0 returns to fit-width, at the width it started with',
    reset.zoom === 1 && Math.abs(reset.width - fitWidth) <= 1, JSON.stringify({ zoom: reset.zoom, width: reset.width, fitWidth }));

  for (const target of [...LADDER].reverse().filter((z) => z < 1)) {
    await pressZoom(page, 'Meta+Minus');
    const now = await zoomState(page);
    const ratio = now.width / fitWidth;
    check(`⌘− → ${Math.round(target * 100)}%, page drawn ${ratio.toFixed(3)}× fit-width`,
      now.zoom === target && Math.abs(ratio - target) / target <= WIDTH_TOLERANCE,
      JSON.stringify({ zoom: now.zoom, ratio }));
  }
  check('at 50% zooming out is offered as unavailable', (await zoomState(page)).outDisabled === true);

  const scaleBefore = await page.evaluate(() => window.kokoro.pdfView.scale());
  await page.click('#zoomInBtn');
  await page.waitForFunction((s) => window.kokoro.pdfView.scale() !== s, scaleBefore, { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  check('the pill\'s + button steps too', (await zoomState(page)).zoom === 0.67, String((await zoomState(page)).zoom));
  await page.click('#zoomLevel');
  await page.waitForTimeout(SETTLE_MS);
  check('clicking the percentage goes back to fit-width', (await zoomState(page)).zoom === 1);
}

/** 3. A trackpad pinch: ctrl-wheel, anchored at the pointer. */
async function pinchCase(page) {
  console.log('\n3. trackpad pinch (ctrl-wheel)');
  await showPage(page, TEXT_PAGE);
  const spans = (await spansOn(page, TEXT_PAGE)).filter((s) => s.text.trim().length >= MIN_SPAN_CHARS);
  const target = spans[Math.floor(spans.length / 2)];
  check('found a word to pinch around', Boolean(target));
  if (!target) return;

  await page.mouse.move(target.x, target.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, PINCH_DELTA);
  await page.keyboard.up('Control');
  await page.waitForTimeout(SETTLE_MS * 2);
  const after = await zoomState(page);
  check(`one pinch outwards zooms in (now ${after.label})`, after.zoom > 1, JSON.stringify(after));
  if (after.zoom <= 1) return;
  check('it lands on a whole percentage, so the readout is stable',
    /^\d+%$/.test(after.label)
    && Math.abs(after.zoom * 100 - Math.round(after.zoom * 100)) < PERCENT_EPSILON, after.label);

  const moved = (await spansOn(page, TEXT_PAGE)).find((s) => s.item === target.item);
  check('the word under the fingers stays under the fingers',
    moved && Math.abs(moved.y - target.y) <= ANCHOR_TOLERANCE_PX && Math.abs(moved.x - target.x) <= ANCHOR_TOLERANCE_PX,
    JSON.stringify({ was: { x: target.x, y: target.y }, now: moved && { x: moved.x, y: moved.y } }));
  await pressZoom(page, 'Meta+Digit0');
}

/** 4. Highlights keep covering the same words at every zoom. */
async function highlightCase(page) {
  console.log('\n4. highlights at 50 / 100 / 200 / 300%');
  await showPage(page, TEXT_PAGE);
  const lines = (await spansOn(page, TEXT_PAGE))
    .filter((s) => s.text.trim().length >= MIN_SPAN_CHARS && s.width >= MIN_SPAN_WIDTH_PX);
  // Several lines, so the check has more than one word and more than one rect to keep aligned.
  const picked = lines.slice(Math.floor(lines.length / 2), Math.floor(lines.length / 2) + HL_LINES);
  check(`found ${HL_LINES} lines to highlight`, picked.length === HL_LINES);
  if (picked.length !== HL_LINES) return;
  const [first, last] = [picked[0], picked[picked.length - 1]];
  await drag(page,
    { x: first.left + EDGE_INSET_PX, y: first.top + first.height / 2 },
    { x: last.left + last.width - EDGE_INSET_PX, y: last.top + last.height / 2 });
  const toolbar = Boolean(await page.$('.hl-toolbar.is-open'));
  check('the highlight toolbar opens', toolbar);
  if (!toolbar) return;
  await page.click(`.hl-toolbar.is-open .hl-swatch[data-color="${HL_COLOR}"]`);
  await page.waitForTimeout(SETTLE_MS);

  // Paint the sentence highlight the player would paint, without waiting on audio.
  const sentence = await page.evaluate((n) => {
    const s = window.kokoro.state.get().sentences.find((x) => x.page === n && (x.items || []).length > 2);
    if (s) window.kokoro.pdfView.highlightItems(n, s.items);
    return s ? { text: s.text, items: [...s.items].sort((a, b) => a - b) } : null;
  }, TEXT_PAGE);
  check('a sentence on that page has spans to highlight', Boolean(sentence));

  let baseline = null;
  for (const zoom of SWEEP) {
    check(`zoomed to ${zoom * 100}%`, await setZoom(page, zoom));
    await showPage(page, TEXT_PAGE);
    const items = await highlightedItems(page, TEXT_PAGE);
    if (!baseline) baseline = items;
    check(`the highlight still covers exactly those ${baseline?.length ?? 0} words at ${zoom * 100}%`,
      Boolean(items) && JSON.stringify(items) === JSON.stringify(baseline), JSON.stringify({ items, baseline }));
    if (sentence) {
      const reading = await readingItems(page, TEXT_PAGE);
      check(`the sentence highlight is on the same spans of the text layer at ${zoom * 100}%`,
        JSON.stringify(reading) === JSON.stringify(sentence.items), JSON.stringify({ reading, want: sentence.items }));
    }
  }
  await page.evaluate(() => window.kokoro.pdfView.clearHighlights());
}

/** 5. Read-from-here at 200%. */
async function readFromHereCase(page, ttsTexts) {
  console.log('\n5. read from here at 200%');
  check('zoomed to 200%', await setZoom(page, 2));
  await showPage(page, TEXT_PAGE);
  const spoken = (await spansOn(page, TEXT_PAGE)).filter((s) => s.holders.length && s.text.trim().length >= 4);
  const target = spoken[Math.floor(spoken.length / 2)];
  check('found a spoken word in view at 200%', Boolean(target));
  if (!target) return;
  const before = await page.evaluate(() => window.kokoro.state.get().index);

  await page.mouse.click(target.x, target.y, { button: 'right' });
  const opened = await page.waitForSelector(MENU, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false);
  check('the menu opens at the zoomed pointer', opened);
  if (!opened) return;
  await page.keyboard.press('Enter');
  const want = target.holders[0];
  await page.waitForFunction((w) => window.kokoro.state.get().index === w, want, { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  const index = await page.evaluate(() => window.kokoro.state.get().index);
  check(`it starts at sentence ${want}, the one holding "${target.text.trim().slice(0, 24)}"`,
    index === want && index !== before, `index ${index}, was ${before}`);
  const reading = await readingItems(page, TEXT_PAGE);
  check('the reading highlight covers the clicked word at 200%', (reading || []).includes(target.item),
    JSON.stringify({ item: target.item, reading }));
  const text = await page.evaluate(() => window.kokoro.state.get().sentences[window.kokoro.state.get().index]?.text);
  const asked = await new Promise((resolve) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    const poll = () => (ttsTexts.includes(text) ? resolve(true)
      : Date.now() > deadline ? resolve(false) : setTimeout(poll, SETTLE_MS));
    poll();
  });
  check('/api/tts is asked for that sentence', asked);
  await page.evaluate(() => window.kokoro.player.stop());
  await page.waitForTimeout(SETTLE_MS);
}

/** The union box of the reading highlight, in viewport coordinates, or null when there is none. */
const readingRect = (page) => page.evaluate(() => {
  const spans = [...document.querySelectorAll('.textLayer .reading')];
  if (!spans.length) return null;
  const boxes = spans.map((el) => el.getBoundingClientRect());
  return { top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)) };
});

/** 5b. Snap (now the Follow switch, R1). U6's done-criteria name snap beside highlights and read-from-here. */
async function snapCase(page) {
  console.log('\n5b. snap comes back to the sentence being read, zoomed in');
  check('zoomed to 250%', await setZoom(page, 2.5));
  const held = await readingRect(page);
  check('there is a reading highlight to come back to', Boolean(held), JSON.stringify(held));
  if (!held) return;
  await showPage(page, TEXT_PAGE + SNAP_PAGES_AWAY);
  const away = await readingRect(page);
  check(`scrolled ${SNAP_PAGES_AWAY} pages on, it is off screen`,
    !away || away.bottom < 0 || away.top > VIEWPORT.height, JSON.stringify(away));
  // R1: Snap is part of Follow. A programmatic scroll does not suspend following, so the
  // switch is unlit: pressing it off and on again is the snap (switching on scrolls).
  check('the follow switch is offered, not disabled', (await page.$eval('#followBtn', (el) => el.disabled)) === false);
  const isLit = await page.$eval('#followBtn', (el) => el.classList.contains('attention'));
  if (!isLit) await page.click('#followBtn');
  await page.click('#followBtn');
  await page.waitForTimeout(SNAP_SETTLE_MS);   // scrollIntoView({ behavior: 'smooth' })
  const back = await readingRect(page);
  check('snap puts it back on screen at 250%',
    Boolean(back) && back.bottom > 0 && back.top < VIEWPORT.height, JSON.stringify(back));
  check('… near the middle of the view, which is where block:"center" asks for it',
    Boolean(back) && Math.abs((back.top + back.bottom) / 2 - VIEWPORT.height / 2) <= SNAP_CENTRE_TOLERANCE_PX,
    JSON.stringify(back));
}

/** 6. The scroll anchor. */
async function anchorCase(page) {
  console.log('\n6. zoom keeps the middle of the viewport on the same words');
  check('back to fit-width', await setZoom(page, 1));
  await showPage(page, TEXT_PAGE);
  // The document area's centre, not the window's: it starts below the view strip (layout.js anchorPoint).
  const centre = await page.$eval('#content-area', (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
  const spans = await spansOn(page, TEXT_PAGE);
  const middle = spans.reduce((best, s) => (Math.abs(s.y - centre) < Math.abs(best.y - centre) ? s : best), spans[0]);
  const before = await zoomState(page);
  check('found the word at the centre of the viewport', Boolean(middle));
  if (!middle) return;
  await pressZoom(page, 'Meta+Equal');
  await pressZoom(page, 'Meta+Equal');
  const after = await zoomState(page);
  const now = (await spansOn(page, TEXT_PAGE)).find((s) => s.item === middle.item);
  // The centre of the document area is the fixed point: everything else moves away from it in
  // proportion, so this is where the word must be if the anchor held.
  const want = centre + (middle.y - centre) * (after.scale / before.scale);
  check(`the word by the centre is where the zoom to ${after.label} should leave it`,
    Boolean(now) && Math.abs(now.y - want) <= ANCHOR_TOLERANCE_PX,
    JSON.stringify({ was: middle.y, want, now: now && now.y }));
  check('… and that is still on screen, not scrolled past',
    Boolean(now) && now.y > 0 && now.y < VIEWPORT.height, JSON.stringify(now && now.y));
}

/** 7. Selection at 300%. */
async function selectionCase(page) {
  console.log('\n7. text selection at 300%');
  check('zoomed to 300%', await setZoom(page, 3));
  await showPage(page, TEXT_PAGE);
  const words = (await spansOn(page, TEXT_PAGE)).filter((s) => /\w{5,}/.test(s.text));
  const target = words[Math.floor(words.length / 2)];
  check('found a word in view at 300%', Boolean(target));
  if (!target) return;
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(SETTLE_MS);
  const selected = (await page.evaluate(() => getSelection().toString())).trim();
  check(`double-click selects a word from the span under the pointer ("${selected.slice(0, 24)}")`,
    selected.length > 0 && target.text.includes(selected), JSON.stringify({ selected, span: target.text }));
  await page.evaluate(() => getSelection().removeAllRanges());
}

/** 8. Persistence. */
async function persistenceCase(page) {
  console.log('\n8. the level persists');
  check('zoomed to 150%', await setZoom(page, 1.5));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kokoro.prefs.v2') || '{}').zoom);
  check('it is written to the prefs, beside speed and voice', stored === 1.5, String(stored));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.kokoro), null, { timeout: STEP_TIMEOUT_MS });
  check('the reloaded app comes back at 150%', (await page.evaluate(() => window.kokoro.state.get().zoom)) === 1.5);
  await page.setInputFiles('#file-input', PDF);
  await page.waitForFunction(() => !document.getElementById('ppBtn').disabled, null, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
  const now = await zoomState(page);
  check('the pill shows it and the paper opens drawn at that size', now.label === '150%' && now.zoom === 1.5,
    JSON.stringify(now));
  await pressZoom(page, 'Meta+Digit0');
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
    if (EMULATE_PYWEBVIEW) {
      const css = pywebviewNoSelectCss();
      await context.addInitScript((rule) => addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = rule;
        document.head.appendChild(style);
      }), css);
    }
    const page = await context.newPage();
    const ttsTexts = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/tts') ttsTexts.push(url.searchParams.get('text'));
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      const favicon = /\/favicon\.ico$/.test(msg.location().url || '');
      if (msg.type() === 'error' && !favicon) errors.push(`console: ${msg.text()}`);
    });

    console.log(`${process.env.BROWSER || 'chromium'} · ${BASE_URL} · pywebview CSS ${EMULATE_PYWEBVIEW ? 'on' : 'off'}`);
    await page.goto(BASE_URL);
    // `el.hidden` is the property the app sets, not the effect: `#zoom-pill { display: flex }`
    // outranks the UA sheet's `[hidden] { display: none }`, so the pill can be hidden and
    // still drawn. Ask the engine what it actually rendered.
    const closed = await page.$eval('#zoom-pill', (el) => ({ hidden: el.hidden, display: getComputedStyle(el).display }));
    check('the pill is marked hidden with no paper open', closed.hidden === true, JSON.stringify(closed));
    check('… and is actually off the screen, not just flagged', closed.display === 'none', JSON.stringify(closed));
    await openPaper(page);
    await ladderCase(page);
    await pinchCase(page);
    await highlightCase(page);
    await readFromHereCase(page, ttsTexts);
    await snapCase(page);
    await anchorCase(page);
    await selectionCase(page);
    await persistenceCase(page);
    console.log('');
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

// Real-browser check for T5: "double/right click on a section of text and then select
// 'read from here' to begin reading from the selection".
//
// It drives, on GR00TN1:
//   1. right-click a word mid-page on page 2 → menu at the pointer → keyboard Enter on
//      "Read from here" → the current sentence is the first one holding the clicked span, its
//      queue row is active, the reading highlight covers that span, and /api/tts is asked for
//      that sentence's text. Escape, an outside click and a scroll each dismiss the menu.
//   2. double-click a word → the highlight toolbar still highlights; double-click another word
//      → the toolbar's "Read from here" starts at the sentence holding that word.
//   3. right-click a figure label (page 3) and the page number (page 2), neither of which is
//      spoken → the next spoken sentence; a right-click on blank figure area opens the menu too.
//   4. right-click outside the text layer (the sidebar) is not prevented.
//   5. no console errors.
// The pywebview no-select CSS is injected, as in notes_highlight.mjs.
//
// Run (no repo npm deps; Playwright comes from outside the repo):
//   KOKORO_DATA_DIR=$(mktemp -d) KOKORO_LLM=0 venv/bin/python -m uvicorn app:app --port 8765
//   PLAYWRIGHT_DIR=/path/to/node_modules node tests/e2e/read_from_here.mjs
// Env: KOKORO_URL, PLAYWRIGHT_DIR, CHROMIUM_PATH, BROWSER, KOKORO_E2E_PDF, EMULATE_PYWEBVIEW — as in
// notes_highlight.mjs. The paper must have no notes record on that server (playback saves a resume
// position): the check refuses to touch an existing one and deletes the record it creates.
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
const MIN_WORD_CHARS = 4;
const VIEW_MARGIN_PX = 120;
const TEXT_PAGE = 2;
const FIGURE_PAGE = 3;
const FIGURE_LABEL = 'Robot State';
const PAGE_NUMBER_RE = /^\s*\d+\s*$/; // a footer page number such as "2"
const SCROLL_NUDGE_PX = 40;
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
}

async function showPage(page, n) {
  await page.evaluate((n) => document.querySelector(`.pdf-page-wrap[data-page="${n}"]`).scrollIntoView({ block: 'start' }), n);
  await page.waitForFunction((n) => document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`).length > 0,
    n, { timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Text spans on page `n` in view, tagged in the DOM (data-e2e) so they can be found again, with
 * their pdf.js item index and the script indices of the sentences whose items hold that item.
 */
const spansOn = (page, n) => page.evaluate(({ n, margin }) => {
  const k = window.kokoro;
  const indexOf = k.pdfView?.itemIndexOf;
  if (typeof indexOf !== 'function') return null;
  const sentences = k.state.get().sentences;
  return [...document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer span:not(.markedContent)`)]
    .map((el, i) => {
      el.dataset.e2e = `${n}-${i}`;
      const r = el.getBoundingClientRect();
      const item = indexOf(n, el);
      const holders = sentences.flatMap((s, idx) => (s.page === n && (s.items || []).includes(item) ? [idx] : []));
      return { key: el.dataset.e2e, text: el.textContent, item, holders, x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, width: r.width };
    })
    .filter((s) => s.top > margin && s.bottom < innerHeight - margin);
}, { n, margin: VIEW_MARGIN_PX });

const snapshot = (page, key) => page.evaluate((key) => {
  const s = window.kokoro.state.get();
  const idx = s.index;
  const span = key && document.querySelector(`[data-e2e="${key}"]`);
  return {
    index: idx,
    sentence: s.sentences[idx] || null,
    status: document.getElementById('status-bar')?.textContent || '',
    spanReading: Boolean(span?.classList.contains('reading')),
    readingPages: [...new Set([...document.querySelectorAll('.textLayer .reading')].map((el) => el.closest('.pdf-page-wrap').dataset.page))],
  };
}, key);

const lastContextMenu = (page) => page.evaluate(() => window.__e2eContextMenu || null);

/** Wait for a /api/tts request for `text`, or the deadline. */
function ttsRequestFor(requests, text) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  return new Promise((resolve) => {
    const poll = () => {
      if (requests.some((t) => t === text)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, SETTLE_MS);
    };
    poll();
  });
}

async function openMenuAt(page, point) {
  await page.mouse.click(point.x, point.y, { button: 'right' });
  return page.waitForSelector(MENU, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false);
}

/** 1. Right-click a mid-page word, choose with the keyboard; the menu's dismissals. */
async function rightClickCase(page, ttsTexts) {
  console.log(`\n1. right-click a word mid-page on page ${TEXT_PAGE}`);
  await showPage(page, TEXT_PAGE);
  const spans = await spansOn(page, TEXT_PAGE);
  check('the app exposes pdf.js item indices for spans', Boolean(spans));
  if (!spans) return;
  const spoken = spans.filter((s) => s.holders.length && s.text.trim().length >= MIN_WORD_CHARS);
  const target = spoken[Math.floor(spoken.length / 2)];
  check('found a spoken span mid-page', Boolean(target));
  if (!target) return;
  const before = (await snapshot(page)).index;

  const opened = await openMenuAt(page, target);
  check('right-click on the text layer prevents the native menu', (await lastContextMenu(page))?.prevented === true);
  check('a menu opens', opened);
  if (!opened) return;
  const menu = await page.$eval(MENU, (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, label: el.textContent.trim(), focused: document.activeElement?.classList.contains('read-menu-item') };
  });
  check('it offers "Read from here"', menu.label === 'Read from here', menu.label);
  check('it is anchored at the pointer', Math.abs(menu.left - target.x) <= 1 && Math.abs(menu.top - target.y) <= 1,
    JSON.stringify({ menu, pointer: { x: target.x, y: target.y } }));
  check('its item has keyboard focus', menu.focused === true);

  await page.keyboard.press('Escape');
  check('Escape dismisses it', !(await page.$(MENU)));
  await openMenuAt(page, target);
  await page.mouse.click(VIEWPORT.width / 2, 4);
  check('an outside click dismisses it', !(await page.$(MENU)));
  await openMenuAt(page, target);
  await page.evaluate((dy) => document.getElementById('content-area').scrollBy(0, dy), SCROLL_NUDGE_PX);
  await page.waitForTimeout(SETTLE_MS);
  check('a scroll dismisses it', !(await page.$(MENU)));

  const fresh = (await spansOn(page, TEXT_PAGE)).find((s) => s.key === target.key) || target;
  await openMenuAt(page, fresh);
  await page.keyboard.press('Enter');
  check('choosing the item closes the menu', !(await page.$(MENU)));
  const expected = target.holders[0];
  await page.waitForFunction((want) => window.kokoro.state.get().index === want, expected, { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  const after = await snapshot(page, target.key);
  check(`the current sentence jumps to ${expected}, the first holding item ${target.item} ("${target.text.trim().slice(0, 30)}")`,
    after.index === expected && expected !== before, `index ${after.index}, was ${before}, holders ${target.holders}`);
  check('the status field names that sentence', after.status.toLowerCase().includes(`sentence ${after.index + 1} /`), after.status);
  check(`the reading highlight is on page ${TEXT_PAGE} and covers the clicked span`,
    after.spanReading && after.readingPages.length === 1 && after.readingPages[0] === String(TEXT_PAGE), JSON.stringify(after.readingPages));
  check('/api/tts is asked for that sentence', await ttsRequestFor(ttsTexts, after.sentence?.text));
}

/** 2. Double-click: the highlight toolbar still highlights, and carries Read from here. */
async function doubleClickCase(page) {
  console.log(`\n2. double-click a word on page ${TEXT_PAGE}`);
  await showPage(page, TEXT_PAGE);
  const words = (await spansOn(page, TEXT_PAGE) || []).filter((s) => s.holders.length && /\w{4,}/.test(s.text));
  check('found two spoken spans to double-click', words.length >= 2);
  if (words.length < 2) return;
  const [first, second] = [words[1], words[words.length - 2]];

  const rectsBefore = await page.$$eval(`.pdf-page-wrap[data-page="${TEXT_PAGE}"] .hl-rect`, (els) => els.length);
  await page.mouse.dblclick(first.x, first.y);
  await page.waitForTimeout(SETTLE_MS);
  const word = await page.evaluate(() => getSelection().toString().trim());
  check('double-click selects a word', word.length > 0 && first.text.includes(word), JSON.stringify(word));
  check('the highlight toolbar opens', Boolean(await page.$('.hl-toolbar.is-open')));
  check('no read menu competes with it', !(await page.$(MENU)));
  const readBtn = await page.$('.hl-toolbar.is-open .hl-act[data-act="read"]');
  check('the toolbar offers "Read from here"', Boolean(readBtn) && (await readBtn.textContent()).includes('Read from here'));
  await page.click('.hl-toolbar.is-open .hl-swatch[data-color="yellow"]');
  const rectsAfter = await page.$$eval(`.pdf-page-wrap[data-page="${TEXT_PAGE}"] .hl-rect`, (els) => els.length);
  check('a swatch still highlights the word', rectsAfter === rectsBefore + 1, `${rectsBefore} → ${rectsAfter}`);

  await page.mouse.dblclick(second.x, second.y);
  await page.waitForTimeout(SETTLE_MS);
  const opened = Boolean(await page.$('.hl-toolbar.is-open .hl-act[data-act="read"]'));
  check('double-clicking another word opens the toolbar again', opened);
  if (!opened) return;
  await page.click('.hl-toolbar.is-open .hl-act[data-act="read"]');
  const expected = second.holders[0];
  await page.waitForFunction((want) => window.kokoro.state.get().index === want, expected, { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  const after = await snapshot(page, second.key);
  check(`toolbar Read from here starts at sentence ${expected}, the first holding "${second.text.trim().slice(0, 30)}"`,
    after.index === expected, `index ${after.index}, holders ${second.holders}`);
  check('the reading highlight covers the double-clicked span', after.spanReading);
}

/** The next spoken sentence after an unspoken item: nothing spoken on the page sits between them. */
function isNextSpoken(sentences, index, page, item) {
  const s = sentences[index];
  if (!s) return false;
  const laterOnPage = (x) => x.page === page && (x.items || []).some((i) => i > item);
  if (s.page === page) {
    const start = Math.min(...s.items.filter((i) => i > item));
    return !sentences.some((x) => x.page === page && (x.items || []).some((i) => i > item && i < start));
  }
  const firstLater = sentences.findIndex((x) => x.page > page);
  return !sentences.some(laterOnPage) && index === firstLater;
}

async function skippedCase(page, n, pick, label) {
  const spans = (await spansOn(page, n)) || [];
  const target = pick(spans);
  check(`found ${label}, not in the script`, Boolean(target) && target.holders.length === 0, JSON.stringify(target));
  if (!target || target.holders.length) return;
  const opened = await openMenuAt(page, target);
  check(`right-click on ${label} opens the menu`, opened);
  if (!opened) return;
  await page.click(`${MENU} .read-menu-item`);
  await page.waitForTimeout(SETTLE_MS);
  const { sentences, index } = await page.evaluate(() => ({ sentences: window.kokoro.state.get().sentences, index: window.kokoro.state.get().index }));
  const s = sentences[index];
  check(`${label} (item ${target.item}) starts at the next spoken sentence: ${index} on page ${s?.page}`,
    isNextSpoken(sentences, index, n, target.item), JSON.stringify({ index, page: s?.page, items: s?.items }));
}

/** 3. Unspoken regions: a figure label, the page number, blank figure area. */
async function skippedRegions(page) {
  console.log('\n3. figure and footer regions');
  await showPage(page, FIGURE_PAGE);
  await skippedCase(page, FIGURE_PAGE, (spans) => spans.find((s) => s.text.includes(FIGURE_LABEL)), `the figure label "${FIGURE_LABEL}"`);
  await showPage(page, TEXT_PAGE);
  await page.evaluate(({ n, re }) => [...document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer span`)]
    .filter((el) => new RegExp(re).test(el.textContent)).pop()?.scrollIntoView({ block: 'center' }), { n: TEXT_PAGE, re: PAGE_NUMBER_RE.source });
  await page.waitForTimeout(SETTLE_MS);
  await skippedCase(page, TEXT_PAGE, (spans) => spans.filter((s) => PAGE_NUMBER_RE.test(s.text)).pop(), 'the page number');

  await showPage(page, FIGURE_PAGE);
  const blank = await page.evaluate((n) => {
    const layer = document.querySelector(`.pdf-page-wrap[data-page="${n}"] .textLayer`);
    const label = [...layer.querySelectorAll('span')].find((s) => s.textContent.includes('Robot State'));
    const r = label.getBoundingClientRect();
    for (let dy = 0; dy < 200; dy += 5) {
      const x = r.left + r.width / 2;
      const y = r.top - dy;
      if (document.elementFromPoint(x, y) === layer) return { x, y };
    }
    return null;
  }, FIGURE_PAGE);
  check('found blank figure area on the text layer', Boolean(blank));
  if (!blank) return;
  const opened = await openMenuAt(page, blank);
  check('right-click on blank figure area opens the menu', opened);
  if (!opened) return;
  await page.click(`${MENU} .read-menu-item`);
  await page.waitForTimeout(SETTLE_MS);
  const after = await snapshot(page);
  check(`blank figure area starts reading on page ${FIGURE_PAGE} or later`, after.sentence?.page >= FIGURE_PAGE,
    JSON.stringify({ index: after.index, page: after.sentence?.page }));
}

/** 4. Outside the text layer the browser keeps its own context menu. */
async function outsideCase(page) {
  console.log('\n4. right-click outside the text layer');
  const box = await page.$eval('#sidebar', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(box.x, box.y, { button: 'right' });
  const ctx = await lastContextMenu(page);
  check('the sidebar right-click is not prevented', ctx && ctx.prevented === false && ctx.inText === false, JSON.stringify(ctx));
  check('no read menu opens', !(await page.$(MENU)));
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
    // A window listener in the bubble phase sees defaultPrevented after every app handler ran.
    await context.addInitScript(() => addEventListener('contextmenu', (e) => {
      window.__e2eContextMenu = { prevented: e.defaultPrevented, inText: Boolean(e.target.closest?.('.textLayer')) };
    }));
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
    await openPaper(page);
    await rightClickCase(page, ttsTexts);
    await doubleClickCase(page);
    await skippedRegions(page);
    await outsideCase(page);
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

// Real-browser check for read-along (follow.js): "the page follows the sentence being read, and a
// paper reopens at its saved place".
//
// It drives, on GR00TN1, with /api/tts answered by a short silent WAV so reading moves quickly:
//   1. during playback the current sentence stays in view as reading crosses from page 2 to 3.
//   2. a wheel over the document suspends following (Follow and its rail twin light up, and the
//      "Follow paused" pill shows); the view then holds still while reading moves on, and pressing
//      Follow resumes and scrolls back (R1). Left alone, following picks up by itself (F1).
//   3. a press on the scrollbar (the right 16px of #content-area) suspends; a press on the text
//      does not.
//   4. a wheel over the #view-status strip does not suspend.
//   5. ⌘+ during playback keeps the current sentence in view.
//   6. reopening the paper scrolls to the saved sentence (not just its page) and starts no audio.
//   7. in the margin notes view, typing in a note is not yanked away by following, and following
//      picks up again once the caret leaves the note.
//   8. a follow scroll animates, and still does under reducedMotion 'reduce' (Smooth scrolling is
//      a pref, on by default); with Smooth scrolling unchecked it lands in one step.
//   9. with the follow switch off, playing leaves the view where it is and Follow stays unlit;
//      switching it back on brings the sentence into view.
//  10. a 720 px window (half a laptop screen) folds the sidebar to its rail and the notes away, and
//      gives the paper most of the width; widening restores both.
//  11. no console errors.
//
// Run (no repo npm deps; Playwright comes from outside the repo):
//   KOKORO_DATA_DIR=$(mktemp -d) KOKORO_LLM=0 venv/bin/python -m uvicorn app:app --port 8765
//   PLAYWRIGHT_DIR=/path/to/node_modules node tests/e2e/follow.mjs
// Env: KOKORO_URL, PLAYWRIGHT_DIR, CHROMIUM_PATH, BROWSER (chromium|webkit), KOKORO_E2E_PDF,
//      EMULATE_PYWEBVIEW — as in read_from_here.mjs.
// The paper must have no notes record on that server: the check refuses to touch an existing one
// and deletes the record it creates. Exit code 0 = pass, 1 = fail.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OVERLAY_SCROLLBAR_PX as SCROLLBAR_PX, AUTO_RESUME_MS } from '../../static/js/follow.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_URL = process.env.KOKORO_URL || 'http://127.0.0.1:8765/';
const PDF = process.env.KOKORO_E2E_PDF;
if (!PDF) {
  console.error('KOKORO_E2E_PDF is not set. Point it at the PDF this check should drive.');
  process.exit(2);
}
const EMULATE_PYWEBVIEW = process.env.EMULATE_PYWEBVIEW !== '0';
const ENGINE = process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium';
const VIEWPORT = { width: 1440, height: 900 };
const LOAD_TIMEOUT_MS = 90000;
const STEP_TIMEOUT_MS = 30000;
const SAVE_TIMEOUT_MS = 15000;
const SETTLE_MS = 400;
const SCROLL_SETTLE_MS = 1500;     // a smooth scroll across a page or two has landed by then
const SENTENCE_AUDIO_MS = 1500;    // long enough for a smooth follow scroll to land inside one sentence
const WAV_RATE = 8000;
const LEAD_SENTENCES = 3;          // start this many sentences before the end of page 2
const TRAIL_SENTENCES = 2;         // …and read this far into page 3
const FROM_PAGE = 2;
const HOLD_SENTENCES = 2;          // sentences read while the view must hold still
const WHEEL_HOLD_SENTENCES = 1;    // the wheel's hold is checked well inside AUTO_RESUME_MS
const WHEEL_PX = 1500;             // well over a view: the sentence leaves the screen
const STATUS_WHEEL_PX = 200;
const EDGE_PX = 4;
const ROW_STILL_PX = 1;            // subpixel rounding: a row that moved less has not moved
const TYPE_DELAY_MS = 150;
const MAX_TYPED = 80;
const NOTE_TEXT = 'following must not move this note';
const ZOOM_STEPS = 2;
const TEXT_MARGIN_PX = 120;
const COLUMN_SCAN_STEP_PX = 20;
const NARROW_VIEWPORT = { width: 720, height: 900 };
const MIN_PAPER_PX = 500;
const MIN_PAPER_SHARE = 0.75;      // of the window's width, at NARROW_VIEWPORT

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures.push(name);
};
/** A precondition: a case that could not set itself up stops the run rather than pass short. */
const must = (name, cond, detail = '') => {
  check(name, cond, detail);
  if (!cond) throw new Error(`precondition failed: ${name}${detail ? `  ${detail}` : ''}`);
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

/** A mono 16-bit PCM WAV of silence: a canonical 44-byte RIFF header, then zeros. */
function silentWav(ms) {
  const bytes = Math.round((WAV_RATE * ms) / 1000) * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(WAV_RATE, 24); b.writeUInt32LE(WAV_RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

async function openPaper(page) {
  await page.setInputFiles('#file-input', PDF);
  await page.waitForFunction(() => !document.getElementById('ppBtn').disabled, null, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
}

async function showPage(page, n) {
  await page.evaluate((n) => document.querySelector(`.pdf-page-wrap[data-page="${n}"]`).scrollIntoView({ block: 'start', behavior: 'instant' }), n);
  await page.waitForFunction((n) => document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`).length > 0,
    n, { timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
}

// ── What the reader sees ─────────────────────────────────────────────────────

/** The reading highlight's first span against the scroller, as follow.js measures it. */
const reading = (page) => page.evaluate(() => {
  const view = document.getElementById('content-area');
  const v = view.getBoundingClientRect();
  const r = document.querySelector('.textLayer .reading')?.getBoundingClientRect();
  const { index, sentences } = window.kokoro.state.get();
  return {
    index, page: sentences[index]?.page, scrollTop: view.scrollTop,
    has: Boolean(r), inView: Boolean(r) && r.top >= v.top && r.bottom <= v.bottom,
    top: r?.top, bottom: r?.bottom, view: [v.top, v.bottom],
  };
});

/** The player's media element, for a failure that says why reading stopped. */
const audioState = (page) => page.evaluate(() => {
  const a = document.querySelector('audio');
  return a && { paused: a.paused, ended: a.ended, t: a.currentTime, dur: a.duration, ready: a.readyState, err: a.error?.code };
});

const suspended = (page) => page.$$eval('#followBtn, #railFollowBtn', (els) => els.map((el) => el.classList.contains('attention')));
const isSuspended = async (page) => (await suspended(page)).every(Boolean);
const isFollowing = async (page) => !(await suspended(page)).some(Boolean);

const playing = (page) => page.evaluate(() => window.kokoro.player.state().isPlaying);

/** Wait until the player has moved `n` sentences on from where it is now. */
async function sentencesOn(page, n = 1) {
  const from = await page.evaluate(() => window.kokoro.state.get().index);
  await page.waitForFunction((want) => window.kokoro.state.get().index >= want, from + n,
    { timeout: STEP_TIMEOUT_MS + n * SENTENCE_AUDIO_MS });
}

/** Start reading at sentence `idx` (R2 removed the queue rows): park the cursor, then Play, which resumes following. */
async function playFrom(page, idx) {
  await pause(page);
  await page.evaluate((i) => window.kokoro.player.setIndex(i), idx);
  await page.click('#ppBtn');
  await page.waitForFunction((i) => window.kokoro.state.get().index === i && window.kokoro.player.state().isPlaying,
    idx, { timeout: STEP_TIMEOUT_MS });
}

async function pause(page) {
  if (await playing(page)) await page.click('#ppBtn');
  await page.waitForFunction(() => !window.kokoro.player.state().isPlaying, null, { timeout: STEP_TIMEOUT_MS });
}

/** R1: Snap is part of Follow. A lit Follow resumes on a press; an unlit one is pressed off and on. */
async function snap(page) {
  if (!(await isSuspended(page))) await page.click('#followBtn');
  await page.click('#followBtn');
  await page.waitForTimeout(SCROLL_SETTLE_MS);
}

/** Record, every frame, whether the sentence being read is on screen; keyed by sentence index. */
const startSampler = (page) => page.evaluate(() => {
  const view = document.getElementById('content-area');
  const log = {};
  window.__followLog = { log, on: true };
  const tick = () => {
    if (!window.__followLog.on) return;
    const { index, sentences } = window.kokoro.state.get();
    const v = view.getBoundingClientRect();
    const r = document.querySelector('.textLayer .reading')?.getBoundingClientRect();
    log[index] = { page: sentences[index]?.page, has: Boolean(r), inView: Boolean(r) && r.top >= v.top && r.bottom <= v.bottom };
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const stopSampler = (page) => page.evaluate(() => { window.__followLog.on = false; return window.__followLog.log; });

/** A point on a text span in the middle of the document column. */
const textPoint = (page) => page.evaluate((margin) => {
  const col = document.getElementById('content-area').getBoundingClientRect();
  const spans = [...document.querySelectorAll('.textLayer > span')].map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ el, r }) => el.textContent.trim().length > 3 && r.top > col.top + margin && r.bottom < col.bottom - margin
      && r.left > col.left && r.right < col.right);
  const hit = spans[Math.floor(spans.length / 2)];
  if (!hit) return null;
  const [x, y] = [hit.r.left + hit.r.width / 2, hit.r.top + hit.r.height / 2];
  return document.elementFromPoint(x, y) === hit.el ? { x, y } : null;
}, TEXT_MARGIN_PX);

// ── The cases ────────────────────────────────────────────────────────────────

/** 1. Reading crosses a page and the view keeps up. */
async function acrossPagesCase(page, ttsTexts) {
  console.log(`\n1. reading across pages ${FROM_PAGE} → ${FROM_PAGE + 1}`);
  await page.evaluate(() => document.getElementById('content-area').scrollTo({ top: 0, behavior: 'instant' }));
  const plan = await page.evaluate(({ from, lead, trail }) => {
    const ss = window.kokoro.state.get().sentences;
    const last = ss.findLastIndex((s) => s.page === from);
    const next = ss.findIndex((s) => s.page > from);
    return { start: last - lead, until: next + trail, last };
  }, { from: FROM_PAGE, lead: LEAD_SENTENCES, trail: TRAIL_SENTENCES });
  must('the script has sentences on both sides of the page break', plan.last > LEAD_SENTENCES && plan.until > plan.last,
    JSON.stringify(plan));
  await startSampler(page);
  await playFrom(page, plan.start);
  await page.waitForFunction((want) => window.kokoro.state.get().index >= want, plan.until,
    { timeout: STEP_TIMEOUT_MS + (plan.until - plan.start) * SENTENCE_AUDIO_MS }).catch(() => {});
  const log = await stopSampler(page);
  const now = await reading(page);
  must(`reading got to sentence ${plan.until}`, now.index >= plan.until,
    JSON.stringify({ ...now, audio: await audioState(page), asked: ttsTexts.length }));
  const read = Object.entries(log).map(([i, s]) => ({ i: Number(i), ...s }))
    .filter((s) => s.i >= plan.start && s.i < now.index);
  const pages = [...new Set(read.map((s) => s.page))];
  check(`the sentences read span pages ${pages.join(', ')}`, pages.length >= 2, JSON.stringify(pages));
  const lost = read.filter((s) => !s.inView);
  check(`each of the ${read.length} sentences read was on screen when it ended`, read.length > 0 && lost.length === 0,
    JSON.stringify(lost));
  check('the view moved to follow (it started at the top of page 1)', now.scrollTop > 0, String(now.scrollTop));
  check('following stayed on throughout', await isFollowing(page));
}

/** 2. A wheel over the paper suspends; Follow resumes. */
async function wheelCase(page) {
  console.log('\n2. a wheel over the document suspends following');
  const point = await textPoint(page);
  must('found a spot on the text to wheel over', Boolean(point));
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, WHEEL_PX);
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  check('Follow and its rail twin light up', await isSuspended(page), JSON.stringify(await suspended(page)));
  const held = await reading(page);
  check('the wheel took the sentence off screen', !held.inView, JSON.stringify(held));
  check('the "Follow paused" pill shows', await pillShown(page));
  await sentencesOn(page, WHEEL_HOLD_SENTENCES);
  await page.waitForTimeout(SETTLE_MS);
  const after = await reading(page);
  check(`the view holds still over the next ${WHEEL_HOLD_SENTENCES} sentence`, after.scrollTop === held.scrollTop && !after.inView,
    JSON.stringify({ held: held.scrollTop, after: after.scrollTop, inView: after.inView }));
  await snap(page);
  check('pressing Follow turns following back on', await isFollowing(page), JSON.stringify(await suspended(page)));
  check('… and scrolls back to the sentence', (await reading(page)).inView, JSON.stringify(await reading(page)));
  check('… and the pill goes', !(await pillShown(page)));

  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, WHEEL_PX);
  await page.waitForTimeout(SETTLE_MS);
  must('a second wheel suspends again', await isSuspended(page), JSON.stringify(await suspended(page)));
  await page.waitForTimeout(AUTO_RESUME_MS + SCROLL_SETTLE_MS);
  check(`left alone for ${AUTO_RESUME_MS} ms, following picks up by itself`, await isFollowing(page), JSON.stringify(await suspended(page)));
  check('… brings the sentence back', (await reading(page)).inView, JSON.stringify(await reading(page)));
  check('… and the pill goes', !(await pillShown(page)));
}

const pillShown = (page) => page.evaluate(() => {
  const pill = document.getElementById('follow-pill');
  return Boolean(pill && !pill.hidden && pill.getBoundingClientRect().width > 0);
});

/** 3. A press on the scrollbar suspends; a press on the text does not. */
async function scrollbarCase(page) {
  console.log('\n3. a press on the scrollbar suspends, a press on the text does not');
  const bar = await page.evaluate((px) => {
    const el = document.getElementById('content-area');
    const r = el.getBoundingClientRect();
    const [x, y] = [r.right - px / 2, r.top + r.height / 2];
    return { x, y, target: document.elementFromPoint(x, y) === el };
  }, SCROLLBAR_PX);
  must('the right edge of the document column is the scroller itself', bar.target, JSON.stringify(bar));
  must('following is on before the press', await isFollowing(page), JSON.stringify(await suspended(page)));
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
  check('a press on the scrollbar suspends following', await isSuspended(page), JSON.stringify(await suspended(page)));
  await snap(page);
  must('Follow resumed it', await isFollowing(page));
  const point = await textPoint(page);
  must('found a spot on the text to press', Boolean(point));
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(SETTLE_MS);
  check('a press on the text leaves following on', await isFollowing(page), JSON.stringify(await suspended(page)));
}

/** 4. The readouts strip is not the paper. */
async function statusWheelCase(page) {
  console.log('\n4. a wheel over the view readouts');
  const spot = await page.evaluate(() => {
    const strip = document.getElementById('view-status');
    const r = strip.getBoundingClientRect();
    const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
    return { x, y, inside: strip.contains(document.elementFromPoint(x, y)) };
  });
  must('the middle of #view-status is the strip', spot.inside, JSON.stringify(spot));
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.wheel(0, STATUS_WHEEL_PX);
  await page.waitForTimeout(SETTLE_MS);
  check('it does not suspend following', await isFollowing(page), JSON.stringify(await suspended(page)));
}

/** 5. ⌘+ while reading. */
async function zoomCase(page) {
  console.log('\n5. ⌘+ during playback');
  await snap(page);
  must('the sentence is on screen before the zoom', (await reading(page)).inView);
  for (let i = 0; i < ZOOM_STEPS; i += 1) {
    const before = await page.evaluate(() => window.kokoro.pdfView.scale());
    await page.keyboard.press('Meta+Equal');
    await page.waitForFunction((s) => window.kokoro.pdfView.scale() !== s, before, { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  }
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  const zoom = await page.evaluate(() => window.kokoro.state.get().zoom);
  must('zoomed in', zoom > 1, String(zoom));
  check(`at ${Math.round(zoom * 100)}% the sentence is still on screen`, (await reading(page)).inView, JSON.stringify(await reading(page)));
  await sentencesOn(page);
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  check('… and so is the next one', (await reading(page)).inView, JSON.stringify(await reading(page)));
  check('zooming did not suspend following', await isFollowing(page));
  await page.keyboard.press('Meta+Digit0');
  await page.waitForTimeout(SCROLL_SETTLE_MS);
}

/** 6. A saved place, reopened. */
async function restoreCase(page, docId, ttsTexts) {
  console.log('\n6. reopening at the saved sentence');
  await pause(page);
  await showPage(page, FROM_PAGE);
  // A sentence deeper into its page than one view: scrolling to its page's top would miss it.
  const target = await page.evaluate((n) => {
    const k = window.kokoro;
    const wrap = document.querySelector(`.pdf-page-wrap[data-page="${n}"]`);
    const top = wrap.getBoundingClientRect().top;
    const h = document.getElementById('content-area').clientHeight;
    const depth = new Map([...wrap.querySelectorAll('.textLayer span:not(.markedContent)')]
      .map((el) => [k.pdfView.itemIndexOf(n, el), el.getBoundingClientRect().top - top]));
    const ss = k.state.get().sentences;
    const idx = ss.findIndex((s) => s.page === n && (s.items || []).length
      && Math.min(...s.items.map((i) => depth.get(i) ?? Infinity)) > h);
    return { idx, viewHeight: h };
  }, FROM_PAGE);
  must(`page ${FROM_PAGE} has a sentence more than a view below its top`, target.idx >= 0, JSON.stringify(target));
  await playFrom(page, target.idx);
  await pause(page);
  const saved = await (async () => {
    const deadline = Date.now() + SAVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const rec = await api(`api/notes/${docId}`).catch(() => null);
      if (rec?.last_index === target.idx) return true;
      await page.waitForTimeout(SETTLE_MS);
    }
    return false;
  })();
  must(`pausing saved the place (sentence ${target.idx})`, saved);

  await page.reload();
  await page.waitForFunction(() => Boolean(window.kokoro), null, { timeout: STEP_TIMEOUT_MS });
  const asked = ttsTexts.length;
  await openPaper(page);
  await page.waitForFunction((i) => window.kokoro.state.get().index === i, target.idx, { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  await page.waitForFunction(() => {
    const v = document.getElementById('content-area').getBoundingClientRect();
    const r = document.querySelector('.textLayer .reading')?.getBoundingClientRect();
    return Boolean(r) && r.top >= v.top && r.bottom <= v.bottom;
  }, null, { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  const now = await reading(page);
  check(`it reopens at sentence ${target.idx}`, now.index === target.idx, String(now.index));
  check('that sentence is on screen', now.inView, JSON.stringify(now));
  const pageTop = await page.evaluate((n) => document.querySelector(`.pdf-page-wrap[data-page="${n}"]`).getBoundingClientRect().top
    - document.getElementById('content-area').getBoundingClientRect().top, FROM_PAGE);
  check('… scrolled past its page\'s top, not just to it', pageTop < 0, String(pageTop));
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  const state = await page.evaluate(() => ({ ...window.kokoro.player.state(), paused: document.querySelector('audio')?.paused ?? true }));
  check('no audio starts', !state.isPlaying && !state.isLoading && state.paused, JSON.stringify(state));
  check('… and none is asked for', ttsTexts.length === asked, ttsTexts.slice(asked).join(' | '));
}

/** An empty spot in the notes column beside the paper, clear of every note. */
const emptyColumnSpot = (page) => page.evaluate(({ step, margin }) => {
  const col = document.getElementById('notes-column').getBoundingClientRect();
  const x = col.left + col.width / 2;
  for (let y = col.top + margin; y < col.bottom - margin; y += step) {
    const el = document.elementFromPoint(x, y);
    // R3: the Highlights section heads the column; empty space there is not the notes'.
    if (el && el.closest('#notes-column .ne-panel') && !el.closest('.ne-note, .ne-head')) return { x, y };
  }
  return null;
}, { step: COLUMN_SCAN_STEP_PX, margin: TEXT_MARGIN_PX });

const caretRow = (page) => page.evaluate(() => {
  const el = document.activeElement;
  const inNotes = Boolean(el?.closest?.('#notes-column .ne-text'));
  return { inNotes, text: inNotes ? el.textContent : '', top: inNotes ? el.getBoundingClientRect().top : null };
});

/** 7. Writing in the margin holds the paper still. */
async function writingCase(page) {
  console.log('\n7. typing in a margin note holds the paper still');
  must('the notes are in the margin view', (await page.evaluate(() => window.kokoro.state.get().notesView)) === 'margin');
  const start = (await reading(page)).index;
  await playFrom(page, start);
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  const spot = await emptyColumnSpot(page);
  must('found empty space in the notes column', Boolean(spot));
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(SETTLE_MS);
  must('the click put the caret in a note', (await caretRow(page)).inNotes);
  await page.keyboard.type(NOTE_TEXT[0]);
  // Put the sentence at the bottom edge, so the next ones are below the view: following must move.
  await page.evaluate((edge) => {
    const view = document.getElementById('content-area');
    const r = document.querySelector('.textLayer .reading').getBoundingClientRect();
    view.scrollTo({ top: view.scrollTop + r.bottom - (view.getBoundingClientRect().bottom - edge), behavior: 'instant' });
  }, EDGE_PX);
  await page.waitForTimeout(SETTLE_MS);
  const before = { ...(await reading(page)), row: await caretRow(page) };
  const until = before.index + HOLD_SENTENCES;
  let typed = 1;
  while ((await reading(page)).index < until && typed < MAX_TYPED) {
    await page.keyboard.type(NOTE_TEXT[typed % NOTE_TEXT.length], { delay: TYPE_DELAY_MS });
    typed += 1;
  }
  const after = { ...(await reading(page)), row: await caretRow(page) };
  must(`reading moved ${HOLD_SENTENCES} sentences on while typing`, after.index >= until, JSON.stringify({ before: before.index, after: after.index }));
  check('the sentence now being read is off screen (following would have had to move)', !after.inView, JSON.stringify(after));
  check('the paper did not scroll', after.scrollTop === before.scrollTop, JSON.stringify({ before: before.scrollTop, after: after.scrollTop }));
  check('the row being typed in did not move', after.row.inNotes && Math.abs(after.row.top - before.row.top) <= ROW_STILL_PX,
    JSON.stringify({ before: before.row, after: after.row }));
  check('every character landed in it', after.row.text.length === typed, JSON.stringify({ text: after.row.text, typed }));
  check('following was held, not suspended', await isFollowing(page));

  const point = await textPoint(page);
  must('found a spot on the text to click', Boolean(point));
  await page.mouse.click(point.x, point.y);
  await sentencesOn(page);
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  check('once the caret leaves the note, following catches up', (await reading(page)).inView, JSON.stringify(await reading(page)));
}

/**
 * The scroll positions one follow scroll passes through, from a view scrolled away from the
 * sentence. The trace listens before the view is sent to the top, since an instant follow scroll
 * can bring it back within a frame, and records only once that reset has landed: its own scroll
 * event is not a follow step.
 */
async function followTrace(page) {
  await page.evaluate(() => {
    const view = document.getElementById('content-area');
    window.__scrollTrace = { reset: false, steps: [] };
    view.addEventListener('scroll', () => {
      // A repeat event at the reset position is not a step of the follow scroll.
      if (window.__scrollTrace.reset) { if (view.scrollTop !== 0) window.__scrollTrace.steps.push(view.scrollTop); }
      else window.__scrollTrace.reset = view.scrollTop === 0;
    });
    view.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForFunction(() => window.__scrollTrace.reset, null, { timeout: STEP_TIMEOUT_MS });
  await sentencesOn(page);
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  return { trace: await page.evaluate(() => window.__scrollTrace.steps), now: await reading(page) };
}

/** 8a. Without reduced motion a follow scroll animates: the control for 8b. */
async function smoothCase(page) {
  console.log('\n8. reduced motion');
  const start = (await reading(page)).index;
  await playFrom(page, start + 1);
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  const { trace, now } = await followTrace(page);
  check(`without it, a follow scroll animates (${new Set(trace).size} steps)`, new Set(trace).size > 1 && now.inView,
    JSON.stringify({ trace: trace.length, inView: now.inView }));
  await pause(page);
}

/**
 * 8b. Under reducedMotion 'reduce' a follow scroll still animates, since Smooth scrolling is the
 * reader's own pref (on by default); unchecking it makes the next one land in one step.
 */
async function reducedCase(browser, setup, errors) {
  const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
  try {
    const page = await setup(context, errors);
    await page.goto(BASE_URL);
    await openPaper(page);
    const start = (await reading(page)).index;
    await playFrom(page, start + 1);
    await page.waitForTimeout(SCROLL_SETTLE_MS);
    const smooth = await followTrace(page);
    check(`with it, Smooth scrolling on still animates (${new Set(smooth.trace).size} steps)`,
      new Set(smooth.trace).size > 1 && smooth.now.inView, JSON.stringify({ trace: smooth.trace.length, inView: smooth.now.inView }));
    await page.click('.tab[data-tab="settings"]');   // R7: Scrolling lives in Settings
    await page.evaluate(() => { document.getElementById('scroll-options').open = true; });
    await page.uncheck('#smoothScrollBox');
    await page.click('.tab[data-tab="read"]');
    const { trace, now } = await followTrace(page);
    check(`... and Smooth scrolling off lands in one step (${new Set(trace).size})`, new Set(trace).size === 1 && now.inView,
      JSON.stringify({ trace, inView: now.inView }));
    await pause(page);
  } finally {
    await context.close();
  }
}

const scrollTop = (page) => page.evaluate(() => document.getElementById('content-area').scrollTop);
const switchedOn = async (page) => (await page.getAttribute('#followBtn', 'aria-checked')) === 'true';

/** 9. The follow switch off: reading moves on, the view does not. */
async function followOffCase(page) {
  console.log('\n9. follow switch');
  await page.click('#followBtn');
  must('the switch reads off', !(await switchedOn(page)));
  await page.evaluate(() => document.getElementById('content-area').scrollTo({ top: 0, behavior: 'instant' }));
  const before = await scrollTop(page);
  const start = (await reading(page)).index;
  await playFrom(page, start + 1);
  await sentencesOn(page, HOLD_SENTENCES);
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  const after = await scrollTop(page);
  check(`off: playing leaves the view still (${before} -> ${after})`, Math.abs(after - before) < ROW_STILL_PX);
  check('off: Follow is not lit', await isFollowing(page), JSON.stringify(await suspended(page)));
  await page.click('#followBtn');
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  const now = await reading(page);
  check('on again: the sentence being read is in view', (await switchedOn(page)) && now.inView, JSON.stringify(now));
  await pause(page);
}

/** 10. Half a laptop screen: both panels fold on screen only, and the paper takes the width. */
async function narrowCase(browser, setup, errors) {
  console.log('\n10. narrow window');
  const context = await browser.newContext({ viewport: NARROW_VIEWPORT });
  try {
    const page = await setup(context, errors);
    await page.goto(BASE_URL);
    await openPaper(page);
    const layout = () => page.evaluate(() => ({
      sidebar: document.body.classList.contains('sidebar-collapsed'),
      notes: document.body.classList.contains('notes-collapsed'),
      rail: !document.getElementById('rail').inert && document.getElementById('rail').getBoundingClientRect().width > 0,
      column: document.getElementById('content-area').getBoundingClientRect().width,
      paper: document.querySelector('.pdf-page-wrap').getBoundingClientRect().width,
    }));
    const narrow = await layout();
    check('the sidebar is on its rail and the notes are folded', narrow.sidebar && narrow.notes && narrow.rail, JSON.stringify(narrow));
    check(`the paper is wider than ${MIN_PAPER_PX}px (${Math.round(narrow.paper)})`, narrow.paper > MIN_PAPER_PX);
    check(`the reading column has most of the window (${Math.round(narrow.column)})`,
      narrow.column >= NARROW_VIEWPORT.width * MIN_PAPER_SHARE);
    await page.setViewportSize(VIEWPORT);
    await page.waitForTimeout(SETTLE_MS);
    const wide = await layout();
    check('widened: the saved layout (both open) is back', !wide.sidebar && !wide.notes, JSON.stringify(wide));
  } finally {
    await context.close();
  }
}

async function run() {
  const docId = createHash('sha1').update(readFileSync(PDF)).digest('hex');
  const { docs } = await api('api/notes');
  if ((docs || []).some((d) => d.doc_id === docId)) {
    throw new Error('the server already holds a notes record for this paper; run it against a scratch KOKORO_DATA_DIR');
  }

  const { chromium, webkit } = await loadPlaywright();
  const engine = ENGINE === 'webkit' ? webkit : chromium;
  const browser = await engine.launch(process.env.CHROMIUM_PATH && engine === chromium
    ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  const ttsTexts = [];
  const wav = silentWav(SENTENCE_AUDIO_MS);
  const css = EMULATE_PYWEBVIEW ? pywebviewNoSelectCss() : null;
  const setup = async (context) => {
    if (css) {
      await context.addInitScript((rule) => addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = rule;
        document.head.appendChild(style);
      }), css);
    }
    await context.route('**/api/tts?**', (route) => {
      ttsTexts.push(new URL(route.request().url()).searchParams.get('text'));
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      const favicon = /\/favicon\.ico$/.test(msg.location().url || '');
      if (msg.type() === 'error' && !favicon) errors.push(`console: ${msg.text()}`);
    });
    return page;
  };
  try {
    console.log(`${ENGINE} · ${BASE_URL} · pywebview CSS ${EMULATE_PYWEBVIEW ? 'on' : 'off'} · tts stubbed (${SENTENCE_AUDIO_MS} ms of silence)`);
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await setup(context);
    await page.goto(BASE_URL);
    await openPaper(page);
    await acrossPagesCase(page, ttsTexts);
    await wheelCase(page);
    await scrollbarCase(page);
    await statusWheelCase(page);
    await zoomCase(page);
    await restoreCase(page, docId, ttsTexts);
    await writingCase(page);
    await smoothCase(page);
    await followOffCase(page);
    await context.close();
    await reducedCase(browser, setup, errors);
    await narrowCase(browser, setup, errors);
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

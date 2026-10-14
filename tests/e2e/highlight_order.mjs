// Real-browser check for U33: the highlights follow reading order — page, then line top to
// bottom, then left to right — not the order they were made in. Tab walks them in that order,
// deleting the focused one moves the focus to the next in that order (else the one before), and
// a click where two overlap opens the one painted on top: the later in reading order.
//
// Every case makes its highlights out of reading order, so creation order would fail it:
//   1. low on page 1, high on page 1, then page 2: Tab from the status bar visits high, low, page 2.
//   2. two on one line, right made first: Tab visits the left one first.
//   3. the middle one deleted from its popover (Delete, then Delete to confirm): the focus lands
//      on the next in reading order, and Space opens it.
//   4. the last in reading order deleted: the focus goes to the one before it.
//   5. a click inside two overlapping highlights opens the later one in reading order.
//   6. plain Tab reaches a highlight rect at all (WebKit included).
// The keyboard drives the delete, as a keyboard reader would: a click on the popover's button
// would move the focus off the rect, and only a focused highlight hands its focus on.
//
// Run: tests/e2e/run.sh <repo-dir> <chromium|webkit> highlight_order <port> [log-dir]
// Env: as notes_highlight.mjs (KOKORO_URL, PLAYWRIGHT_DIR, CHROMIUM_PATH, BROWSER, KOKORO_E2E_PDF,
// EMULATE_PYWEBVIEW). The paper must have no notes record on that server: the check refuses to
// touch an existing one, and deletes the record it created when it ends. Exit 0 = pass, 1 = fail.

import { api, check, docIdOf, finish, launch, must, requireEnv } from './lib/harness.mjs';
import { DRAG_STEPS, SETTLE_MS, STEP_TIMEOUT_MS, openPaper } from './lib/editor.mjs';

const PDF = requireEnv('KOKORO_E2E_PDF', 'Point it at the PDF this check should drive.');
const HL_COLOR = 'green';
const MIN_SPAN_CHARS = 30;
const MIN_SPAN_WIDTH_PX = 200;
const VIEW_MARGIN_PX = 120;
const MAX_TABS = 40;          // far more stops than the status bar and a few highlights hold
const SAME_LINE_PX = 4;       // tops this close are one text line
// Where on a line each highlight runs, as fractions of the line's width.
const HIGH_LINE = 1;          // page 1's line index for the higher highlight; line 0 stays free for case 4
const LOW_LINE = 3;
const WHOLE = [0.05, 0.95];
const RIGHT = [0.6, 0.95];
const LEFT = [0.05, 0.4];
const ON_TOP = [0.5, 0.9];    // made first, but later in reading order: it paints on top
const BENEATH = [0.1, 0.7];
const OVERLAP_AT = 0.6;       // inside both ON_TOP and BENEATH

const focusedId = (page) => page.evaluate(() => document.activeElement?.closest?.('.hl-rect')?.dataset.hlId ?? null);
const activeIds = (page) => page.$$eval('.hl-rect.is-active', (els) => [...new Set(els.map((el) => el.dataset.hlId))]);
const popoverOpen = async (page) => Boolean(await page.$('.hl-popover.is-open'));
const allIds = (page) => page.$$eval('.hl-rect', (els) => [...new Set(els.map((el) => el.dataset.hlId))]);

/** One highlight's drawn rects, in viewport pixels. */
const rectsOf = (page, id) => page.$$eval(`.hl-rect[data-hl-id="${id}"]`, (els) => els.map((el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}));

const covers = (rects, x, y) => rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);

/** Scroll page `n` into view and return its long text lines in view, one span per line, top first. */
async function textLines(page, n) {
  await page.evaluate((n) => document.querySelector(`.pdf-page-wrap[data-page="${n}"]`).scrollIntoView({ block: 'start' }), n);
  await page.waitForFunction((n) => document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`).length > 0,
    n, { timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
  return page.evaluate(({ n, minChars, minWidth, margin, sameLine }) => {
    const spans = [...document.querySelectorAll(`.pdf-page-wrap[data-page="${n}"] .textLayer > span`)]
      .map((s) => ({ text: s.textContent, r: s.getBoundingClientRect() }))
      .filter(({ text, r }) => text.trim().length >= minChars && r.width >= minWidth
        && r.top > margin && r.bottom < innerHeight - margin)
      .sort((a, b) => a.r.top - b.r.top);
    const lines = spans.filter((s, i) => spans.slice(0, i).every((t) => Math.abs(t.r.top - s.r.top) > sameLine));
    return lines.map(({ r }) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
  }, { n, minChars: MIN_SPAN_CHARS, minWidth: MIN_SPAN_WIDTH_PX, margin: VIEW_MARGIN_PX, sameLine: SAME_LINE_PX });
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

const pointOn = (line, fraction) => ({ x: line.left + line.width * fraction, y: line.top + line.height / 2 });

/** Highlight the `[from, to]` stretch of `line` and return the new highlight's id. */
async function mark(page, name, line, [from, to]) {
  await page.keyboard.press('Escape');
  await page.evaluate(() => getSelection().removeAllRanges());
  const before = await allIds(page);
  await drag(page, pointOn(line, from), pointOn(line, to));
  must(`${name}: the drag selects text`, (await page.evaluate(() => getSelection().toString())).trim().length > 0);
  must(`${name}: the highlight toolbar opens`, Boolean(await page.$('.hl-toolbar.is-open')));
  await page.click(`.hl-toolbar.is-open .hl-swatch[data-color="${HL_COLOR}"]`);
  await page.waitForTimeout(SETTLE_MS);
  const made = (await allIds(page)).filter((id) => !before.includes(id));
  must(`${name}: one new highlight drawn`, made.length === 1, `new ids ${JSON.stringify(made)}`);
  return made[0];
}

/** Press Tab from `startSelector` until `want` highlights have taken the focus; their ids, in order. */
async function tabWalk(page, startSelector, want) {
  await page.keyboard.press('Escape');
  await page.focus(startSelector);
  const seen = [];
  for (let i = 0; i < MAX_TABS && seen.length < want; i += 1) {
    await page.keyboard.press('Tab');
    const id = await focusedId(page);
    if (id && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

/** Focus highlight `id`'s rect, open it with Space, then Delete and Delete again to confirm. */
async function deleteByKeyboard(page, name, id) {
  await page.keyboard.press('Escape');
  await page.focus(`.hl-rect[data-hl-id="${id}"][tabindex="0"]`);
  must(`${name}: its rect holds the focus`, (await focusedId(page)) === id);
  await page.keyboard.press('Space');
  must(`${name}: Space opens its popover`, (await popoverOpen(page)) && (await activeIds(page)).join() === id,
    `active ${JSON.stringify(await activeIds(page))}`);
  await page.keyboard.press('Delete');
  must(`${name}: the first Delete arms the button`, Boolean(await page.$('.hl-popover.is-open .hl-del.is-confirming')));
  await page.keyboard.press('Delete');
  await page.waitForTimeout(SETTLE_MS);
  must(`${name}: the second Delete removes it`, !(await allIds(page)).includes(id));
}

/** After a delete: the focus is on `want`'s rect, and Space opens that one. */
async function focusLandsOn(page, name, want, label) {
  const got = await focusedId(page);
  check(`${name}: the focus lands on ${label}`, got === want, `focus on ${got}, want ${want}`);
  if (got !== want) return;
  await page.keyboard.press('Space');
  check(`${name}: Space opens ${label}`, (await popoverOpen(page)) && (await activeIds(page)).join() === want,
    `active ${JSON.stringify(await activeIds(page))}`);
  await page.keyboard.press('Escape');
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
    const first = await textLines(page, 1);
    must('page 1 has 4 long lines in view', first.length > LOW_LINE, `got ${first.length}`);

    console.log('\n1. Tab walks page 1 top to bottom, then page 2');
    const low = await mark(page, 'low on page 1', first[LOW_LINE], WHOLE);
    const high = await mark(page, 'high on page 1', (await textLines(page, 1))[HIGH_LINE], WHOLE);
    const second = await textLines(page, 2);
    must('page 2 has a long line in view', second.length > 0);
    const next = await mark(page, 'page 2', second[0], WHOLE);
    const walk = await tabWalk(page, '#notesToggleBtn', 3);
    console.log('\n6. Tab reaches a highlight');
    must('plain Tab from the status bar reaches a highlight rect', walk.length > 0);
    check('Tab visits high, low, then page 2', walk.join() === [high, low, next].join(),
      JSON.stringify({ walk, want: [high, low, next] }));

    console.log('\n3. deleting the middle one moves the focus to the next in reading order');
    await deleteByKeyboard(page, 'middle', low);
    await focusLandsOn(page, 'middle', next, 'the page 2 one');

    console.log('\n4. deleting the last one moves the focus to the one before');
    const top = await mark(page, 'top of page 1', (await textLines(page, 1))[0], WHOLE);
    await deleteByKeyboard(page, 'last', next);
    await focusLandsOn(page, 'last', high, 'the high one on page 1');
    check('the top one made last is still there', (await allIds(page)).includes(top));

    console.log('\n2. two on one line: Tab visits the left one first');
    const third = await textLines(page, 3);
    must('page 3 has 2 long lines in view', third.length > 1, `got ${third.length}`);
    const right = await mark(page, 'right half', third[0], RIGHT);
    const left = await mark(page, 'left half', (await textLines(page, 3))[0], LEFT);
    const [r, l] = [(await rectsOf(page, right))[0], (await rectsOf(page, left))[0]];
    must('both sit on one line, the left one to the left', Math.abs(r.top - l.top) <= SAME_LINE_PX && l.right <= r.left,
      JSON.stringify({ r, l }));
    // Only the pair's own order counts here: page 1's order is case 1's to check.
    const all = await tabWalk(page, '#notesToggleBtn', [top, high, left, right].length);
    check('Tab visits left, then right', all.includes(left) && all.indexOf(left) < all.indexOf(right),
      JSON.stringify({ all, left, right }));

    console.log('\n5. a click where two overlap opens the one on top');
    const line = (await textLines(page, 3))[1];
    const onTop = await mark(page, 'made first, starts right', line, ON_TOP);
    const beneath = await mark(page, 'made second, starts left', (await textLines(page, 3))[1], BENEATH);
    await page.keyboard.press('Escape');
    const at = pointOn((await textLines(page, 3))[1], OVERLAP_AT);
    must('the click point is inside both', covers(await rectsOf(page, onTop), at.x, at.y)
      && covers(await rectsOf(page, beneath), at.x, at.y), JSON.stringify(at));
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(SETTLE_MS);
    must('the click opens a popover', await popoverOpen(page));
    check('it opens the later one in reading order', (await activeIds(page)).join() === onTop,
      JSON.stringify({ active: await activeIds(page), onTop, beneath }));
    check('no console errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await api(`api/notes/${docId}`, { method: 'DELETE' }).catch((err) => console.warn(`cleanup failed: ${err.message}`));
  }
}

await finish(run);

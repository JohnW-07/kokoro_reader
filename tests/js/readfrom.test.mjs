/* Harness for static/js/readfrom.js (span → sentence) and readmenu.js's pure placement helpers. */
import assert from 'node:assert/strict';
import { resolveReadFrom, MATCH } from '../../static/js/readfrom.js';
import { placeMenu, nearestSpanIndex } from '../../static/js/readmenu.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const s = (page, items, text = '') => ({ page, items, text });

// Page 1: title (0), body (2–4). Page 2: body split across items, a figure caption at 20–21
// is skipped (not in the script), a sentence sharing item 12 with its neighbour, footer 40.
// Page 3: one sentence. Page 4 is in the PDF but not in the script.
const SCRIPT = Object.freeze([
  s(1, [0]),            // 0
  s(1, [2, 3, 4]),      // 1
  s(2, [10, 11, 12]),   // 2
  s(2, [12, 13]),       // 3  shares item 12 with 2
  s(2, [22, 23, 24]),   // 4  follows the skipped caption at 20–21
  s(3, [0, 1]),         // 5
]);

console.log('\n[1] resolveReadFrom');

test('exact hit: the clicked item is in a sentence', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 1, item: 0 }), { index: 0, match: MATCH.EXACT });
});

test('a span in the middle of a multi-item sentence resolves to that sentence', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 2, item: 11 }), { index: 2, match: MATCH.EXACT });
});

test('a span shared by two adjacent sentences picks the first', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 2, item: 12 }), { index: 2, match: MATCH.EXACT });
});

test('a skipped span (caption) starts at the next spoken sentence on the page', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 2, item: 20 }), { index: 4, match: MATCH.FOLLOWING });
});

test('the same-page choice is the nearest following item, not the first sentence on the page', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 1, item: 1 }), { index: 1, match: MATCH.FOLLOWING });
});

test('a skipped span after the last sentence on its page moves to the next page', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 2, item: 40 }), { index: 5, match: MATCH.FOLLOWING });
});

test('a skipped span on a page with no sentences moves to the next page that has one', () => {
  const gap = [s(1, [0]), s(4, [5])];
  assert.deepEqual(resolveReadFrom(gap, { page: 2, item: 3 }), { index: 1, match: MATCH.FOLLOWING });
});

test('the later-page fallback picks the first sentence of the nearest later page', () => {
  const later = [s(1, [0]), s(3, [0]), s(3, [4]), s(5, [1]), s(5, [2])];
  assert.deepEqual(resolveReadFrom(later, { page: 2, item: 0 }), { index: 1, match: MATCH.FOLLOWING });
});

test('the last page with nothing following resolves to none', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 3, item: 9 }), { index: -1, match: MATCH.NONE });
});

test('a page the loaded script does not reach (still building) resolves to none', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 4, item: 0 }), { index: -1, match: MATCH.NONE });
  assert.deepEqual(resolveReadFrom([], { page: 1, item: 0 }), { index: -1, match: MATCH.NONE });
});

test('no item (a click tied to no span) starts at the first sentence on that page', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 2, item: null }), { index: 2, match: MATCH.FOLLOWING });
});

test('invalid targets and sentences without items never throw', () => {
  assert.deepEqual(resolveReadFrom(SCRIPT, null), { index: -1, match: MATCH.NONE });
  assert.deepEqual(resolveReadFrom(SCRIPT, { page: 0, item: 1 }), { index: -1, match: MATCH.NONE });
  assert.deepEqual(resolveReadFrom(null, { page: 1, item: 1 }), { index: -1, match: MATCH.NONE });
  const bare = [{ page: 1, text: 'fallback' }, s(1, [7])];
  assert.deepEqual(resolveReadFrom(bare, { page: 1, item: 3 }), { index: 1, match: MATCH.FOLLOWING });
});

test('the script is not mutated', () => {
  const before = JSON.stringify(SCRIPT);
  const list = SCRIPT.map((x) => ({ ...x, items: [...x.items] }));
  resolveReadFrom(list, { page: 2, item: 20 });
  assert.equal(JSON.stringify(list), before);
});

console.log('\n[1b] a sentence over a page turn (N4) is read from either part');

// Page 17: one sentence, then one whose tail runs onto page 18 under a running head
// (items 0–1, skipped). Page 18 then carries on with a sentence of its own.
const TURN = Object.freeze([
  s(17, [0, 1]),                                                               // 0
  { page: 17, items: [5, 6], spans: [{ page: 17, items: [5, 6] }, { page: 18, items: [3, 4] }] },  // 1
  s(18, [5, 6]),                                                               // 2
]);

test('a click on the second page\'s part resolves to the sentence that started on the first', () => {
  assert.deepEqual(resolveReadFrom(TURN, { page: 18, item: 4 }), { index: 1, match: MATCH.EXACT });
  assert.deepEqual(resolveReadFrom(TURN, { page: 17, item: 6 }), { index: 1, match: MATCH.EXACT });
});

test('a skipped span above the part reads from the part, not the next sentence', () => {
  assert.deepEqual(resolveReadFrom(TURN, { page: 18, item: 1 }), { index: 1, match: MATCH.FOLLOWING });
});

test('a click tied to no span starts at the first sentence with a part on that page', () => {
  assert.deepEqual(resolveReadFrom(TURN, { page: 18, item: null }), { index: 1, match: MATCH.FOLLOWING });
});

test('items of the start page do not match on the next page', () => {
  assert.deepEqual(resolveReadFrom(TURN, { page: 18, item: 6 }), { index: 2, match: MATCH.EXACT });
});

console.log('\n[2] placeMenu');

const VIEW = { width: 1000, height: 800 };
const SIZE = { width: 160, height: 40 };

test('opens down-right of the pointer, growing from its top-left corner', () => {
  assert.deepEqual(placeMenu({ x: 100, y: 100 }, SIZE, VIEW), { left: 100, top: 100, origin: 'left top' });
});

test('flips left and up near the bottom-right edge', () => {
  assert.deepEqual(placeMenu({ x: 990, y: 790 }, SIZE, VIEW), { left: 830, top: 750, origin: 'right bottom' });
});

test('moves clear of the selection toolbar when they would overlap', () => {
  const toolbar = { left: 60, top: 110, width: 300, height: 30 };
  const spot = placeMenu({ x: 100, y: 100 }, SIZE, VIEW, toolbar);
  assert.ok(spot.top >= toolbar.top + toolbar.height, JSON.stringify(spot));
});

console.log('\n[3] nearestSpanIndex');

test('a click in a figure picks the next span below it in the same column', () => {
  const rects = [
    { left: 50, top: 100, width: 400, height: 10 },   // body above the figure
    { left: 550, top: 350, width: 400, height: 10 },  // other column, nearer in y
    { left: 50, top: 500, width: 400, height: 10 },   // caption below the figure
  ];
  assert.equal(nearestSpanIndex(rects, { x: 200, y: 300 }), 2);
});

test('with nothing below in the column, the nearest span wins; no spans gives -1', () => {
  const rects = [{ left: 50, top: 100, width: 400, height: 10 }, { left: 600, top: 90, width: 50, height: 10 }];
  assert.equal(nearestSpanIndex(rects, { x: 500, y: 300 }), 0);
  assert.equal(nearestSpanIndex([], { x: 1, y: 1 }), -1);
});

console.log(`\nALL GREEN — ${passed} tests passed\n`);

/* Throwaway harness for static/js/highlights.js + static/js/notes.js pure helpers. */
import assert from 'node:assert/strict';
import {
  toBox, normalizeRect, denormalizeRect, mergeLineRects, groupRectsByPage, createHighlightsFromGroups,
} from '../../static/js/highlights.js';
import { matchesFilter, groupByPage, toMarkdown } from '../../static/js/notes.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const rect = (left, top, width, height) => ({ left, top, width, height });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('\n[1] rect normalisation + round-trip');

test('a client rect inside a known page box normalises to the expected 0..1 values', () => {
  const box = rect(100, 50, 600, 800);
  const n = normalizeRect(rect(250, 130, 300, 16), box);
  assert.deepEqual(n, { x: 0.25, y: 0.1, w: 0.5, h: 0.02 });
});

test('the normalised rect round-trips back to the same pixels', () => {
  const box = rect(100, 50, 600, 800);
  const original = rect(250, 130, 300, 16);
  const back = denormalizeRect(normalizeRect(original, box), box);
  for (const key of ['left', 'top', 'width', 'height']) {
    assert.ok(near(back[key], original[key]), `${key}: ${back[key]} != ${original[key]}`);
  }
});

test('round-trip survives a zoom of the page box (rects are scale-free)', () => {
  const small = rect(100, 50, 600, 800);
  const zoomed = rect(20, 10, 1200, 1600); // same page, 2x, scrolled
  const n = normalizeRect(rect(250, 130, 300, 16), small);
  const drawn = denormalizeRect(n, zoomed);
  assert.deepEqual(drawn, { left: 20 + 0.25 * 1200, top: 10 + 0.1 * 1600, width: 600, height: 32 });
});

test('a rect outside the page box clamps into 0..1 instead of exploding', () => {
  const n = normalizeRect(rect(-500, -500, 5000, 5000), rect(0, 0, 600, 800));
  assert.deepEqual(n, { x: 0, y: 0, w: 1, h: 1 });
});

test('a degenerate page box yields null, not NaN', () => {
  assert.equal(normalizeRect(rect(0, 0, 10, 10), rect(0, 0, 0, 0)), null);
});

test("pdfview's origin-less pageRect {width,height} is rejected, forcing the wrap fallback", () => {
  assert.equal(toBox({ width: 612, height: 792 }), null);        // what pdfview.js returns today
  assert.deepEqual(toBox({ x: 8, y: 4, width: 612, height: 792 }), // a future pageRect with an origin
    { left: 8, top: 4, width: 612, height: 792 });
  assert.deepEqual(toBox({ left: 8, top: 4, right: 620, bottom: 796 }),
    { left: 8, top: 4, width: 612, height: 792 });
});

console.log('\n[2] same-line rect merging');

const line1 = [
  { x: 0.10, y: 0.20, w: 0.10, h: 0.02 },
  { x: 0.205, y: 0.20, w: 0.10, h: 0.02 }, // 0.005 gap -> abuts
  { x: 0.31, y: 0.20, w: 0.05, h: 0.02 },  // 0.005 gap -> abuts
];
const line2 = [{ x: 0.10, y: 0.25, w: 0.20, h: 0.02 }];

test('three rects on one line merge to one bar', () => {
  const merged = mergeLineRects(line1);
  assert.equal(merged.length, 1);
  assert.ok(near(merged[0].x, 0.10) && near(merged[0].w, 0.26), JSON.stringify(merged[0]));
});

test('rects on two lines stay two', () => {
  const merged = mergeLineRects([...line2, ...line1]);
  assert.equal(merged.length, 2);
  assert.ok(merged[0].y < merged[1].y, 'reading order preserved');
});

test('a column gutter on the same line is NOT merged', () => {
  const merged = mergeLineRects([
    { x: 0.08, y: 0.20, w: 0.35, h: 0.02 },
    { x: 0.55, y: 0.20, w: 0.35, h: 0.02 }, // 0.12 gutter > MERGE_GAP
  ]);
  assert.equal(merged.length, 2);
});

test('merging does not mutate its input array', () => {
  const input = line1.map((r) => ({ ...r }));
  const snapshot = JSON.stringify(input);
  mergeLineRects(input);
  assert.equal(JSON.stringify(input), snapshot);
});

console.log('\n[3] grouping a cross-page selection');

const PAGE_1 = rect(100, 0, 600, 800);
const PAGE_2 = rect(100, 820, 600, 800);
const pageBoxes = [{ page: 1, box: PAGE_1 }, { page: 2, box: PAGE_2 }];

test('client rects split across two page boxes by centre point', () => {
  const byPage = groupRectsByPage(
    [rect(150, 700, 400, 16), rect(150, 730, 300, 16), rect(150, 830, 400, 16)],
    pageBoxes,
  );
  assert.deepEqual([...byPage.keys()], [1, 2]);
  assert.equal(byPage.get(1).length, 2);
  assert.equal(byPage.get(2).length, 1);
  assert.ok(near(byPage.get(2)[0].y, 10 / 800), 'page-2 rect is relative to page 2');
});

test('a rect on no page is dropped rather than mis-assigned', () => {
  assert.equal(groupRectsByPage([rect(150, 805, 400, 6)], pageBoxes).size, 0);
});

test('a selection spanning two pages produces two highlights sharing a group id', () => {
  const byPage = groupRectsByPage([rect(150, 700, 400, 16), rect(150, 830, 400, 16)], pageBoxes);
  const groups = [...byPage.entries()].map(([page, rects]) => ({
    page, rects: mergeLineRects(rects), text: `text on page ${page}`,
  }));
  let counter = 0;
  const made = createHighlightsFromGroups(groups, 'green', {
    id: () => `id-${counter++}`,
    now: () => '2026-09-10T00:00:00.000Z',
  });
  assert.equal(made.length, 2);
  assert.equal(made[0].group, made[1].group);
  assert.notEqual(made[0].id, made[1].id);
  assert.deepEqual(made.map((h) => h.page), [1, 2]);
  assert.deepEqual(made.map((h) => h.color), ['green', 'green']);
  assert.equal(made[0].created_at, '2026-09-10T00:00:00.000Z');
  assert.equal(made[0].note, '');
});

console.log('\n[4] notes panel filter/search predicate');

const HL = (over = {}) => ({
  id: 'a', page: 1, color: 'yellow', text: 'Gradient descent converges', note: '',
  rects: [], created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-10T10:00:00Z', ...over,
});

test('search matches on the highlighted text', () => {
  assert.equal(matchesFilter(HL(), { query: 'gradient' }), true);
  assert.equal(matchesFilter(HL(), { query: 'CONVERGES' }), true);
});

test('search matches on the note as well as the text', () => {
  const withNote = HL({ text: 'see Theorem 2', note: 'compare with Adam optimiser' });
  assert.equal(matchesFilter(withNote, { query: 'adam' }), true);
  assert.equal(matchesFilter(withNote, { query: 'theorem' }), true);
  assert.equal(matchesFilter(withNote, { query: 'sgd' }), false);
});

test('colour chips and "notes only" compose with the query', () => {
  const noted = HL({ color: 'blue', note: 'key claim' });
  assert.equal(matchesFilter(noted, { colors: ['blue'] }), true);
  assert.equal(matchesFilter(noted, { colors: ['pink'] }), false);
  assert.equal(matchesFilter(noted, { notesOnly: true }), true);
  assert.equal(matchesFilter(HL(), { notesOnly: true }), false);
  assert.equal(matchesFilter(noted, { colors: ['blue'], notesOnly: true, query: 'claim' }), true);
  assert.equal(matchesFilter(noted, { colors: ['blue'], notesOnly: true, query: 'nope' }), false);
});

test('an empty filter matches everything', () => {
  assert.equal(matchesFilter(HL(), {}), true);
  assert.equal(matchesFilter(HL(), { colors: [], query: '   ' }), true);
});

console.log('\n[5] grouping + markdown export');

const CORPUS = [
  HL({ id: 'c', page: 3, text: 'third', created_at: '2026-09-10T12:00:00Z', color: 'pink' }),
  HL({ id: 'a', page: 1, text: 'first', note: 'a note', created_at: '2026-09-10T10:00:00Z' }),
  HL({ id: 'b', page: 3, text: 'second', created_at: '2026-09-10T11:00:00Z', color: 'blue' }),
];

test('groupByPage sorts pages ascending and rows newest-first within a page', () => {
  const grouped = groupByPage(CORPUS);
  assert.deepEqual(grouped.map((g) => g.page), [1, 3]);
  assert.deepEqual(grouped[1].items.map((h) => h.id), ['c', 'b']);
});

test('markdown export groups by page in page order', () => {
  const md = toMarkdown(CORPUS, { title: 'My Paper' });
  assert.equal(md.indexOf('## Page 1') < md.indexOf('## Page 3'), true);
  assert.equal(md.startsWith('# My Paper\n'), true);
  assert.ok(md.includes('> first'), md);
  assert.ok(md.includes('*a note*'), md);
  assert.ok(md.includes('(pink)'), md);
  console.log('\n--- markdown ---\n' + md + '--- end ---');
});

test('markdown export is deterministic regardless of input order', () => {
  const shuffled = [CORPUS[1], CORPUS[0], CORPUS[2]];
  assert.equal(toMarkdown(CORPUS, { title: 'T' }), toMarkdown(shuffled, { title: 'T' }));
  assert.equal(toMarkdown(CORPUS, { title: 'T' }), toMarkdown(CORPUS, { title: 'T' }));
});

test('markdown export of an empty document says so', () => {
  assert.equal(toMarkdown([], { title: 'T' }), '# T\n\n*No highlights yet.*\n');
});

console.log(`\nALL GREEN — ${passed} assertions groups passed\n`);

// ── M8: a runaway selection must not bloat the notes file ─────────────────────

test('a runaway selection is capped at the server\'s rect limit', () => {
  const many = [];
  for (let i = 0; i < 4000; i++) many.push({ x: 0.1, y: i * 0.0002, w: 0.3, h: 0.0001 });
  assert.ok(mergeLineRects(many).length <= 512);
});

test('an ordinary selection is untouched by the cap', () => {
  assert.equal(mergeLineRects([{ x: 0.1, y: 0.1, w: 0.3, h: 0.01 }]).length, 1);
});

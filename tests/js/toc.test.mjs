/* Harness for static/js/toc.js: the paper's contents, from its outline or its headings (N7). */
import assert from 'node:assert/strict';
import {
  outlineFromPdf, headingEntries, buildToc, currentEntry, parentsOf, ancestorsOf,
} from '../../static/js/toc.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

// A fake pdf.js document: refs are {num, gen}; page n is ref {num: 100 + n}.
const PAGE_HEIGHT = 800;
const ref = (page) => ({ num: 100 + page, gen: 0 });
const xyz = (page, top) => [ref(page), { name: 'XYZ' }, 0, top, null];
const item = (title, dest, items = [], extra = {}) => ({ title, dest, items, url: null, ...extra });
function fakeDoc({ outline, named = {}, pages = 40 } = {}) {
  return {
    numPages: pages,
    getOutline: async () => outline,
    getDestination: async (name) => {
      if (name === 'boom') throw new Error('bad name tree');
      return named[name] ?? null;
    },
    getPageIndex: async (r) => {
      if (r.num < 100) throw new Error('bad ref');
      return r.num - 101;
    },
    getPage: async () => ({ view: [0, 0, 600, PAGE_HEIGHT] }),
  };
}
const brief = (entries) => entries.map((e) => `${e.depth}:${e.title}@${e.page}`);

console.log('\n[1] the PDF outline');

await test('a nested outline flattens in reading order, keeping depth', async () => {
  const doc = fakeDoc({ outline: [
    item('1 Intro', xyz(3, 700), [item('1.1 Why', xyz(4, 400))]),
    item('2 Method', xyz(9, 800)),
  ] });
  assert.deepEqual(brief(await outlineFromPdf(doc)), ['0:1 Intro@3', '1:1.1 Why@4', '0:2 Method@9']);
});

await test('an XYZ destination gives the 0..1 top of where it points', async () => {
  const [entry] = await outlineFromPdf(fakeDoc({ outline: [item('A', xyz(2, 600))] }));
  assert.equal(entry.top, (PAGE_HEIGHT - 600) / PAGE_HEIGHT);
});

await test('a named destination is looked up; a page-index destination is used as is', async () => {
  const doc = fakeDoc({
    outline: [item('Named', 'sec.2'), item('Indexed', [6, { name: 'Fit' }])],
    named: { 'sec.2': xyz(5, 100) },
  });
  const entries = await outlineFromPdf(doc);
  assert.deepEqual(brief(entries), ['0:Named@5', '0:Indexed@7']);
  assert.equal(entries[1].top, null);   // Fit says nothing about where on the page
});

await test('URL entries, null and broken destinations are dropped', async () => {
  const doc = fakeDoc({ outline: [
    item('Website', null, [], { url: 'https://example.org' }),
    item('Nowhere', null),
    item('Missing', 'no-such-name'),
    item('Broken tree', 'boom'),
    item('Bad ref', [{ num: 1, gen: 0 }, { name: 'XYZ' }, 0, 0, 0]),
    item('Kept', xyz(2, 0)),
  ] });
  assert.deepEqual(brief(await outlineFromPdf(doc)), ['0:Kept@2']);
});

await test('a parent with no destination of its own opens at its first child', async () => {
  const doc = fakeDoc({ outline: [item('Part I', null, [item('Ch 1', xyz(8, 700)), item('Ch 2', xyz(20, 700))])] });
  assert.deepEqual(brief(await outlineFromPdf(doc)), ['0:Part I@8', '1:Ch 1@8', '1:Ch 2@20']);
});

await test('no outline (or no getOutline at all) is an empty list; a failing one too', async () => {
  assert.deepEqual(await outlineFromPdf(fakeDoc({ outline: null })), []);
  assert.deepEqual(await outlineFromPdf({}), []);
  assert.deepEqual(await outlineFromPdf(null), []);
  assert.deepEqual(await outlineFromPdf({ getOutline: async () => { throw new Error('x'); } }), []);
});

await test('entries are frozen', async () => {
  const entries = await outlineFromPdf(fakeDoc({ outline: [item('A', xyz(2, 0))] }));
  assert.ok(Object.isFrozen(entries) && Object.isFrozen(entries[0]));
});

console.log('\n[2] detected headings');

const sec = (index, page, title, size, top = 0.1) => ({ index, page, title, size, top, y: top });

await test('the largest repeated heading size is the chapter level', async () => {
  const entries = headingEntries([
    sec(0, 1, 'A Book Title', 30),
    sec(5, 3, 'Chapter One', 24.8), sec(6, 3, '1.1 Start', 17.2), sec(9, 4, 'Run-in', 12),
    sec(20, 9, 'Chapter Two', 24.8), sec(21, 9, '2.1 Again', 17.2), sec(30, 10, 'Run-in 2', 12),
  ]);
  assert.deepEqual(entries.map((e) => `${e.depth}:${e.title}`), [
    '0:A Book Title', '0:Chapter One', '1:1.1 Start', '2:Run-in', '0:Chapter Two', '1:2.1 Again', '2:Run-in 2',
  ]);
});

await test('a heading split over adjacent sentences of one size is one entry', async () => {
  const entries = headingEntries([
    sec(10, 13, 'Chapter 1', 24.8), sec(11, 13, 'Statistical thinking for', 24.8), sec(12, 13, 'programmers', 24.8),
    sec(14, 14, '1.1 Babies', 17.2),
    sec(30, 23, 'Chapter 2', 24.8), sec(31, 23, 'Descriptive statistics', 24.8),
  ]);
  assert.deepEqual(entries.map((e) => `${e.depth}:${e.title}#${e.index}`), [
    '0:Chapter 1 · Statistical thinking for programmers#10', '1:1.1 Babies#14', '0:Chapter 2 · Descriptive statistics#30',
  ]);
});

await test('headings of one size that are not adjacent sentences stay apart', async () => {
  const entries = headingEntries([sec(1, 2, '2.1 A', 17.2), sec(4, 2, '2.2 B', 17.2), sec(9, 3, '3 C', 24.8), sec(12, 4, '4 D', 24.8)]);
  assert.equal(entries.length, 4);
});

await test('a heading of unknown size goes to the deepest level', async () => {
  const entries = headingEntries([sec(0, 1, 'A', 20), sec(1, 2, 'B', 20), sec(5, 2, 'C', 0)]);
  assert.equal(entries[2].depth, 2);
});

console.log('\n[3] each entry → the sentence it starts reading at');

const s = (page, items, kind = 'body', raw = '') => ({ page, items, kind, raw });
const SCRIPT = Object.freeze([
  s(1, [0]),                       // 0
  s(3, [0], 'heading', '1 Intro'), // 1
  s(3, [1]),                       // 2
  s(4, [2], 'heading', '1.1 Why'), // 3
  s(4, [3]),                       // 4
  s(9, [5]),                       // 5  page 9's heading was not spoken
]);
const SECTIONS = Object.freeze([sec(1, 3, '1 Intro', 20, 0.1), sec(3, 4, '1.1 Why', 14, 0.5)]);

await test('an outline entry whose title matches a heading on its page starts at that heading', async () => {
  const toc = buildToc({ outline: [{ title: '1.1  WHY', depth: 1, page: 4, top: 0 }], sections: SECTIONS, sentences: SCRIPT });
  assert.equal(toc.entries[0].index, 3);
  assert.equal(toc.source, 'outline');
});

await test('without a title match, the first heading at or below the destination', async () => {
  const toc = buildToc({ outline: [{ title: 'Why we care', depth: 0, page: 4, top: 0.45 }], sections: SECTIONS, sentences: SCRIPT });
  assert.equal(toc.entries[0].index, 3);
});

await test('with no heading to anchor it, the first sentence read on (or after) its page', async () => {
  const toc = buildToc({ outline: [{ title: 'Method', depth: 0, page: 8, top: null }], sections: SECTIONS, sentences: SCRIPT });
  assert.equal(toc.entries[0].index, 5);
});

await test('an entry after everything read aloud has no sentence (-1) but keeps its page', async () => {
  const toc = buildToc({ outline: [{ title: 'Index', depth: 0, page: 40, top: null }], sections: SECTIONS, sentences: SCRIPT });
  assert.deepEqual([toc.entries[0].index, toc.entries[0].page], [-1, 40]);
});

await test('no outline: the detected headings, each at its own sentence', async () => {
  const toc = buildToc({ outline: [], sections: SECTIONS, sentences: SCRIPT });
  assert.equal(toc.source, 'headings');
  assert.deepEqual(toc.entries.map((e) => e.index), [1, 3]);
});

await test('nothing at all is an empty, frozen contents', async () => {
  const toc = buildToc({});
  assert.deepEqual(toc.entries, []);
  assert.equal(toc.source, 'none');
  assert.ok(Object.isFrozen(toc) && Object.isFrozen(toc.entries));
});

console.log('\n[4] where the reader is, and the tree');

const ENTRIES = Object.freeze([
  { depth: 0, index: 1 }, { depth: 1, index: 3 }, { depth: 2, index: 4 }, { depth: 0, index: 10 }, { depth: 1, index: -1 },
]);

await test('the current entry is the last one started at or before the reading index', async () => {
  assert.equal(currentEntry(ENTRIES, 0), -1);
  assert.equal(currentEntry(ENTRIES, 1), 0);
  assert.equal(currentEntry(ENTRIES, 3), 1);
  assert.equal(currentEntry(ENTRIES, 9), 2);
  assert.equal(currentEntry(ENTRIES, 50), 3);
});

await test('each entry\'s parent is the nearest shallower entry before it', async () => {
  assert.deepEqual(parentsOf(ENTRIES), [-1, 0, 1, -1, 3]);
});

await test('a depth that skips a level still finds its parent', async () => {
  assert.deepEqual(parentsOf([{ depth: 0 }, { depth: 2 }, { depth: 1 }]), [-1, 0, 0]);
});

await test('ancestors run from the entry up to its chapter', async () => {
  assert.deepEqual(ancestorsOf(parentsOf(ENTRIES), 2), [1, 0]);
  assert.deepEqual(ancestorsOf(parentsOf(ENTRIES), -1), []);
});

console.log(`\n${passed} passed`);

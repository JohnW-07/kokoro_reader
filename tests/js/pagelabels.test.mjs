/* Harness for static/js/pagelabels.js: the page numbers the paper prints (N8). */
import assert from 'node:assert/strict';
import {
  fromPdfLabels, pageCandidates, labelsFromMarks, choosePageLabels, pillText, resolvePageInput,
} from '../../static/js/pagelabels.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const header = (page, text) => ({ page, text, kind: 'header' });
const pagenum = (page, text) => ({ page, text, kind: 'pagenum' });

console.log('\n[1] the PDF\'s own page labels');

test('no labels in the PDF means none', () => {
  assert.equal(fromPdfLabels(null, 3), null);
});

test('labels that only repeat the index are no labels at all', () => {
  assert.equal(fromPdfLabels(['1', '2', '3'], 3), null);
});

test('real labels come back, frozen', () => {
  const labels = fromPdfLabels(['i', 'ii', '1', '2'], 4);
  assert.deepEqual(labels, ['i', 'ii', '1', '2']);
  assert.ok(Object.isFrozen(labels));
});

test('an empty label is an unnumbered page', () => {
  assert.deepEqual(fromPdfLabels(['', 'ii', '1'], 3), [null, 'ii', '1']);
});

test('labels that do not cover the document are not trusted', () => {
  assert.equal(fromPdfLabels(['i', 'ii'], 3), null);
});

console.log('\n[2] reading a printed number off a margin line');

const values = (text) => pageCandidates(text).map((c) => `${c.kind}:${c.value}`);

test('a running header that starts with the number', () => {
  assert.deepEqual(values('12 Chapter 2. Descriptive statistics'), ['arabic:12']);
});

test('a running header that ends with it, after a section number', () => {
  assert.deepEqual(values('2.3. Distributions 13'), ['arabic:13']);
});

test('a bare roman numeral, and one leading a header', () => {
  assert.deepEqual(values('vii'), ['roman:7']);
  assert.deepEqual(values('x Contents'), ['roman:10']);
});

test('"Page 3 of 12" is page 3, never 12', () => {
  assert.deepEqual(values('Page 3 of 12'), ['arabic:3']);
  assert.deepEqual(values('3 / 12'), ['arabic:3']);
});

test('words, decimals and mixed-case numerals are not page numbers', () => {
  assert.deepEqual(values('Introduction'), []);
  assert.deepEqual(values('2.3.'), []);
  assert.deepEqual(values('Vii'), []);
  assert.deepEqual(values(''), []);
});

console.log('\n[3] labels from the printed numbers');

test('the thinkstats shape: an unnumbered chapter opener between two numbered pages', () => {
  // PDF pages 22 and 24 print 10 and 12 in their running headers; page 23 opens a chapter.
  const labels = labelsFromMarks([header(22, '10 Chapter 1. Thinking'), header(24, '12 Chapter 2. Statistics'),
    header(25, '2.3. Distributions 13')], 30);
  assert.equal(labels[23 - 1], '11');
  assert.equal(labels[22 - 1], '10');
});

test('offset runs: front matter in roman, body in arabic, each filled between agreeing anchors', () => {
  const labels = labelsFromMarks([
    pagenum(2, 'ii'), header(4, 'iv Preface'),
    header(7, '2 Chapter 1'), header(9, '1.2. Method 4'), header(10, '5 Chapter 1'),
  ], 12);
  assert.deepEqual(labels, [
    'i', 'ii', 'iii', 'iv', 'v',        // roman 2..4, one page out each way
    '1', '2', '3', '4', '5', '6',       // arabic 7..10, one page out each way
    null,                               // two past the last anchor: unnumbered
  ]);
});

test('a lone printed number is not trusted, so the document has no labels', () => {
  assert.equal(labelsFromMarks([header(5, '17 Results')], 8), null);
});

test('two numbers that disagree on the offset fill nothing', () => {
  assert.equal(labelsFromMarks([header(2, '5 A'), header(6, '7 B')], 8), null);
});

test('a stray margin number inside a run (a subscript "1") does not override it', () => {
  const labels = labelsFromMarks([header(3, '1 A'), pagenum(4, '1'), header(5, '3 B')], 6);
  assert.equal(labels[4 - 1], '2');
});

test('the run with more anchors wins pages two runs both claim', () => {
  const marks = [header(2, '1 A'), header(3, '2 B'), header(4, '3 C'), header(5, '4 D'),
    pagenum(3, '7'), pagenum(5, '9')];   // footnote markers that happen to agree with each other
  assert.deepEqual(labelsFromMarks(marks, 5), [null, '1', '2', '3', '4']);
});

test('a run is never extended below page one of its numbering', () => {
  assert.deepEqual(labelsFromMarks([header(2, '1 A'), header(3, '2 B')], 3), [null, '1', '2']);
});

test('upper-case roman numerals stay upper case', () => {
  const labels = labelsFromMarks([pagenum(2, 'IV'), pagenum(3, 'V')], 4);
  assert.deepEqual(labels, ['III', 'IV', 'V', 'VI']);
});

test('labels identical to the index are dropped ("Page N of M" decks)', () => {
  assert.equal(labelsFromMarks([header(1, 'Page 1 of 3'), header(2, 'Page 2 of 3'), header(3, 'Page 3 of 3')], 3), null);
});

test('no marks, no labels; bad input never throws', () => {
  assert.equal(labelsFromMarks([], 4), null);
  assert.equal(labelsFromMarks(null, 4), null);
  assert.equal(labelsFromMarks([{ page: 'x', text: 3 }], 4), null);
});

test('the result is frozen', () => {
  assert.ok(Object.isFrozen(labelsFromMarks([header(2, '1 A'), header(3, '2 B')], 3)));
});

console.log('\n[4] which source wins');

test('the PDF\'s labels win over printed numbers', () => {
  const labels = choosePageLabels({ pdfLabels: ['a', 'b'], marks: [header(1, '7 A'), header(2, '8 B')], numPages: 2 });
  assert.deepEqual(labels, ['a', 'b']);
});

test('identity PDF labels fall through to the printed numbers', () => {
  const labels = choosePageLabels({ pdfLabels: ['1', '2'], marks: [header(1, '7 A'), header(2, '8 B')], numPages: 2 });
  assert.deepEqual(labels, ['7', '8']);
});

console.log('\n[5] the pill');

test('a page whose printed number differs shows it first, the index second', () => {
  assert.equal(pillText(23, 40, Object.assign([], { 22: '11' })), 'p. 11 · 23/40');
});

test('a page with no label, or a label equal to the index, keeps the old format', () => {
  assert.equal(pillText(7, 40, null), 'Page 7 / 40');
  assert.equal(pillText(7, 40, ['1', '2', '3', '4', '5', '6', '7']), 'Page 7 / 40');
  assert.equal(pillText(7, 40, []), 'Page 7 / 40');
});

console.log('\n[6] "Go to page"');

const BOOK = Object.freeze(Array.from({ length: 40 }, (_, i) => (i < 12 ? null : String(i - 11))));
const ROMAN = Object.freeze(['i', 'ii', 'iii', ...BOOK.slice(3)]);

test('a printed number goes to the page that prints it', () => {
  assert.equal(resolvePageInput('11', BOOK, 40), 23);
  assert.equal(resolvePageInput('p. 11', BOOK, 40), 23);
  assert.equal(resolvePageInput('Page 11', BOOK, 40), 23);
});

test('roman labels match regardless of case', () => {
  assert.equal(resolvePageInput('II', ROMAN, 40), 2);
});

test('"#n" is always the PDF index', () => {
  assert.equal(resolvePageInput('#11', BOOK, 40), 11);
});

test('a number no page prints falls back to the index', () => {
  assert.equal(resolvePageInput('35', BOOK, 40), 35);
  assert.equal(resolvePageInput('5', null, 40), 5);
});

test('nonsense and out-of-range input go nowhere', () => {
  ['', 'abc', '0', '41', '#0', '#41', '-3', '1.5'].forEach((text) => assert.equal(resolvePageInput(text, null, 40), -1, text));
});

console.log(`\n${passed} passed`);

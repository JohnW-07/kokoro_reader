// Harness for N4's resume position: a rebuild that joins sentences across page turns
// shifts every later index, so a bare `last_index` would silently move John's place.
// The record also keeps `last_sentence` {page, text}, and restore finds that sentence again.
import assert from 'node:assert/strict';
import { resumeMark, resumeIndex, RESUME_TEXT_CHARS } from '../../static/js/resume.js';
import { recordPayload } from '../../static/js/notesync.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const s = (page, text, spans) => ({ page, text, items: [0], ...(spans ? { spans } : {}) });
const TAIL = 'The init method in each class specifies the default name of the data file and the';
const HEAD = 'type of record to create.';
const SAVED_TEXT = 'Exercise 2.1 asks for the mean pregnancy length.';

// The script a reader saved against: two page turns split their sentences.
const OLD = Object.freeze([
  s(16, 'Chapter one ends here and the'), s(17, 'next chapter begins.'),
  s(17, TAIL), s(18, HEAD),
  s(18, SAVED_TEXT), s(18, 'More text follows.'),
]);
// The same pages after N4: both turns are now one sentence each.
const NEW = Object.freeze([
  s(16, 'Chapter one ends here and the next chapter begins.', [{ page: 16, items: [0] }, { page: 17, items: [0] }]),
  s(17, `${TAIL} ${HEAD}`, [{ page: 17, items: [0] }, { page: 18, items: [0] }]),
  s(18, SAVED_TEXT), s(18, 'More text follows.'),
]);
const savedAt = (index) => ({ last_index: index, last_sentence: resumeMark(OLD[index]) });

console.log('\n[1] resumeMark');

test('a mark is the sentence\'s start page and a capped text prefix', () => {
  assert.deepEqual(resumeMark(OLD[4]), { page: 18, text: SAVED_TEXT });
  assert.equal(resumeMark({ page: 3, text: 'x'.repeat(500) }).text.length, RESUME_TEXT_CHARS);
  assert.equal(resumeMark(undefined), null);
});

console.log('\n[2] resumeIndex');

test('HEADLINE: after a rebuild that joined two sentences before it, restore lands on the same sentence', () => {
  const index = resumeIndex(NEW, savedAt(4));
  assert.equal(NEW[index].text, SAVED_TEXT);
  assert.equal(index, 2, 'the bare index (4) would now be "More text follows." or past it');
});

test('a place saved on a half that was joined lands on the joined sentence', () => {
  assert.equal(resumeIndex(NEW, savedAt(3)), 1, 'the head half, page 18');
  assert.equal(resumeIndex(NEW, savedAt(2)), 1, 'the tail half, page 17');
});

test('the same text on another page does not capture the place', () => {
  // The twin on page 19 sits nearer the saved index (4) than the real one (2) does.
  const twin = [...NEW.slice(0, 3), s(19, SAVED_TEXT), NEW[3]];
  assert.equal(twin[resumeIndex(twin, savedAt(4))].page, 18);
});

test('of several matches on the page, the one nearest the saved index wins', () => {
  const repeated = [s(18, 'Note.'), s(18, 'x'), s(18, 'x'), s(18, 'Note.'), s(18, 'y')];
  assert.equal(resumeIndex(repeated, { last_index: 4, last_sentence: { page: 18, text: 'Note.' } }), 3);
});

test('an older record with no mark falls back to its index, clamped to the script', () => {
  assert.equal(resumeIndex(NEW, { last_index: 2 }), 2);
  assert.equal(resumeIndex(NEW, { last_index: 99 }), NEW.length - 1);
});

test('a mark that matches nothing falls back to the index', () => {
  assert.equal(resumeIndex(NEW, { last_index: 3, last_sentence: { page: 9, text: 'gone' } }), 3);
});

test('nothing to resume gives -1', () => {
  assert.equal(resumeIndex(NEW, { last_index: 0 }), -1);
  assert.equal(resumeIndex(NEW, null), -1);
  assert.equal(resumeIndex([], savedAt(4)), -1);
});

console.log('\n[3] the saved record carries the mark');

test('recordPayload writes the current sentence\'s mark beside its index', () => {
  const record = recordPayload({ docId: 'd', docName: 't', highlights: [], index: 4, sentences: OLD,
    options: {}, blocks: [] });
  assert.equal(record.last_index, 4);
  assert.deepEqual(record.last_sentence, { page: 18, text: SAVED_TEXT });
  assert.equal(recordPayload({ docId: 'd', index: 0, blocks: [] }).last_sentence, null);
});

console.log(`\nALL GREEN — ${passed} tests passed\n`);

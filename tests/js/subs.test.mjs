/* Harness for static/js/subs.js — the pure rules behind the Subs tab (T6). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as subs from '../../static/js/subs.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const row = (find, replace = 'x', ignore_case = false) => subs.makeSub({ find, replace, ignore_case });

console.log('\n[1] the limits mirror the server');

test('MAX_* constants equal kokoro_reader/config.py', () => {
  const py = readFileSync(new URL('../../kokoro_reader/config.py', import.meta.url), 'utf8');
  const value = (name) => Number(py.match(new RegExp(`^${name}\\s*=\\s*(\\d+)`, 'm'))?.[1]);
  assert.equal(subs.MAX_SUBSTITUTIONS, value('MAX_SUBSTITUTIONS'));
  assert.equal(subs.MAX_FIND_CHARS, value('MAX_SUB_FIND_CHARS'));
  assert.equal(subs.MAX_REPLACE_CHARS, value('MAX_SUB_REPLACE_CHARS'));
});

console.log('\n[2] makeSub / loadSubs treat input as untrusted');

test('makeSub keeps only well-typed fields, capped, and freezes', () => {
  const r = subs.makeSub({ find: 'G'.repeat(500), replace: 7, ignore_case: 'yes', extra: 1 });
  assert.deepEqual(r, { find: 'G'.repeat(subs.MAX_FIND_CHARS), replace: '', ignore_case: false });
  assert.ok(Object.isFrozen(r));
  assert.deepEqual(subs.makeSub(null), { find: '', replace: '', ignore_case: false });
});

test('loadSubs survives junk prefs and caps the count', () => {
  for (const junk of [undefined, null, 'GR00T', 42, { find: 'GR00T' }]) assert.deepEqual(subs.loadSubs(junk), []);
  const many = Array.from({ length: subs.MAX_SUBSTITUTIONS + 5 }, (_, i) => ({ find: `t${i}` }));
  const loaded = subs.loadSubs([...many]);
  assert.equal(loaded.length, subs.MAX_SUBSTITUTIONS);
  assert.ok(Object.isFrozen(loaded) && loaded.every(Object.isFrozen));
  assert.deepEqual(subs.loadSubs([null, { find: 'GR00T', replace: 'groot' }])[1],
    { find: 'GR00T', replace: 'groot', ignore_case: false });
});

console.log('\n[3] validate');

test('a valid list has no messages', () => {
  assert.deepEqual(subs.validate([row('GR00T', 'groot'), row('π0', 'pi zero')]), ['', '']);
});

test('empty or blank find is flagged', () => {
  assert.deepEqual(subs.validate([row(''), row('   ')]), [subs.MESSAGES.emptyFind, subs.MESSAGES.emptyFind]);
});

test('only the later of two duplicates is flagged', () => {
  assert.deepEqual(subs.validate([row('GR00T'), row(' GR00T ')]), ['', subs.MESSAGES.duplicate]);
});

test('duplicates are case-sensitive unless either row ignores case', () => {
  assert.deepEqual(subs.validate([row('GR00T'), row('Gr00t')]), ['', '']);
  assert.deepEqual(subs.validate([row('GR00T'), row('gr00t', 'x', true)]), ['', subs.MESSAGES.duplicate]);
  assert.deepEqual(subs.validate([row('gr00t', 'x', true), row('GR00T')]), ['', subs.MESSAGES.duplicate]);
});

test('an empty row above does not make a later row a duplicate', () => {
  assert.deepEqual(subs.validate([row(''), row('GR00T')]), [subs.MESSAGES.emptyFind, '']);
});

test('control characters are flagged in either field', () => {
  assert.deepEqual(subs.validate([row('GR\n00T'), row('GR00T', 'gro\x00ot')]),
    [subs.MESSAGES.control, subs.MESSAGES.control]);
});

test('validateDraft judges a new row against the list, and the count cap', () => {
  const list = [row('GR00T')];
  assert.equal(subs.validateDraft(list, { find: 'GR00T' }), subs.MESSAGES.duplicate);
  assert.equal(subs.validateDraft(list, { find: '' }), subs.MESSAGES.emptyFind);
  assert.equal(subs.validateDraft(list, { find: 'π0' }), '');
  const full = Array.from({ length: subs.MAX_SUBSTITUTIONS }, (_, i) => row(`t${i}`));
  assert.equal(subs.validateDraft(full, { find: 'new' }), subs.MESSAGES.tooMany);
});

console.log('\n[4] toPayload / samePayload');

test('the payload holds valid rows only, trimmed, as plain new objects', () => {
  const rows = [row(' GR00T ', ' groot '), row(''), row('GR00T', 'dup'), row('π0', 'pi zero', true)];
  const payload = subs.toPayload(rows);
  assert.deepEqual(payload, [
    { find: 'GR00T', replace: 'groot', ignore_case: false },
    { find: 'π0', replace: 'pi zero', ignore_case: true },
  ]);
  assert.ok(!Object.isFrozen(payload[0]) && payload[0] !== rows[0]);
});

test('samePayload ignores edits the server would never see', () => {
  const base = [row('GR00T', 'groot')];
  assert.ok(subs.samePayload(base, [row(' GR00T', 'groot '), row('')]));
  assert.ok(!subs.samePayload(base, [row('GR00T', 'groot', true)]));
  assert.ok(!subs.samePayload(base, []));
});

console.log('\n[5] edits never mutate their input');

test('addSub, updateSub and removeSub return new frozen lists', () => {
  const start = subs.loadSubs([{ find: 'GR00T', replace: 'groot' }]);
  const added = subs.addSub(start, { find: 'π0', replace: 'pi zero' });
  const updated = subs.updateSub(added, 0, { replace: 'grute' });
  const removed = subs.removeSub(updated, 1);
  assert.equal(start.length, 1);
  assert.equal(start[0].replace, 'groot');
  assert.equal(added.length, 2);
  assert.equal(updated[0].replace, 'grute');
  assert.equal(added[0].replace, 'groot');
  assert.deepEqual(removed.map((r) => r.find), ['GR00T']);
  assert.equal(updated.length, 2);
  for (const list of [added, updated, removed]) assert.ok(Object.isFrozen(list));
});

test('out-of-range indexes are no-ops', () => {
  const start = subs.loadSubs([{ find: 'GR00T' }]);
  assert.equal(subs.updateSub(start, 3, { find: 'x' }), start);
  assert.equal(subs.removeSub(start, -1), start);
});

console.log(`\nALL PASS: ${passed} passed`);

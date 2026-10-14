/* Harness for static/js/loadgate.js (A2) and transportrules.js (A4, A6, A7, A10). */
import assert from 'node:assert/strict';
import { createLoadGate } from '../../static/js/loadgate.js';
import { isAnnounced, isResting, ownsSpace, remapIndex } from '../../static/js/transportrules.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

// ── A2: load generations ─────────────────────────────────────────────────────
test('a load stays current until a later one begins, then never again', () => {
  const gate = createLoadGate();
  const first = gate.begin();
  assert.equal(first(), true);
  const second = gate.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  gate.begin();
  assert.equal(second(), false);
});

test('joining the current load does not supersede it', () => {
  const gate = createLoadGate();
  const load = gate.begin();
  const rebuild = gate.current();
  assert.equal(load(), true);
  assert.equal(rebuild(), true);
  gate.begin();
  assert.equal(rebuild(), false, 'a paper opened mid-rebuild makes the rebuild stale');
});

test('a load carries a signal that aborts when a later load begins', () => {
  const gate = createLoadGate();
  const load = gate.begin();
  const rebuild = gate.current();
  assert.equal(rebuild.signal, load.signal, 'a joined rebuild shares the load\'s signal');
  assert.equal(load.signal.aborted, false);
  const next = gate.begin();
  assert.equal(load.signal.aborted, true);
  assert.equal(next.signal.aborted, false);
});

// ── A4: the cursor after a rebuild ───────────────────────────────────────────
const s = (page, items) => ({ page, items });
const BEFORE = Object.freeze([s(1, [0]), s(1, [2, 3]), s(2, [5]), s(2, [7, 8]), s(3, [1])]);

test('the same sentence at a new index is found by its first item', () => {
  const after = [s(1, [2, 3]), s(2, [5]), s(2, [7, 8]), s(3, [1])];   // the title was dropped
  assert.equal(remapIndex(BEFORE, 3, after), 2);
});

test('a sentence the rebuild dropped resumes at the one after it', () => {
  const after = [s(1, [0]), s(1, [2, 3]), s(2, [9]), s(3, [1])];      // [7, 8] is now excluded
  assert.equal(remapIndex(BEFORE, 3, after), 2);
});

test('a split sentence resumes at the part holding its first item', () => {
  const after = [s(1, [0]), s(1, [2]), s(1, [3]), s(2, [5])];
  assert.equal(remapIndex(BEFORE, 1, after), 1);
});

test('with nothing left after the old place, the cursor goes to the last sentence', () => {
  assert.equal(remapIndex(BEFORE, 4, [s(1, [0]), s(2, [5])]), 1);
});

test('an index outside the old script is clamped; an empty new script gives -1', () => {
  const after = [s(1, [0]), s(1, [2, 3])];
  assert.equal(remapIndex(BEFORE, 9, after), 1);
  assert.equal(remapIndex([], 0, after), 0);
  assert.equal(remapIndex(BEFORE, 2, []), -1);
});

test('an anchor without items resumes at the first sentence on its page', () => {
  assert.equal(remapIndex([{ page: 2 }], 0, BEFORE), 2);
});

test('remapping never mutates either script', () => {
  const after = Object.freeze([Object.freeze(s(2, Object.freeze([5])))]);
  assert.equal(remapIndex(BEFORE, 2, after), 0);
});

// ── A6: Space belongs to the focused control ─────────────────────────────────
/** Minimal Element: `closest` walks up, matching any selector in a comma list. */
const node = (tag, attrs = {}, parent = null) => ({
  tagName: tag.toUpperCase(),
  attrs,
  parent,
  closest(list) {
    const sels = list.split(',').map((x) => x.trim());
    const hit = (n, sel) => {
      const role = sel.match(/^\[role="(\w+)"\]$/);
      return role ? n.attrs.role === role[1] : n.tagName === sel.toUpperCase();
    };
    for (let n = this; n; n = n.parent) if (sels.some((sel) => hit(n, sel))) return n;
    return null;
  },
});

test('Space on a button, a [role=button] (the drop zone) or a summary is theirs', () => {
  assert.equal(ownsSpace(node('button')), true);
  assert.equal(ownsSpace(node('div', { role: 'button' })), true);
  assert.equal(ownsSpace(node('summary')), true);
  assert.equal(ownsSpace(node('span', {}, node('button'))), true, 'an icon inside a button');
});

test('Space anywhere else is the reader\'s', () => {
  assert.equal(ownsSpace(node('body')), false);
  assert.equal(ownsSpace(node('div', {}, node('section'))), false);
  assert.equal(ownsSpace(null), false);
  assert.equal(ownsSpace({}), false, 'a target without closest (document, window)');
});

// ── A7: what the status bar announces ────────────────────────────────────────
test('the per-sentence loading and playing lines are not announced', () => {
  assert.equal(isAnnounced({ state: 'loading', level: 'info' }), false);
  assert.equal(isAnnounced({ state: 'playing', level: 'info' }), false);
});

test('warnings, errors and every other phase still are', () => {
  assert.equal(isAnnounced({ state: 'playing', level: 'warn' }), true);
  assert.equal(isAnnounced({ state: 'loading', level: 'error' }), true);
  ['paused', 'idle', 'error', 'recovering'].forEach((state) =>
    assert.equal(isAnnounced({ state, level: 'info' }), true, state));
  assert.equal(isAnnounced(), true);
});

// ── A10: when the position is saved ──────────────────────────────────────────
test('pausing or stopping saves the position; moving phases do not', () => {
  assert.equal(isResting('paused'), true);
  assert.equal(isResting('idle'), true);
  ['loading', 'playing', 'recovering', 'error', undefined].forEach((phase) =>
    assert.equal(isResting(phase), false, String(phase)));
});

console.log(`\nALL GREEN — ${passed} tests passed\n`);

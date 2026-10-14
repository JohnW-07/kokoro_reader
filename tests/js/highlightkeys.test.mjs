/* The highlighter's Delete/Backspace shortcut (A5), on a minimal DOM fake. */
import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.isContentEditable = false;
    this.kids = new Map();
    const cls = new Set();
    this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) };
  }
  setAttribute() {}
  addEventListener() {}
  appendChild(node) { return node; }
  querySelector(sel) {
    if (!this.kids.has(sel)) this.kids.set(sel, new El(sel === '.hl-note' ? 'textarea' : 'button'));
    return this.kids.get(sel);
  }
  getBoundingClientRect() { return { top: 100, bottom: 120, left: 0, width: 100, height: 20 }; }
  scrollIntoView() {}
  focus() {}
  remove() {}
}

const listeners = new Map();
const rectNode = new El('div');
globalThis.document = {
  body: new El('body'),
  createElement: (tag) => new El(tag),
  querySelector: (sel) => (sel.startsWith('.hl-rect') ? rectNode : null),
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: (type) => listeners.delete(type),
};
globalThis.window = {
  innerWidth: 1280, innerHeight: 900, getSelection: () => null,
  addEventListener() {}, removeEventListener() {},
};

const { createHighlighter } = await import('../../static/js/highlights.js');

const HL = { id: 'h1', page: 1, rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }], text: 't', color: 'yellow', note: 'kept' };

function setup() {
  const hl = createHighlighter({ pdfView: {} });
  hl.setHighlights([HL]);
  hl.attach();
  return hl;
}

function press(key, target = document.body, mods = {}) {
  const event = { key, target, ...mods, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  listeners.get('keydown')(event);
  return event;
}

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  const hl = setup();
  try {
    fn(hl);
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${err.message.split('\n')[0]}`);
  } finally {
    hl.destroy();
  }
};

console.log('\n[A5] Delete/Backspace needs the popover and its confirm');

for (const key of ['Backspace', 'Delete']) {
  test(`after focus() (a Highlights-list jump) a stray ${key} keeps the highlight`, (hl) => {
    hl.focus('h1');
    const event = press(key);
    assert.equal(hl.list().length, 1);
    assert.equal(event.defaultPrevented, false);
  });
}

test('with the popover open, the first Delete only arms the confirm, the second deletes', (hl) => {
  hl.focus('h1');
  press('n');                                   // opens the popover
  press('Delete');
  assert.equal(hl.list().length, 1, 'first press must not delete');
  press('Delete');
  assert.equal(hl.list().length, 0, 'second press confirms');
});

test('Backspace in the popover note textarea is untouched', (hl) => {
  hl.focus('h1');
  press('n');
  const textarea = new El('textarea');
  for (let i = 0; i < 2; i += 1) assert.equal(press('Backspace', textarea).defaultPrevented, false);
  assert.equal(hl.list().length, 1);
});

test('Backspace in a contentEditable field (notes editor) is untouched', (hl) => {
  hl.focus('h1');
  press('n');
  const editable = Object.assign(new El('div'), { isContentEditable: true });
  for (let i = 0; i < 2; i += 1) assert.equal(press('Backspace', editable).defaultPrevented, false);
  assert.equal(hl.list().length, 1);
});

console.log('\n[U32] a focused highlight is a button: Enter and Space open it');

/** The first rect of highlight h1, as rectEl builds it: a focusable [role=button]. */
const focusedRect = () => {
  const node = Object.assign(new El('div'), { dataset: { hlId: 'h1' } });
  node.closest = (sel) => (sel === '.hl-rect' ? node : null);
  return node;
};

for (const [label, key] of [['Space', ' '], ['Enter', 'Enter']]) {
  test(`${label} on a focused highlight opens its popover, as a click does`, (hl) => {
    const event = press(key, focusedRect());
    assert.equal(hl.hasActive(), true, 'the highlight is active');
    assert.equal(event.defaultPrevented, true, 'the key is taken (no page scroll, no play/pause)');
    press('Delete');
    press('Delete');
    assert.equal(hl.list().length, 0, 'the popover is open: its Delete confirm works');
  });
}

for (const mod of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey']) {
  test(`Space or Enter with ${mod} held on a highlight is a chord, not a click`, (hl) => {
    const events = [' ', 'Enter'].map((key) => press(key, focusedRect(), { [mod]: true }));
    assert.equal(events.some((e) => e.defaultPrevented), false, 'the chord is left alone');
    assert.equal(hl.hasActive(), false, 'no popover opens');
  });
}

test('each re-render gives the focus back to the focused highlight\'s rebuilt rect', (hl) => {
  let focuses = 0;
  rectNode.focus = () => { focuses += 1; };
  document.activeElement = focusedRect();
  try {
    for (const key of ['Enter', '2', 'Escape']) press(key, document.activeElement);   // open, recolour, close
  } finally {
    delete rectNode.focus;
    delete document.activeElement;
  }
  assert.equal(focuses, 3, 'open, recolour and close each re-render, and each refocuses');
});

test('Space anywhere else is left for the global play/pause', (hl) => {
  const event = press(' ');
  assert.equal(event.defaultPrevented, false);
  assert.equal(hl.hasActive(), false);
});

console.log(`\n${failed ? 'FAILURES' : 'ALL GREEN'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

/* U33: Tab order and focus-after-remove follow reading order, not creation order.
 * A minimal DOM fake that keeps each layer's children, so the Tab order can be read off it. */
import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.dataset = {};
    this.children = [];
    this.style = {};
    this.tabIndex = -1;
    this.value = '';
    const cls = new Set();
    this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) };
  }
  get textContent() { return ''; }
  set textContent(_) { this.children = []; }
  setAttribute(key, value) {
    if (key === 'data-hl-id') this.dataset.hlId = value;
  }
  addEventListener() {}
  appendChild(node) {
    if (node.tagName === '#FRAGMENT') node.children.splice(0).forEach((kid) => this.appendChild(kid));
    else this.children.push(node);
    return node;
  }
  querySelector(sel) {
    if (sel === '.hl-layer') return this.children.find((kid) => kid.className === 'hl-layer') || null;
    return new El(sel === '.hl-note' ? 'textarea' : 'button');
  }
  closest(sel) { return sel === '.hl-rect' && this.className === 'hl-rect' ? this : null; }
  contains() { return false; }
  getBoundingClientRect() { return { top: 100, bottom: 120, left: 0, width: 100, height: 20 }; }
  scrollIntoView() {}
  focus() { globalThis.document.activeElement = this; }
  remove() {}
}

const wraps = { 1: new El('div'), 2: new El('div') };
const rectsOnScreen = () => Object.values(wraps)
  .flatMap((wrap) => wrap.querySelector('.hl-layer')?.children || []);

const listeners = new Map();
globalThis.document = {
  body: new El('body'),
  activeElement: null,
  createElement: (tag) => new El(tag),
  createDocumentFragment: () => new El('#fragment'),
  querySelector: (sel) => {
    const id = /data-hl-id="([^"]*)"/.exec(sel)?.[1];
    return rectsOnScreen().find((node) => node.dataset.hlId === id) || null;
  },
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: (type) => listeners.delete(type),
};
globalThis.window = {
  innerWidth: 1280, innerHeight: 900, getSelection: () => null,
  addEventListener() {}, removeEventListener() {},
};

const { createHighlighter } = await import('../../static/js/highlights.js');

const hl = (id, page, ...rects) => ({ id, page, rects, text: id, color: 'yellow', note: '' });
const LINE_H = 0.02;
// Created B, A, C, D. Read D, C (same line as D, a hair higher, further right), B, then A on page 2.
const CREATED = [
  hl('B', 1, { x: 0.1, y: 0.8, w: 0.5, h: LINE_H }, { x: 0.1, y: 0.83, w: 0.3, h: LINE_H }),
  hl('A', 2, { x: 0.1, y: 0.1, w: 0.5, h: LINE_H }),
  hl('C', 1, { x: 0.5, y: 0.098, w: 0.3, h: LINE_H }),
  hl('D', 1, { x: 0.1, y: 0.1, w: 0.3, h: LINE_H }),
];
const READING = ['D', 'C', 'B', 'A'];

function setup(list = CREATED) {
  const highlighter = createHighlighter({ pdfView: { numPages: () => 2, pageWrapEl: (page) => wraps[page] } });
  highlighter.setHighlights(list);
  return highlighter;
}

/** The ids in the order Tab visits them: the focusable rects, in document order. */
const tabOrder = () => rectsOnScreen().filter((node) => node.tabIndex === 0).map((node) => node.dataset.hlId);
const focusedHl = () => document.activeElement?.dataset?.hlId;

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${err.message.split('\n')[0]}`);
  } finally {
    document.activeElement = null;
  }
};

console.log('\n[U33] highlights are visited in reading order');

test('Tab runs page by page, top to bottom, then left to right on a line', () => {
  setup();
  assert.deepEqual(tabOrder(), READING);
});

test('removing a focused highlight focuses the next one in reading order', () => {
  const highlighter = setup();
  document.querySelector('[data-hl-id="C"]').focus();
  highlighter.remove('C');
  assert.equal(focusedHl(), 'B');
});

test('removing the last one in reading order focuses the one before it', () => {
  const highlighter = setup();
  document.querySelector('[data-hl-id="A"]').focus();
  highlighter.remove('A');
  assert.equal(focusedHl(), 'B');
});

test('a highlight is placed by its top line, not its bottom one', () => {
  setup([hl('Y', 1, { x: 0.1, y: 0.3, w: 0.5, h: LINE_H }),
    hl('X', 1, { x: 0.1, y: 0.1, w: 0.5, h: LINE_H }, { x: 0.1, y: 0.5, w: 0.5, h: LINE_H })]);
  assert.deepEqual(tabOrder(), ['X', 'Y']);
});

test('a click where two overlap opens the one painted on top (later in the DOM)', () => {
  // P made first, Q second; Q starts further left on the line, so Q comes first in reading order.
  const highlighter = setup([hl('P', 1, { x: 0.5, y: 0.5, w: 0.3, h: 0.1 }), hl('Q', 1, { x: 0.1, y: 0.5, w: 0.6, h: 0.1 })]);
  highlighter.attach();
  try {
    const box = wraps[1].getBoundingClientRect();
    const [nx, ny] = [0.6, 0.55];                // inside both
    const onWrap = { closest: (sel) => (sel === '.pdf-page-wrap' ? wraps[1] : null) };
    listeners.get('click')({ target: onWrap, clientX: box.left + nx * box.width, clientY: box.top + ny * box.height });
    const painted = rectsOnScreen().filter((node) => ['P', 'Q'].includes(node.dataset.hlId)).at(-1).dataset.hlId;
    assert.equal(painted, 'P');
    assert.equal(highlighter.recent()?.id, painted);
  } finally {
    highlighter.destroy();
  }
});

test('the stored list keeps creation order: only a copy is sorted', () => {
  const highlighter = setup();
  highlighter.remove('C');
  assert.deepEqual(highlighter.list().map((h) => h.id), ['B', 'A', 'D']);
  assert.deepEqual(CREATED.map((h) => h.id), ['B', 'A', 'C', 'D']);
});

test('a highlight with no rects renders nothing and does not break the order', () => {
  for (const at of [0, 2, CREATED.length]) {
    setup([...CREATED.slice(0, at), hl('E', 1), ...CREATED.slice(at)]);
    assert.deepEqual(tabOrder(), READING, `E created at ${at}`);
  }
});

test('removing a focused highlight skips a neighbour with no rects: it has nothing to focus', () => {
  const highlighter = setup([...CREATED, hl('E', 1), hl('F', 2)]);
  document.querySelector('[data-hl-id="A"]').focus();
  highlighter.remove('A');
  assert.equal(focusedHl(), 'B');
});

console.log(`\n${failed ? 'FAILURES' : 'ALL GREEN'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

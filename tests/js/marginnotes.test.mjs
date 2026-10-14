// Harness for the margin layout (marginnotes.js, U8/U30): when the notes are placed. A render
// or a focus change places them before returning, so a key or a click in the same frame never
// measures a note that has not been put back beside its anchor; the frame after a focus change
// places them again, after the browser's own focus scroll of the column.
import { createMarginLayout } from '../../static/js/marginnotes.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

// Animation frames run only when `flush` says so; a cancelled one never does.
const frames = new Map();
let lastFrame = 0;
const cancelled = [];
globalThis.requestAnimationFrame = (fn) => { lastFrame += 1; frames.set(lastFrame, fn); return lastFrame; };
globalThis.cancelAnimationFrame = (id) => { cancelled.push(id); frames.delete(id); };
const flush = () => { const due = [...frames.values()]; frames.clear(); due.forEach((fn) => fn()); };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { activeElement: null };

const listeners = () => {
  const on = new Map();
  return {
    addEventListener: (t, fn) => on.set(t, [...(on.get(t) || []), fn]),
    removeEventListener: (t, fn) => on.set(t, (on.get(t) || []).filter((f) => f !== fn)),
    fire: (t) => (on.get(t) || []).forEach((fn) => fn({ type: t })),
  };
};

// Geometry: the column's top is at 100; page 2 spans 200..1200, so a note at y 0.5 wants 600
// in the viewport, which is 500 in the column.
const COLUMN_TOP = 100, PAGE_TOP = 200, PAGE_HEIGHT = 1000, NOTE_HEIGHT = 40, FOCUS_SCROLL_PX = 50;
const WANTED_TOP = `${PAGE_TOP + 0.5 * PAGE_HEIGHT - COLUMN_TOP}px`;
const note = { dataset: { page: '2', y: '0.5' }, style: { top: '' }, offsetHeight: NOTE_HEIGHT, contains: () => false };
const docEl = {
  ...listeners(), scrollTop: 0, clientHeight: 600,
  querySelectorAll: () => [note],
  getBoundingClientRect: () => ({ top: COLUMN_TOP }),
};
const scroller = { ...listeners(), clientHeight: 800, getBoundingClientRect: () => ({ top: 0 }) };
let pageTop = PAGE_TOP;
const pdfView = { pageWrapEl: () => ({ getBoundingClientRect: () => ({ top: pageTop, height: PAGE_HEIGHT }) }) };
let margin = true;
const layout = createMarginLayout({ docEl, scroller, pdfView, isMargin: () => margin });
// Frames still due run first, so none of them can place the note after it is cleared.
const reset = () => { flush(); note.style.top = ''; docEl.scrollTop = 0; cancelled.length = 0; };

console.log('\n1. schedule waits for the frame');
reset();
layout.schedule();
ok('   nothing is placed before the frame', note.style.top === '', note.style.top);
flush();
ok('   the frame places the note beside its anchor', note.style.top === WANTED_TOP, note.style.top);

console.log('\n2. now places before returning, and takes the pending frame\'s place');
reset();
layout.schedule();
const pending = lastFrame;
layout.now();
ok('   the note is placed straight away', note.style.top === WANTED_TOP, note.style.top);
ok('   the pending frame was cancelled', cancelled.includes(pending) && !frames.has(pending),
  JSON.stringify({ cancelled, pending: [...frames.keys()] }));
layout.schedule();
ok('   ... so a later schedule gets a frame of its own', frames.size === 1, String(frames.size));

console.log('\n3. a focus change places now, and again after the browser\'s focus scroll');
reset();
docEl.fire('focusin');
ok('   focusin places the note before returning', note.style.top === WANTED_TOP, note.style.top);
ok('   ... and asks for the next frame too', frames.size === 1, String(frames.size));
docEl.scrollTop = FOCUS_SCROLL_PX;   // what focus() does to an overflow-hidden column
flush();
ok('   that frame undoes the focus scroll of the column', docEl.scrollTop === 0, String(docEl.scrollTop));

console.log('\n4. out of the margin view, the notes flow');
reset();
layout.now();
margin = false;
layout.now();
ok('   now clears every top once isMargin says no', note.style.top === '', note.style.top);
margin = true;

console.log('\n5. R3: an anchor on screen but above the notes (behind the Highlights section)');
reset();
pageTop = COLUMN_TOP / 2 - 0.5 * PAGE_HEIGHT;   // the anchor is at 50: on screen, above the column's top
layout.now();
ok('   is drawn at the notes\' top edge, not clipped under the section', note.style.top === '0px', note.style.top);
pageTop = -COLUMN_TOP / 2 - 0.5 * PAGE_HEIGHT;  // the anchor is at -50: scrolled off the screen
layout.now();
ok('   one scrolled off the screen is still left off it', note.style.top === `${-COLUMN_TOP * 1.5}px`, note.style.top);
pageTop = PAGE_TOP;

layout.destroy();
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

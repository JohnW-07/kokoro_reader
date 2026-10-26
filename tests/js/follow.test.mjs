// Harness for static/js/follow.js (U28): the view follows the sentence being read, the
// reader's own scroll suspends that, Snap or a play jump resumes it, and a paper opens at
// its saved place. Plain fakes: a scroller box, a highlight rect and a pdfView that
// records the scrolls it is asked for. Run: node follow.test.mjs
import { createFollow, followBehavior, SMOOTH_BEHAVIOR, INSTANT_BEHAVIOR, RESTORE_BEHAVIOR, AUTO_RESUME_MS } from '../../static/js/follow.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const tick = () => new Promise((r) => setTimeout(r, 0));

const VIEW = { top: 0, bottom: 800, height: 800 };
const LINE = 14;

function fakeEl(parent = null) {
  const on = new Map();
  const el = {
    parentElement: parent,
    addEventListener: (t, fn) => on.set(t, [...(on.get(t) || []), fn]),
    contains: (node) => { for (let n = node; n; n = n.parentElement) if (n === el) return true; return false; },
    closest: (sel) => { for (let n = el; n; n = n.parentElement) if (n.id && sel === `#${n.id}`) return n; return null; },
    fire: (type, extra = {}, target = el) => {
      const ev = { type, target, defaultPrevented: false, ...extra };
      (on.get(type) || []).forEach((fn) => fn(ev));
    },
  };
  return el;
}

/** A scroller showing 0..800, a highlight line at `top`, a pdfView that records its scrolls. */
function setup({ top = 100, height = LINE, margin = true } = {}) {
  const doc = fakeEl();
  doc.body = fakeEl(doc);
  doc.activeElement = doc.body;
  const scroller = fakeEl(doc.body);
  Object.assign(scroller, { clientWidth: 600, clientHeight: 800, getBoundingClientRect: () => VIEW });
  const page = fakeEl(scroller);
  const status = Object.assign(fakeEl(scroller), { id: 'view-status' });
  const readout = fakeEl(status);
  const notes = fakeEl(doc.body);
  const editor = Object.assign(fakeEl(notes), { isContentEditable: true });
  const sidebarInput = Object.assign(fakeEl(doc.body), { tagName: 'INPUT' });
  const box = { top, height };
  const scrolls = [], renders = [], changes = [];
  let finishRender = null;
  // One highlight element per sentence, as pdfView's first .reading span is.
  const line = { getBoundingClientRect: () => ({ top: box.top, bottom: box.top + box.height, height: box.height }) };
  let current = { ...line };
  const pdfView = {
    readingEl: () => (box.top === null ? null : current),
    scrollToHighlight: (behavior) => scrolls.push(behavior),
    renderPage: (n) => { renders.push(n); return new Promise((r) => { finishRender = () => r(true); }); },
    layoutGeneration: () => env.layouts,
  };
  const env = { margin, layouts: 0, enabled: true, smooth: true, playing: true };
  // A fake clock: `timers` holds the one pending callback per handle; `run()` fires them all.
  const timers = new Map();
  let nextHandle = 0;
  const timer = {
    set: (fn, ms) => { timers.set(++nextHandle, { fn, ms }); return nextHandle; },
    clear: (h) => timers.delete(h),
  };
  const run = () => { const due = [...timers.values()]; timers.clear(); due.forEach((t) => t.fn()); };
  const follower = createFollow({
    scroller, pdfView, doc, notes, isMargin: () => env.margin, onChange: (active) => changes.push(active),
    isEnabled: () => env.enabled, isSmooth: () => env.smooth, isPlaying: () => env.playing, timer,
  });
  return {
    doc, scroller, page, readout, notes, editor, sidebarInput, box, scrolls, renders, changes, env, follower,
    timers, run,
    finish: () => finishRender?.(),
    next: (nextTop = box.top) => { box.top = nextTop; current = { ...line }; },   // the next sentence starts
  };
}

console.log('\n1. following scrolls only when the highlight has left the view');
{
  const t = setup({ top: 100 });
  t.follower.follow();
  ok('   a line on screen is left where it is', t.scrolls.length === 0, String(t.scrolls));
  t.next(900);
  t.follower.follow();
  ok('   a line below the view is brought back, smoothly', t.scrolls.length === 1 && t.scrolls[0] === SMOOTH_BEHAVIOR, String(t.scrolls));
  t.next(-50);
  t.follower.follow();
  ok('   a line above the view is brought back', t.scrolls.length === 2);
  t.next(VIEW.bottom - LINE / 2);
  t.follower.follow();
  ok('   a line cut by the bottom edge counts as gone', t.scrolls.length === 3);
  t.next(300);
  for (let i = 0; i < 5; i++) t.follower.follow();
  ok('   five sentences on screen cost no scroll at all', t.scrolls.length === 3, String(t.scrolls.length));
}
{
  const t = setup({ top: -200, height: 1100 });   // the page stands in while its spans paint
  t.follower.follow();
  ok('   a page taller than the view only has to show', t.scrolls.length === 0);
  t.next(1000);
  t.follower.follow();
  ok('   ... and is scrolled to once it is off screen', t.scrolls.length === 1);
  t.next(null);
  t.follower.follow();
  ok('   nothing to show (no document) is not a scroll', t.scrolls.length === 1);
}
{
  const t = setup({ top: 900 });
  t.follower.follow();
  t.follower.follow();                             // the smooth scroll has not landed yet
  ok('   one sentence costs one scroll, however often it is checked', t.scrolls.length === 1, String(t.scrolls.length));
  t.next(900);
  t.follower.follow();
  ok('   ... and the next sentence off screen gets its own', t.scrolls.length === 2, String(t.scrolls.length));
}
{
  // After a zoom drops the text layer, the page wrap stands in for the sentence and stays the
  // same element while its spans repaint (pdfView.readingEl): it was scrolled to at the old zoom.
  const t = setup({ top: 900, height: 1100 });
  t.follower.follow();
  t.follower.follow();
  ok('   (control) the page standing in costs one scroll at one zoom', t.scrolls.length === 1, String(t.scrolls.length));
  t.env.layouts += 1;                              // a zoom re-lays out the paper: the page is off screen again
  t.follower.follow();
  ok('   after a zoom the same page is brought back, not skipped as already shown', t.scrolls.length === 2, String(t.scrolls.length));
}
{
  const t = setup({ top: 900 });
  t.follower.follow();
  t.follower.snap();
  t.follower.follow();                             // Snap's own scroll has not landed yet
  ok('   Snap forgets what was shown: the next check scrolls again', t.scrolls.length === 3, String(t.scrolls.length));
  t.follower.restore();
  t.follower.follow();
  ok('   ... and so does opening a paper', t.scrolls.length === 4, String(t.scrolls.length));
}

console.log('\n2. the reader\'s own scroll suspends following; a programmatic one does not');
{
  const t = setup({ top: 900 });
  t.scroller.fire('scroll');                       // what follow, zoom and Snap all cause
  ok('   a scroll event alone does not suspend', t.follower.isActive() && t.changes.length === 0);
  t.follower.follow();
  t.scroller.fire('scroll');
  ok('   nor does following\'s own scroll', t.follower.isActive() && t.scrolls.length === 1);
  t.scroller.fire('wheel', { ctrlKey: true });
  ok('   a pinch (ctrl+wheel) is a zoom, not a scroll', t.follower.isActive());
  t.scroller.fire('wheel');
  ok('   a wheel suspends', !t.follower.isActive() && t.changes.join() === 'false', t.changes.join());
  t.follower.follow();
  ok('   ... and the next sentence no longer scrolls', t.scrolls.length === 1, String(t.scrolls.length));
}
{
  const cases = [
    ['a touch drag', (t) => t.scroller.fire('touchmove')],
    ['a press on the vertical scrollbar', (t) => t.scroller.fire('pointerdown', { offsetX: 600, offsetY: 300 }, t.scroller)],
    ['... on an overlay scrollbar (no layout width)', (t) => t.scroller.fire('pointerdown', { offsetX: 595, offsetY: 300 }, t.scroller)],
    ['... on the horizontal scrollbar', (t) => t.scroller.fire('pointerdown', { offsetX: 300, offsetY: 795 }, t.scroller)],
    ...['ArrowDown', 'ArrowUp', 'PageDown', 'Home', 'End'].map((code) =>
      [`${code} with the page focused`, (t) => t.doc.fire('keydown', { code }, t.doc.body)]),
    ['PageUp inside the scroller', (t) => t.doc.fire('keydown', { code: 'PageUp' }, t.page)],
  ];
  for (const [name, act] of cases) {
    const t = setup();
    act(t);
    ok(`   ${name} suspends`, !t.follower.isActive());
  }
  const keep = [
    ['a click on a page (a sentence, a highlight)', (t) => t.scroller.fire('pointerdown', { offsetX: 600, offsetY: 300 }, t.page)],
    ['a click on the gutter beside the pages', (t) => t.scroller.fire('pointerdown', { offsetX: 30, offsetY: 300 }, t.scroller)],
    ['a wheel over the readouts strip', (t) => t.scroller.fire('wheel', {}, t.readout)],
    ['ArrowDown while typing in the notes', (t) => t.doc.fire('keydown', { code: 'ArrowDown' }, t.notes)],
    ['ArrowRight (next sentence)', (t) => t.doc.fire('keydown', { code: 'ArrowRight' }, t.doc.body)],
    ['a key another handler already took', (t) => t.doc.fire('keydown', { code: 'End', defaultPrevented: true }, t.doc.body)],
  ];
  for (const [name, act] of keep) {
    const t = setup();
    act(t);
    ok(`   ${name} does not`, t.follower.isActive());
  }
}
{
  const t = setup({ top: 900 });
  t.doc.activeElement = t.editor;
  t.follower.follow();
  ok('   while the reader writes a margin note the paper holds still', t.scrolls.length === 0 && t.follower.isActive());
  t.doc.activeElement = t.doc.body;
  t.follower.follow();
  ok('   ... and catches up at the next sentence once they stop', t.scrolls.length === 1);
  t.next(900);
  t.doc.activeElement = t.sidebarInput;
  t.follower.follow();
  ok('   typing outside the notes (the sidebar) does not hold it', t.scrolls.length === 2, String(t.scrolls.length));
  t.next(900);
  t.doc.activeElement = t.notes;
  t.follower.follow();
  ok('   nor does focus in the notes without a caret', t.scrolls.length === 3, String(t.scrolls.length));
  t.next(900);
  t.env.margin = false;
  t.doc.activeElement = t.editor;
  t.follower.follow();
  ok('   in the sections view (notes not tied to the paper) it follows', t.scrolls.length === 4, String(t.scrolls.length));
  t.follower.suspend();
  ok('   an explicit suspend (a jump to a note) stops following', !t.follower.isActive());
}

console.log('\n3. Snap and a play jump resume following');
{
  const t = setup({ top: 100 });
  t.scroller.fire('wheel');
  t.follower.snap();
  ok('   Snap resumes', t.follower.isActive() && t.changes.join() === 'false,true', t.changes.join());
  ok('   ... and always scrolls, even to a line on screen', t.scrolls.length === 1 && t.scrolls[0] === SMOOTH_BEHAVIOR);
}
{
  const t = setup({ top: 900 });
  t.scroller.fire('wheel');
  t.follower.resume();
  ok('   a play or jump resumes', t.follower.isActive());
  ok('   ... and brings an off-screen line back once', t.scrolls.length === 1, String(t.scrolls.length));
  t.follower.resume();
  ok('   resuming again for the same sentence adds no scroll', t.scrolls.length === 1, String(t.scrolls.length));
}
{
  const t = setup({ top: 100 });
  t.scroller.fire('wheel');
  t.follower.resume();
  ok('   resuming with the line on screen does not scroll', t.follower.isActive() && t.scrolls.length === 0, String(t.scrolls));
  t.next(900);                                     // a zoom moved the line off screen
  t.follower.resume();
  ok('   resuming while still following checks the view once', t.scrolls.length === 1, String(t.scrolls.length));
}

console.log('\n4. a paper opens at its saved place: one scroll, no animation, no playback');
{
  const t = setup({ top: 5000 });
  t.scroller.fire('wheel');                        // left over from the previous paper
  t.follower.restore(41);
  ok('   opening resumes following', t.follower.isActive());
  ok('   the saved page is rendered before anything scrolls', t.renders.join() === '41' && t.scrolls.length === 0);
  t.finish();
  await tick();
  ok('   once it lands the view jumps there, once', t.scrolls.length === 1 && t.scrolls[0] === RESTORE_BEHAVIOR, String(t.scrolls));
  await tick();
  ok('   ... and only once', t.scrolls.length === 1);
}
{
  const t = setup({ top: 5000 });
  t.follower.restore(41);
  t.scroller.fire('wheel');
  t.finish();
  await tick();
  ok('   a reader who scrolls first is not yanked back', t.scrolls.length === 0);
}
{
  const t = setup({ top: 5000 });
  let current = true;
  t.follower.restore(41, () => current);
  current = false;                                 // a newer paper opened meanwhile
  t.finish();
  await tick();
  ok('   a superseded paper\'s restore never scrolls the new one', t.scrolls.length === 0);
}
{
  const t = setup({ top: 5000 });
  t.follower.restore();
  await tick();
  ok('   no saved place: nothing rendered, nothing scrolled', t.renders.length === 0 && t.scrolls.length === 0);
}

console.log('\n5. smooth scrolling is the reader\'s choice, not the OS\'s (N12)');
{
  // a11y.css turns the scroller's CSS smoothing off under Reduce Motion, so 'auto' jumped on
  // John's Mac. An explicit behaviour is not the CSS default: it is what the pref says.
  ok('   on: an explicit "smooth"', followBehavior(true) === 'smooth' && SMOOTH_BEHAVIOR === 'smooth');
  ok('   off: one step ("instant", not "auto", which would defer to the CSS and still glide)',
    followBehavior(false) === 'instant' && INSTANT_BEHAVIOR === 'instant');
  const t = setup({ top: 900 });
  t.env.smooth = false;
  t.follower.follow();
  t.follower.snap();
  ok('   with it off, following and Snap both jump', t.scrolls.join() === 'instant,instant', t.scrolls.join());
  t.env.smooth = true;
  t.next(900);
  t.follower.follow();
  ok('   the pref is read at each scroll, so a change applies at once', t.scrolls[2] === 'smooth', t.scrolls.join());
  ok('   restoring a saved place never animates', RESTORE_BEHAVIOR === 'instant', RESTORE_BEHAVIOR);
}

console.log('\n6. the follow switch (N12): off, the view stays where the reader put it');
{
  const t = setup({ top: 900 });
  t.env.enabled = false;
  t.follower.follow();
  t.follower.resume();
  ok('   off: neither a sentence nor a play or jump scrolls', t.scrolls.length === 0, String(t.scrolls));
  t.scroller.fire('wheel');
  ok('   ... and a wheel does not light Snap: there is no following to hold', t.changes.length === 0, t.changes.join());
  t.follower.snap();
  ok('   Snap still scrolls, once', t.scrolls.length === 1 && t.scrolls[0] === SMOOTH_BEHAVIOR, String(t.scrolls));
  t.next(900);
  t.follower.follow();
  ok('   ... and following does not take over after it', t.scrolls.length === 1, String(t.scrolls.length));
}
{
  const t = setup({ top: 900 });
  t.scroller.fire('wheel');
  t.env.enabled = false;
  t.follower.toggled();
  ok('   switching off while suspended clears Snap\'s cue and scrolls nothing',
    t.changes.join() === 'false,true' && t.scrolls.length === 0, `${t.changes.join()} / ${t.scrolls.length}`);
  t.env.enabled = true;
  t.follower.toggled();
  ok('   switching on brings the sentence being read into view, once', t.scrolls.length === 1, String(t.scrolls.length));
  t.follower.toggled();
  ok('   ... and not again for the same sentence', t.scrolls.length === 1, String(t.scrolls.length));
}
{
  const t = setup({ top: 900 });
  t.env.enabled = false;
  t.scroller.fire('wheel');
  t.env.enabled = true;
  t.follower.toggled();
  ok('   a wheel while off does not hold following once it is back on', t.follower.isActive() && t.scrolls.length === 1);
}
{
  const t = setup({ top: 5000 });
  t.env.enabled = false;
  t.follower.restore(41);
  t.finish();
  await tick();
  ok('   off: a paper still opens at its saved place (that is not following)', t.scrolls.join() === RESTORE_BEHAVIOR, t.scrolls.join());
}
{
  const t = setup({ top: 5000 });
  t.env.enabled = false;
  t.follower.restore(41);
  t.scroller.fire('wheel');
  t.finish();
  await tick();
  ok('   ... and a reader who scrolls first is still not yanked back', t.scrolls.length === 0, t.scrolls.join());
}

console.log('\n7. after the reader stops scrolling, following picks up again by itself (F1)');
{
  const t = setup({ top: 100 });
  t.scroller.fire('wheel');
  const [pending] = [...t.timers.values()];
  ok('   a wheel arms one auto-resume', t.timers.size === 1 && pending.ms === AUTO_RESUME_MS, `${t.timers.size} ${pending?.ms}`);
  t.next(900);                                     // reading moved off screen meanwhile
  t.run();
  ok('   once it fires, following is back on (Follow\'s cue clears)', t.follower.isActive() && t.changes.join() === 'false,true', t.changes.join());
  ok('   ... and the sentence being read is brought back', t.scrolls.length === 1, String(t.scrolls.length));
}
{
  const t = setup({ top: 100 });
  t.scroller.fire('wheel');
  const [first] = t.timers.keys();
  t.scroller.fire('scroll');                       // momentum: the page is still moving
  const [second] = t.timers.keys();
  ok('   a scroll while held re-arms rather than stacking timers', t.timers.size === 1 && second !== first, `${t.timers.size} ${first} ${second}`);
  t.scroller.fire('wheel');
  ok('   ... and so does another wheel', t.timers.size === 1, String(t.timers.size));
}
for (const [name, gesture] of [
  ['a touch drag', (t) => t.scroller.fire('touchmove')],
  ['a press on the scrollbar', (t) => t.scroller.fire('pointerdown', { offsetX: 595, offsetY: 10 })],
  ['a scroll key', (t) => t.doc.fire('keydown', { code: 'PageDown' }, t.doc.body)],
]) {
  const t = setup({ top: 100 });
  gesture(t);
  ok(`   ${name} also resumes by itself`, t.timers.size === 1 && (t.run(), t.follower.isActive()));
}
{
  const t = setup({ top: 100 });
  t.follower.suspend();                            // a jump to a highlight: the reader went to look
  t.scroller.fire('scroll');                       // ...and the jump scrolls the paper
  ok('   an explicit suspend (a jump to a note) does not resume by itself', t.timers.size === 0 && !t.follower.isActive());
}
{
  const t = setup({ top: 100 });
  t.scroller.fire('wheel');
  t.follower.suspend();                            // scrolled, then jumped to a note within the wait
  ok('   ... even when it lands while an auto-resume is pending', t.timers.size === 0, String(t.timers.size));
}
{
  const t = setup({ top: 100 });
  t.scroller.fire('scroll');
  ok('   a scroll while following arms nothing', t.timers.size === 0);
}
{
  const t = setup({ top: 100 });
  t.env.playing = false;
  t.scroller.fire('wheel');
  t.next(900);
  t.run();
  ok('   paused: the hold lifts but the view stays where the reader put it', t.follower.isActive() && t.scrolls.length === 0, t.scrolls.join());
}
for (const [name, act] of [['Follow (snap)', (f) => f.snap()], ['Play (resume)', (f) => f.resume()]]) {
  const t = setup({ top: 100 });
  t.scroller.fire('wheel');
  act(t.follower);
  ok(`   ${name} cancels the pending auto-resume`, t.timers.size === 0, String(t.timers.size));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

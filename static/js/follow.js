/**
 * follow.js — read-along: keep the sentence being read in view while playing.
 *
 * The view scrolls only once the highlight has left it, and only while following is on.
 * The reader's own scroll (wheel, touch drag, a press on the scrollbar, a scroll key)
 * suspends following; Follow (or F/S: R1), Play or a jump resumes it, and so does AUTO_RESUME_MS
 * of the paper holding still (F1: a trackpad reader scrolls often, and a hold that never lifted
 * read as "follow never works"). Detection reads input events, never `scroll` events, so the
 * scrolls this module, zoom, fit-width and `snap` cause are never mistaken for the reader's;
 * `scroll` events only postpone a pending auto-resume while the page is still moving (momentum).
 *
 * The follow switch (N12, `isEnabled`) turns following off altogether: the view then moves
 * only for `snap`, and a wheel suspends nothing, so Follow is not lit.
 *
 * Smooth scrolling (N12, `isSmooth`) is an explicit behaviour, not the CSS default: a11y.css
 * drops #content-area's `scroll-behavior: smooth` under prefers-reduced-motion, which made
 * every follow a jump on a Mac with Reduce Motion on. Restoring a saved place is always instant.
 *
 * Holding still while the reader types in the margin notes (decision D1): those notes
 * track the paper's scroll, so a follow scroll would move the note under their caret.
 */
import { isTypingTarget } from './layout.js';

export const SMOOTH_BEHAVIOR = 'smooth';
/** Not 'auto': that defers to the scroller's CSS, which glides wherever Reduce Motion is off. */
export const INSTANT_BEHAVIOR = 'instant';
export const RESTORE_BEHAVIOR = INSTANT_BEHAVIOR;

/** The behaviour follow, `snap` and a jump scroll with. */
export const followBehavior = (smooth) => (smooth ? SMOOTH_BEHAVIOR : INSTANT_BEHAVIOR);
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);
/** The readouts strip floats over the scroller; a wheel over it is not a scroll of the paper. */
const IGNORE_WHEEL_SELECTOR = '#view-status';
/** Overlay scrollbars (macOS) take no layout width, so a press this close to the edge counts. */
export const OVERLAY_SCROLLBAR_PX = 16;
/** How long the paper must hold still after the reader's own scroll before following picks up again. */
export const AUTO_RESUME_MS = 5000;

/** Whether a highlight box is visible enough: whole, or (taller than the view) at least partly. */
function inView(box, view) {
  if (box.height > view.height) return box.bottom > view.top && box.top < view.bottom;
  return box.top >= view.top && box.bottom <= view.bottom;
}

/** A press on the scroller's own box at its right or bottom edge: its scrollbar. */
function onScrollbar(e, el) {
  if (e.target !== el) return false;
  return e.offsetX >= el.clientWidth - OVERLAY_SCROLLBAR_PX
    || e.offsetY >= el.clientHeight - OVERLAY_SCROLLBAR_PX;
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.scroller the element that scrolls the paper (#content-area)
 * @param {{readingEl: Function, scrollToHighlight: Function, renderPage: Function, layoutGeneration?: Function}} deps.pdfView
 * @param {HTMLElement} [deps.notes] the notes column; typing in it holds the paper still
 * @param {() => boolean} [deps.isMargin] whether the notes sit beside the paper (margin mode)
 * @param {(following: boolean) => void} [deps.onChange] false while the reader's scroll holds a
 *   switched-on follow off: Follow's cue (followswitch.js)
 * @param {() => boolean} [deps.isEnabled] the follow switch
 * @param {() => boolean} [deps.isSmooth] the smooth-scrolling pref, read at each scroll
 * @param {() => boolean} [deps.isPlaying] whether the voice is reading: a paused auto-resume
 *   lifts the hold but leaves the view where the reader put it
 * @param {{set: Function, clear: Function}} [deps.timer] setTimeout/clearTimeout, injectable
 */
export function createFollow({
  scroller, pdfView, notes = null, isMargin = () => false, onChange = () => {}, doc = document,
  isEnabled = () => true, isSmooth = () => true, isPlaying = () => true,
  timer = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
}) {
  let active = true;    // not suspended by the reader's own scroll
  let reported = true;  // what onChange last said: following, or switched off (nothing held)
  let shownEl = null;   // the highlight last scrolled to: a smooth scroll is still under way
  // ...and the layout it was scrolled to in. A zoom keeps the page wrap that stands in for the
  // sentence while its spans repaint, but moves it: in a new layout it is not shown any more.
  // Not the scale: a zoom and back, or a follow mid-relayout, ends on the scale it began at.
  let shownLayout = null;
  let resumeTimer = null;  // pending auto-resume after the reader's own scroll (F1)

  function report() {
    const next = active || !isEnabled();
    if (next === reported) return;
    reported = next;
    onChange(next);
  }
  function setActive(next) {
    if (next) cancelAutoResume();
    active = next;
    report();
  }
  function cancelAutoResume() {
    if (resumeTimer !== null) timer.clear(resumeTimer);
    resumeTimer = null;
  }
  function armAutoResume() {
    cancelAutoResume();
    resumeTimer = timer.set(autoResume, AUTO_RESUME_MS);
  }
  function autoResume() {
    resumeTimer = null;
    setActive(true);
    if (isPlaying()) follow();
  }
  const scroll = () => pdfView.scrollToHighlight(followBehavior(isSmooth()));
  const suspend = () => { cancelAutoResume(); shownEl = null; setActive(false); };
  /** The reader's own scroll: hold still, and pick up again once the paper stops moving. */
  const readerScrolled = () => { suspend(); armAutoResume(); };
  const isWriting = () => {
    const el = doc.activeElement;
    return Boolean(notes && isMargin() && notes.contains(el) && isTypingTarget(el));
  };

  /** Bring the highlight back if it has left the view (no-op while suspended). */
  function follow() {
    if (!active || !isEnabled() || isWriting()) return;
    const el = pdfView.readingEl();
    const layout = pdfView.layoutGeneration?.();
    if (!el || (el === shownEl && layout === shownLayout)
      || inView(el.getBoundingClientRect(), scroller.getBoundingClientRect())) return;
    shownEl = el;
    shownLayout = layout;
    scroll();
  }

  /** Play or a jump: follow again, and check the view once now. */
  function resume() {
    setActive(true);
    follow();
  }

  /** Snap (R1: the Follow switch, switched on or pressed while lit): follow again and always centre the highlight. */
  function snap() {
    setActive(true);
    shownEl = null;
    scroll();
  }

  /** The follow switch flipped: on picks up the sentence being read, off clears Follow's cue. */
  function toggled() {
    if (isEnabled()) resume();
    else report();
  }

  /**
   * Opening a paper: follow again and, given a saved page, jump there once it renders,
   * unless the reader scrolled first or a newer paper replaced this one (`isCurrent`).
   */
  function restore(page, isCurrent = () => true) {
    shownEl = null;
    setActive(true);
    if (!page) return;
    pdfView.renderPage(page).then(() => {
      if (active && isCurrent()) pdfView.scrollToHighlight(RESTORE_BEHAVIOR);
    });
  }

  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.target?.closest?.(IGNORE_WHEEL_SELECTOR)) readerScrolled();
  }, { passive: true });
  scroller.addEventListener('touchmove', readerScrolled, { passive: true });
  scroller.addEventListener('pointerdown', (e) => { if (onScrollbar(e, scroller)) readerScrolled(); });
  scroller.addEventListener('scroll', () => { if (resumeTimer !== null) armAutoResume(); }, { passive: true });
  doc.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !SCROLL_KEYS.has(e.code)) return;
    if (e.target === doc.body || scroller.contains(e.target)) readerScrolled();
  });

  return { follow, resume, snap, restore, suspend, toggled, isActive: () => active };
}

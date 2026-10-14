/**
 * marginnotes.js — the notes column, laid out beside the paper (U8).
 *
 * `anchors.js` says where a note belongs in the *paper*; this file is the only
 * place that turns that into a pixel. Each `.ne-note` carries the page and the
 * 0..1 y it is pinned to, so the desired top is read straight off the page's
 * current client rect: zoom, a resize and a collapsed sidebar all move the page
 * box and the note follows it with no anchor maths of its own.
 *
 * Everything happens in one pass (a rAF, or `now` after a render) — every rect and
 * offset read first, every `top` written after — so a scroll costs one layout, and
 * the notes are measured after the scroll and before the paint that shows it.
 */

import { cleanAnchor, stackTops } from './anchors.js';

const NOTE_SELECTOR = '.ne-note';
const ROW_SELECTOR = '.ne-block';
/** How far down the viewport "what is being read" sits — pdfview's page anchor. */
const READING_RATIO = 0.35;

/**
 * Where the reader is looking: the current page and how far down it (D1). This is
 * the anchor a note gets when it was not made from a highlight.
 * @returns {{page:number, y:number, hl:string}|null}
 */
export function readingAnchor(scroller, pdfView) {
  const page = pdfView?.currentPage?.();
  const wrap = pdfView?.pageWrapEl?.(page);
  if (!scroller || !wrap) return null;
  const box = wrap.getBoundingClientRect();
  if (!(box.height > 0)) return null;
  const mark = scroller.getBoundingClientRect().top + scroller.clientHeight * READING_RATIO;
  return cleanAnchor({ page, y: (mark - box.top) / box.height });
}

/**
 * Keep the notes beside their anchors.
 * @param {object} deps
 * @param {HTMLElement} deps.docEl       the editor's document surface
 * @param {HTMLElement} deps.scroller    the element the pages scroll in
 * @param {HTMLElement} [deps.pages]     the pages container, watched for resizes
 * @param {object} deps.pdfView
 * @param {() => boolean} deps.isMargin  false while the section view is showing
 * @returns {{schedule: () => void, now: () => void, destroy: () => void}}
 */
export function createMarginLayout({ docEl, scroller, pages, pdfView, isMargin }) {
  if (!docEl || !scroller) throw new Error('createMarginLayout requires docEl and scroller');
  let frame = 0;
  // Typing holds the row being written on screen; scrolling the paper hands the column
  // straight back to it. Without the second half a caret left in a note would peg that
  // note to the edge of the column and it would stop riding the paper, which is the one
  // thing U8 is for: the reader scrolling is the reader looking somewhere else.
  let holdCaret = false;

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; place(); });
  }

  /**
   * Place the notes before returning. A render leaves every note at the column's top and
   * focus lands in a row straight after it; a key that arrives before the next frame (a
   * `/` opening the menu) would otherwise measure itself against that stale layout.
   */
  function now() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    place();
  }

  function place() {
    const notes = [...docEl.querySelectorAll(NOTE_SELECTOR)];
    if (!notes.length) return;
    if (!isMargin()) {
      for (const note of notes) note.style.top = '';
      return;
    }
    const top = docEl.getBoundingClientRect().top;
    const wanted = notes.map((note) => ({
      note,
      desired: shownTop(desiredTop(note), top) - top,
      height: note.offsetHeight,
    }));
    const tops = stackTops(wanted);
    const shift = holdCaret ? caretShift(wanted, tops, docEl.clientHeight) : 0;
    // Writes only, from here down. The browser scrolls even an `overflow: hidden` box
    // to bring the focused row into view; the notes are placed against the viewport, so
    // any scroll of the column's own box moves every one of them off its anchor.
    docEl.scrollTop = 0;
    wanted.forEach((entry, i) => {
      entry.note.style.top = `${Math.round(tops[i] + shift)}px`;
    });
  }

  /**
   * How far the whole column slides so that the row being typed in stays in it.
   *
   * A caret in a row means the reader is writing *there, now*, so that row being on screen
   * is a floor, not a preference: a note pinned near the top of a page runs off the bottom
   * of the column as it grows, and a note carried on after scrolling down the same page is
   * dragged off the top by its anchor -- both leave the reader typing blind.
   *
   * The stack moves as one and in whichever direction the caret needs, which is what makes
   * it impossible for this to push one note over another; per-note nudging is what did.
   * The move is transient: nothing is re-anchored, and the moment the reader scrolls the
   * paper or focus leaves the column every note is drawn at its own anchor again.
   */
  function caretShift(wanted, tops, room) {
    const row = document.activeElement?.closest?.(ROW_SELECTOR);
    if (!row) return 0;
    const i = wanted.findIndex((entry) => entry.note.contains(row));
    if (i < 0) return 0;
    const top = tops[i] + row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < 0 && bottom <= room) return -top;
    if (bottom > room && top >= 0) return room - bottom;
    // Already inside, or a row taller than the whole column and already filling it: there
    // is no position that shows more of it than the one it is in.
    return 0;
  }

  /**
   * R3: the Highlights section heads the same column, so an anchor can be on screen yet above
   * the notes. Such a note is drawn at their top edge, not clipped under the section; one
   * whose anchor has scrolled off the screen stays off it.
   */
  const shownTop = (anchor, columnTop) => (anchor >= 0 && anchor < columnTop ? columnTop : anchor);

  /** The note's anchor in client coords; a note pinned to nothing stays at the top. */
  function desiredTop(note) {
    const page = Number(note.dataset.page);
    const box = page ? pdfView?.pageWrapEl?.(page)?.getBoundingClientRect() : null;
    if (!box) return docEl.getBoundingClientRect().top;
    return box.top + (Number(note.dataset.y) || 0) * box.height;
  }

  const hold = () => { holdCaret = true; schedule(); };
  const release = () => { holdCaret = false; schedule(); };
  // `focusin` comes before the browser's own scroll of the column to the focused row, which
  // `place` undoes: so place now, for a key in this frame, and again in the next.
  const focused = () => { now(); schedule(); };

  // Scroll moves the pages under the notes; a resize of the pages covers zoom,
  // the window and the sidebar, all of which change the page box and nothing else.
  scroller.addEventListener('scroll', release, { passive: true });
  window.addEventListener('resize', schedule);
  // Typing grows the note under the caret, and the caret moves between notes without
  // either of them being re-rendered; both change what `caretShift` has to keep in view.
  // Clicking into a row is not writing in it, so only `input` takes the column.
  docEl.addEventListener('input', hold);
  docEl.addEventListener('focusin', focused);
  docEl.addEventListener('focusout', release);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  if (observer && pages) observer.observe(pages);
  // The column itself changes width when the sidebar collapses, which re-wraps every
  // note. Writing `top` on absolutely positioned children cannot resize it back.
  if (observer) observer.observe(docEl);

  return {
    schedule,
    now,
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      scroller.removeEventListener('scroll', release);
      window.removeEventListener('resize', schedule);
      docEl.removeEventListener('input', hold);
      docEl.removeEventListener('focusin', focused);
      docEl.removeEventListener('focusout', release);
      observer?.disconnect();
    },
  };
}

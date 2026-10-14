// ── Layout: collapsible sidebar, the floating rail, fit-to-width pages ───────
// The rail owns no playback behaviour. Each of its buttons either forwards a
// click to its sidebar twin (`data-proxy`) or steps the sidebar's speed slider,
// so every control still runs the one handler main.js bound.

export const SIDEBAR_SHORTCUT = 'KeyB';
export const NOTES_SHORTCUT = 'KeyN';
export const SPEED_PRESETS = Object.freeze([0.75, 1, 1.25, 1.5, 1.75, 2]);
const FIT_DEBOUNCE_MS = 150;
const SCALE_PRECISION = 100;      // scales are compared at two decimals, so a 1px resize is a no-op
const MIN_FIT_SCALE = 0.6;        // below this a Letter page is unreadable; scroll instead
const PAGE_RECT_FLOOR_PX = 1;

/** Up to this window width both panels fold (N13): half a 1512 pt screen is 756. */
export const NARROW_MAX_WIDTH_PX = 900;
export const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH_PX}px)`;

const EDITABLE_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

/** True when a key event belongs to a text field rather than to the reader. */
export function isTypingTarget(target) {
  return Boolean(target && (EDITABLE_TAGS.has(target.tagName) || target.isContentEditable));
}

/** The first preset above `speed`, wrapping to the slowest. */
export function nextSpeed(speed, presets = SPEED_PRESETS) {
  return presets.find((p) => p > speed + Number.EPSILON) ?? presets[0];
}

/**
 * The page scale that fits `availablePx` of width, never above `maxScale`.
 * @param {number} availablePx  inner width of the page column
 * @param {number} unitWidthPx  page width at scale 1
 * @param {number} maxScale
 * @returns {number|null} null when either width is unknown
 */
export function fitScale(availablePx, unitWidthPx, maxScale) {
  if (!(availablePx > 0) || !(unitWidthPx > 0)) return null;
  const raw = Math.min(maxScale, Math.max(MIN_FIT_SCALE, availablePx / unitWidthPx));
  return Math.floor(raw * SCALE_PRECISION) / SCALE_PRECISION;
}

/**
 * The scroll offset that puts a held point of a page back under `anchorPx`, where the page
 * now starts at `pageStart` in the scroller's box and the point sits `fraction` into it.
 * `anchorPx` 0 pins the top edge (a window resize), half the viewport pins the middle (⌘+),
 * the pointer's offset pins what is under the fingers (pinch).
 *
 * Anchored to a page rather than to the scroll height: the gaps between pages and the
 * column's padding do not scale with the zoom, so a plain scrollHeight ratio drifts by one
 * gap for every page above the anchor — a page deep into a paper lands well off.
 */
export function anchoredOffset(offset, anchorPx, pageStart, pageSize, fraction) {
  if (!(pageSize > 0)) return offset;
  return Math.max(0, offset + pageStart + fraction * pageSize - anchorPx);
}

/** Speed label shared by the slider readout and the rail button: 1.25×, 1×. */
export function formatSpeed(speed) {
  return `${speed.toFixed(2).replace(/\.?0+$/, '')}×`;
}

/**
 * Reflect the collapsed state in the DOM. Hidden chrome is `inert`, so it leaves
 * the tab order and cannot be clicked while it animates out.
 */
export function applyCollapsed(collapsed, doc = document) {
  const sidebar = doc.getElementById('sidebar');
  const rail = doc.getElementById('rail');
  doc.body.classList.toggle('sidebar-collapsed', collapsed);
  if (sidebar) sidebar.inert = collapsed;
  if (rail) rail.inert = !collapsed;
  doc.getElementById('collapseBtn')?.setAttribute('aria-expanded', String(!collapsed));
  doc.getElementById('expandBtn')?.setAttribute('aria-expanded', String(!collapsed));
}

/**
 * The same contract for the notes column: hidden chrome is `inert`, and the DOM says
 * which state it is in. There is no twin to swap to — the handle lives outside the
 * column and stays put — so the one button carries both labels.
 */
export function applyNotesCollapsed(collapsed, doc = document) {
  const notes = doc.getElementById('notes-column');
  doc.body.classList.toggle('notes-collapsed', collapsed);
  if (notes) notes.inert = collapsed;
  const toggle = doc.getElementById('notesToggleBtn');
  if (!toggle) return;
  const label = collapsed ? 'Show notes' : 'Hide notes';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('title', `${label} (N)`);
}

/**
 * The sidebar and the notes column, shown or folded. A narrow window (N13: a half-screen
 * snap) folds both in the DOM only, and a fold or unfold made while it is narrow is for now
 * only: neither reaches the saved prefs, which come back once the window is wide again.
 * Toggles read what is on screen, not the prefs, which a narrow window overrides.
 * @param {{ state: object, media?: MediaQueryList }} deps
 */
export function createPanels({ state, media = matchMedia(NARROW_QUERY), doc = document }) {
  const isNarrow = () => media.matches;
  const shown = (cls) => !doc.body.classList.contains(cls);
  function remember(patch) {
    if (isNarrow()) return;
    state.set(patch);
    state.savePrefs();
  }

  function setSidebarCollapsed(collapsed) {
    remember({ sidebarCollapsed: collapsed });
    applyCollapsed(collapsed, doc);
    // Keyboard focus follows the control that replaces the one just hidden.
    const target = doc.getElementById(collapsed ? 'expandBtn' : 'collapseBtn');
    if (doc.activeElement && doc.activeElement !== doc.body) target?.focus();
  }

  /**
   * Collapsing hands the notes column's width to the PDF. The re-fit is left to the
   * ResizeObserver in createFitWidth: the column floats, so the document area resizes in one
   * step and the observer's debounce coalesces that into a single fit.
   */
  function setNotesCollapsed(collapsed) {
    remember({ notesCollapsed: collapsed });
    // Read before `inert` blurs whatever was focused inside the column.
    const hadFocus = doc.getElementById('notes-column')?.contains(doc.activeElement);
    applyNotesCollapsed(collapsed, doc);
    if (hadFocus) doc.getElementById('notesToggleBtn')?.focus();
  }

  function showSaved() {
    const { sidebarCollapsed, notesCollapsed } = state.get();
    applyCollapsed(isNarrow() || sidebarCollapsed, doc);
    applyNotesCollapsed(isNarrow() || notesCollapsed, doc);
  }
  media.addEventListener('change', showSaved);
  showSaved();

  return {
    setSidebarCollapsed,
    toggleSidebar: () => setSidebarCollapsed(shown('sidebar-collapsed')),
    toggleNotes: () => setNotesCollapsed(shown('notes-collapsed')),
    isNarrow,
  };
}

/**
 * Wire the rail's buttons.
 * @param {{onExpand:() => void, getSpeed:() => number}} deps
 */
export function bindRail({ onExpand, getSpeed }, doc = document) {
  const rail = doc.getElementById('rail');
  if (!rail) throw new Error('bindRail: #rail is missing from the page');
  rail.addEventListener('click', (e) => {
    const button = e.target.closest?.('button');
    if (!button || button.disabled) return;
    if (button.dataset.action === 'expand') return onExpand();
    if (button.dataset.action === 'speed') return stepSpeed(doc, getSpeed());
    const twin = button.dataset.proxy && doc.getElementById(button.dataset.proxy);
    if (twin && !twin.disabled) twin.click();
  });
}

/** Drive the sidebar slider exactly as a drag would: `input`, then `change`. */
function stepSpeed(doc, speed) {
  const slider = doc.getElementById('speedSlider');
  if (!slider) return;
  slider.value = String(nextSpeed(speed));
  for (const type of ['input', 'change']) slider.dispatchEvent(new Event(type, { bubbles: true }));
}

const TOP = 'top';   // a resize keeps the top edge's content, as it always has

/** The point a re-layout keeps still, as an offset into the scroller's box. */
function anchorPoint(scroller, anchor) {
  const box = scroller.getBoundingClientRect();
  if (anchor === TOP) return { x: 0, y: 0 };
  if (!anchor) return { x: box.width / 2, y: box.height / 2 };
  return { x: anchor.x - box.left, y: anchor.y - box.top };
}

/** The page under `point` and how far into it the point sits, as fractions of its box. */
function holdAt(scroller, pdfView, point) {
  const box = scroller.getBoundingClientRect();
  for (let n = 1; n <= pdfView.numPages(); n += 1) {
    const wrap = pdfView.pageWrapEl(n);
    if (!wrap) continue;
    const rect = wrap.getBoundingClientRect();
    if (!(rect.height > 0) || rect.bottom - box.top < point.y) continue;
    return {
      page: n,
      y: (point.y - (rect.top - box.top)) / rect.height,
      x: (point.x - (rect.left - box.left)) / rect.width,
    };
  }
  return null;
}

/**
 * Keep pages as wide as their column allows, up to the view's default scale,
 * times the user's zoom. Re-fits when the column resizes (window resize, sidebar
 * collapse) and keeps the same content in view across the re-layout.
 * @param {() => number} [opts.getZoom] 1 is fit-width; see zoom.js.
 */
export function createFitWidth({ scroller, pdfView, maxScale, getZoom = () => 1 }) {
  let timer = 0;
  let running = Promise.resolve();

  async function fit(anchor) {
    const rect = pdfView.pageRect(1);
    const current = pdfView.scale();
    const style = getComputedStyle(scroller);
    const inner = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    // pageRect floors its width; add the pixel back so the fitted page never overflows.
    const base = fitScale(inner, (rect.width + PAGE_RECT_FLOOR_PX) / current, maxScale);
    if (base === null) return;
    const next = Math.floor(base * getZoom() * SCALE_PRECISION) / SCALE_PRECISION;
    if (!(next > 0) || next === current) return;
    const point = anchorPoint(scroller, anchor);
    const held = holdAt(scroller, pdfView, point);
    await pdfView.setScale(next);
    const wrap = held && pdfView.pageWrapEl(held.page);
    if (!wrap) return;
    // Measured after the re-layout, so whatever the browser did with the scroll position
    // while the pages resized is already accounted for.
    const box = scroller.getBoundingClientRect();
    const pageBox = wrap.getBoundingClientRect();
    scroller.scrollTo({
      top: anchoredOffset(scroller.scrollTop, point.y, pageBox.top - box.top, pageBox.height, held.y),
      left: anchoredOffset(scroller.scrollLeft, point.x, pageBox.left - box.left, pageBox.width, held.x),
      behavior: 'instant',
    });
  }

  // Serialised: a second resize waits for the first re-layout instead of racing it.
  // Coalesced: only the newest request survives the wait. A fit queued behind a running
  // one is stale by the time its turn comes -- the zoom has already moved past it -- so
  // replaying the backlog would re-lay out the whole document once per held-down ⌘+.
  let queued = null;
  const enqueue = (anchor) => {
    queued = { anchor };
    running = running
      .then(() => { const next = queued; queued = null; return next && fit(next.anchor); })
      .catch((err) => console.warn('[layout] fit to width failed', err));
    return running;
  };

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => enqueue(TOP), FIT_DEBOUNCE_MS);
  }

  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(scroller);
  else window.addEventListener('resize', schedule);

  return {
    schedule,
    fitNow: () => enqueue(TOP),
    /** Re-fit at the current zoom, holding `anchor` (a client point, or null for the centre). */
    zoomTo: (anchor) => enqueue(anchor),
  };
}

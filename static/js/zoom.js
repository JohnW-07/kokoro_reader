// ── Zoom: ⌘+ / ⌘− / ⌘0, trackpad pinch, and the zoom pill ───────────────────
// Pure helpers first (unit-tested in Node), then the one DOM binder.
//
// WHAT 100% MEANS: fit-to-width. The zoom level is a multiplier on the fit-width
// scale layout.js computes, so 100% is exactly the reader's long-standing default —
// the page as wide as its column, capped at the view's 1.4× scale. "Actual size"
// would be the other candidate baseline and is the wrong one here: the column is
// narrower than a Letter page in most windows, so 100% would mean "wider than you
// can see" and the app would open zoomed. The pill's title says so in words.
//
// The level is a *preference*, not a document property: it persists through
// state.savePrefs (see state.js) and applies to the next paper you open.

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
/** Familiar browser steps, with fit-width (1) on the ladder. */
export const ZOOM_STEPS = Object.freeze([0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3]);
export const ZOOM_FIT = 1;

const STEP_EPSILON = 1e-3;         // 0.67 must not count as "above 0.67" for itself
const PINCH_GAIN = 0.01;           // 1% of zoom per wheel unit: ~Chrome's pinch feel
// A trackpad pinch arrives as a stream of small deltas; a mouse wheel notch arrives as one
// huge one (deltaY -120 is exp(1.2) = 3.3x, the entire ladder in a single notch, and the
// desktop webview's line-unit notch is 1.5x). Cap what ONE event may do rather than lowering
// the gain, which would flatten the trackpad path the gain is tuned for.
const PINCH_MAX_STEP = 1.1;        // at most +-10% of the current zoom per wheel event
const ZOOM_PRECISION = 100;        // pinch lands on whole percents, so the label is stable
const PERCENT = 100;

/** Zoom keys by `KeyboardEvent.code`: +1 in, −1 out, 0 back to fit-width. */
const ZOOM_KEYS = Object.freeze({
  Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Digit0: 0, Numpad0: 0,
});

export const clampZoom = (zoom) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(zoom) || ZOOM_FIT));

/** The next step above (`direction` > 0) or below the current zoom; the bound when there is none. */
export function stepZoom(zoom, direction) {
  const from = clampZoom(zoom);
  if (direction > 0) return ZOOM_STEPS.find((s) => s > from + STEP_EPSILON) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((s) => s < from - STEP_EPSILON) ?? ZOOM_MIN;
}

/** The pill's readout: "100%", "250%". */
export const formatZoom = (zoom) => `${Math.round(clampZoom(zoom) * PERCENT)}%`;

/**
 * Zoom after one pinch event. Exponential, so a pinch of the same size moves the
 * page by the same *proportion* at 50% as at 300%.
 * @param {number} deltaY  the ctrl-wheel delta the trackpad reports
 */
export function pinchZoom(zoom, deltaY) {
  const step = Math.exp(-(Number(deltaY) || 0) * PINCH_GAIN);
  const capped = Math.min(PINCH_MAX_STEP, Math.max(1 / PINCH_MAX_STEP, step));
  // Clamped before rounding: a hard pinch rounds to 0, which is not a zoom level.
  return Math.round(clampZoom(clampZoom(zoom) * capped) * ZOOM_PRECISION) / ZOOM_PRECISION;
}

/**
 * The zoom a ⌘/Ctrl shortcut asks for, or `null` when the event is not one.
 * Modifier-based, so it can never collide with the reader's bare-key shortcuts
 * (Space/←/→/S/R/B, which main.js drops on any modifier) and is safe to honour
 * while the caret is in the notes editor, where these keys mean nothing.
 */
export function zoomFromKey(event, zoom) {
  if (!isZoomKey(event)) return null;
  const direction = ZOOM_KEYS[event.code];
  return direction === 0 ? ZOOM_FIT : stepZoom(zoom, direction);
}

/** Is this keydown one of the ⌘/Ctrl chords `zoomFromKey` answers? */
export const isZoomKey = (event) => Boolean(event && (event.metaKey || event.ctrlKey) && !event.altKey
  && Object.hasOwn(ZOOM_KEYS, event.code));

/**
 * Wire the zoom pill, the ⌘ shortcuts and trackpad pinch.
 *
 * @param {HTMLElement} opts.scroller     the element pinch is read on (#content-area)
 * @param {() => number} opts.getZoom
 * @param {() => boolean} opts.hasDocument is there anything to zoom
 * @param {(zoom:number, anchor:{x:number,y:number}|null) => void} opts.onZoom
 *        `anchor` is the client point to keep still — null means the viewport centre.
 */
export function createZoom({ scroller, getZoom, hasDocument, onZoom, doc = document }) {
  const pill = doc.getElementById('zoom-pill');
  const label = doc.getElementById('zoomLevel');
  const button = (action) => pill && pill.querySelector(`[data-zoom="${action}"]`);

  function refresh() {
    const zoom = clampZoom(getZoom());
    if (label) label.textContent = formatZoom(zoom);
    const out = button('out');
    const into = button('in');
    if (out) out.disabled = zoom <= ZOOM_MIN;
    if (into) into.disabled = zoom >= ZOOM_MAX;
    if (pill) pill.hidden = !hasDocument();
  }

  function apply(next, anchor) {
    const zoom = clampZoom(next);
    if (zoom === clampZoom(getZoom())) return;
    onZoom(zoom, anchor || null);
    refresh();
  }

  if (pill) {
    pill.addEventListener('click', (e) => {
      const action = e.target.closest?.('[data-zoom]')?.dataset.zoom;
      if (!action) return;
      if (action === 'fit') return apply(ZOOM_FIT, null);
      apply(stepZoom(getZoom(), action === 'in' ? 1 : -1), null);
    });
  }

  doc.addEventListener('keydown', (e) => {
    const next = zoomFromKey(e, getZoom());
    if (next === null) return;
    // Claimed even when it changes nothing, so the browser/webview does not zoom
    // its own chrome out from under a reader already at 50% or 300%.
    e.preventDefault();
    // Guarded after the claim, exactly as the pinch path below is: with no paper
    // open there is nothing to zoom and the pill that would report it is hidden.
    if (!hasDocument()) return;
    apply(next, null);
  });

  // A trackpad pinch arrives as a wheel event with ctrlKey set. Not passive: the
  // default action is the webview's own page zoom, which would scale the chrome too.
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!hasDocument()) return;
    apply(pinchZoom(getZoom(), e.deltaY), { x: e.clientX, y: e.clientY });
  }, { passive: false });

  refresh();
  return { refresh };
}

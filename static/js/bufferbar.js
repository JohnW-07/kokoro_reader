// ── Buffer meter (N1) ────────────────────────────────────────────────────────
// A thin line along the bottom edge of the status field (R4), like a video's
// buffered range: how many of the
// sentences the player prefetches after the cursor already have audio. The client
// never holds more than a few ahead, so a whole-document bar would always read ~0.
// While /api/health says the model is not loaded yet (it loads lazily on the first
// /api/tts) and work is waiting, it shows an indeterminate "Loading voice model…".
// With no script there is nothing to buffer, so it hides rather than read "all ready".
// Dependency-free: everything arrives through the factory options.

export const LOADING_TEXT = 'Loading voice model…';
export const HEALTH_POLL_MS = 1000;

const MODEL_UNKNOWN = 'unknown';
const MODEL_LOADING = 'loading';
const MODEL_READY = 'ready';

/**
 * What the bar shows. Pure.
 * @param {{ ready: number, want: number, isLoading: boolean }} v
 * @returns {{ fraction: number, isLoading: boolean, valueText: string }}
 */
export function bufferView({ ready, want, isLoading }) {
  if (isLoading) return { fraction: 0, isLoading: true, valueText: LOADING_TEXT };
  const fraction = want > 0 ? Math.min(ready / want, 1) : 1;
  return { fraction, isLoading: false, valueText: `${ready} of ${want} upcoming sentences ready` };
}

/**
 * Bind the meter to a ttsclient. A no-op without its markup.
 * @param {object} deps
 * @param {HTMLElement|null} deps.root   #bufferbar (role="progressbar")
 * @param {object}   deps.tts            createTtsClient() instance
 * @param {() => Promise<{tts_ready?: boolean}>} deps.health  api.health
 * @param {number}   deps.ahead          the player's prefetch depth (PRELOAD_AHEAD)
 * @param {{ get: () => object, subscribe: (fn: () => void) => void }} deps.state
 *        state.js: the cursor (`index`), the script and voice/speed; a change re-renders,
 *        so a paused jump or a new document moves the meter without any audio event.
 * @param {(s: object) => string} deps.voiceOf  the voice actually requested (ttsVoice)
 * @param {(fn: () => void, ms: number) => void} [deps.timer]  setTimeout, injectable
 * @returns {{ refresh: () => void }}
 */
export function createBufferBar({ root, tts, health, ahead, state, voiceOf, timer = setTimeout }) {
  if (!root) return { refresh() {} };
  const part = (tag, className) => Object.assign(document.createElement(tag), { className });
  const track = part('div', 'bufferbar-track');
  const fill = part('div', 'bufferbar-fill');
  const label = part('span', 'bufferbar-label');
  track.append(fill);
  root.append(track, label);

  let model = MODEL_UNKNOWN;
  let isProbing = false;
  let hasAudio = false;          // a stored sentence proves the engine is up, whatever health said
  let shown = '';

  const isWaiting = () => {
    const { inflight, queued } = tts.stats();
    return inflight + queued > 0;
  };

  function render(view, want, ready) {
    const key = `${view.fraction}|${view.isLoading}|${want}|${ready}`;
    if (key === shown) return;
    shown = key;
    root.classList.toggle('is-loading', view.isLoading);
    fill.style.transform = view.isLoading ? '' : `scaleX(${view.fraction})`;   // loading: the stylesheet animates it
    label.textContent = view.isLoading ? LOADING_TEXT : '';
    root.setAttribute('aria-valuemax', want);
    root.setAttribute('aria-valuetext', view.valueText);
    root.title = view.valueText;
    if (view.isLoading) root.removeAttribute('aria-valuenow');
    else root.setAttribute('aria-valuenow', ready);
  }

  function refresh() {
    const s = state.get();
    root.hidden = s.sentences.length === 0;
    const want = Math.max(0, Math.min(ahead, s.sentences.length - s.index - 1));
    const ready = tts.readyAhead(s.index, want, voiceOf(s), s.speed);
    const isLoading = model === MODEL_LOADING && !hasAudio && isWaiting();
    render(bufferView({ ready, want, isLoading }), want, ready);
  }

  /** Ask health only while it matters: model state unknown or loading, and work waiting. */
  function probe() {
    if (model === MODEL_READY || hasAudio || isProbing || !isWaiting()) return;
    isProbing = true;
    health()
      .then((h) => {
        model = h.tts_ready ? MODEL_READY : MODEL_LOADING;
        if (model === MODEL_LOADING) timer(probe, HEALTH_POLL_MS);
      })
      .catch(() => { model = MODEL_READY; })   // unknowable: show the plain meter, never a stuck spinner
      .finally(() => { isProbing = false; refresh(); });
  }

  tts.onChange((kind) => {
    if (kind === 'store') hasAudio = true;
    refresh();
    probe();
  });
  state.subscribe(refresh);
  refresh();
  return { refresh };
}

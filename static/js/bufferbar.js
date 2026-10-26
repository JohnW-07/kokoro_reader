// ── Buffer meter (N1) ────────────────────────────────────────────────────────
// A thin line along the bottom edge of the status field (R4), like a video's
// buffered range: how many of the
// sentences the player prefetches after the cursor already have audio. The client
// never holds more than a few ahead, so a whole-document bar would always read ~0.
// While the sentence at the cursor is being synthesised, it sweeps
// (indeterminate) and says "Preparing audio…" (F2). If /api/health also says the Kokoro
// model is not loaded yet (it loads lazily on the first /api/tts), it says "Loading voice
// model…" instead; health reports the Kokoro model only, so a Siri voice never says that.
// With no script there is nothing to buffer, so it hides rather than read "all ready".
// While the sidebar is folded in, the rail's play button (`ring`) shows the same as a ring.
// Dependency-free: everything arrives through the factory options.

export const LOADING_TEXT = 'Loading voice model…';
export const FETCHING_TEXT = 'Preparing audio…';
export const HEALTH_POLL_MS = 1000;

const MODEL_UNKNOWN = 'unknown';
const MODEL_LOADING = 'loading';
const MODEL_READY = 'ready';

/**
 * What the bar shows. Pure.
 * @param {{ ready: number, want: number, isLoading: boolean, isFetching?: boolean }} v
 *        isLoading: the model is loading; isFetching: the sentence being read is.
 * @returns {{ fraction: number, isLoading: boolean, valueText: string }}
 */
export function bufferView({ ready, want, isLoading, isFetching = false }) {
  if (isLoading) return { fraction: 0, isLoading: true, valueText: LOADING_TEXT };
  if (isFetching) return { fraction: 0, isLoading: true, valueText: FETCHING_TEXT };
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
 * @param {HTMLElement|null} [deps.ring]  #railPpBtn: `--ready` (0–1), `has-ring`, `is-loading`
 * @returns {{ refresh: () => void }}
 */
export function createBufferBar({ root, tts, health, ahead, state, voiceOf, timer = setTimeout, ring = null }) {
  if (!root) return { refresh() {} };
  const part = (tag, className) => Object.assign(document.createElement(tag), { className });
  const track = part('div', 'bufferbar-track');
  const fill = part('div', 'bufferbar-fill');
  const label = part('span', 'bufferbar-label');
  track.append(fill);
  root.append(track, label);

  let model = MODEL_UNKNOWN;
  let isProbing = false;
  let hasAudio = false;          // a stored Kokoro sentence proves the model is up, whatever health said
  let shown = '';

  const isKokoro = (s) => s.siriVoice !== true;   // health's tts_ready is about the Kokoro model only
  const isWaiting = () => {
    const { inflight, queued } = tts.stats();
    return inflight + queued > 0;
  };

  function render(view, want, ready) {
    const key = `${view.fraction}|${view.valueText}|${want}|${ready}`;
    if (key === shown) return;
    shown = key;
    root.classList.toggle('is-loading', view.isLoading);
    fill.style.transform = view.isLoading ? '' : `scaleX(${view.fraction})`;   // loading: the stylesheet animates it
    label.textContent = view.isLoading ? view.valueText : '';
    root.setAttribute('aria-valuemax', want);
    root.setAttribute('aria-valuetext', view.valueText);
    root.title = view.valueText;
    if (view.isLoading) root.removeAttribute('aria-valuenow');
    else root.setAttribute('aria-valuenow', ready);
    ring?.classList.toggle('is-loading', view.isLoading);
    ring?.style.setProperty('--ready', view.fraction);   // 0 while loading
  }

  function refresh() {
    const s = state.get();
    root.hidden = s.sentences.length === 0;
    ring?.classList.toggle('has-ring', !root.hidden);
    const want = Math.max(0, Math.min(ahead, s.sentences.length - s.index - 1));
    const ready = tts.readyAhead(s.index, want, voiceOf(s), s.speed);
    const isLoading = isKokoro(s) && model === MODEL_LOADING && !hasAudio && isWaiting();
    const isFetching = tts.isPending(s.index, voiceOf(s), s.speed);   // the cursor's own audio
    render(bufferView({ ready, want, isLoading, isFetching }), want, ready);
  }

  /** Ask health only while it matters: a Kokoro voice, model state unknown or loading, and work waiting. */
  function probe() {
    if (!isKokoro(state.get()) || model === MODEL_READY || hasAudio || isProbing || !isWaiting()) return;
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
    if (kind === 'store' && isKokoro(state.get())) hasAudio = true;   // Siri audio says nothing about the Kokoro model
    refresh();
    probe();
  });
  state.subscribe(refresh);
  refresh();
  return { refresh };
}

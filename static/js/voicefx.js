// ── Voice effects (V1 stage C, docs/18) ──────────────────────────────────────
// Bass, Treble and Even-out, applied to the audio after it is generated, live: the player's
// <audio> elements go through Web Audio, lowshelf → highshelf → compressor → speakers.
//
// Routing an element into Web Audio cannot be undone, and its sound then depends on the
// AudioContext running. So nothing is routed, and no context exists, until a setting first
// leaves neutral; at neutral playback is exactly what it was before V1. The context is woken
// whenever a routed element plays, since the system may suspend it (sleep, device change).

export const BASS_HZ = 200;         // lowshelf corner: the voice's body
export const TREBLE_HZ = 3000;      // highshelf corner: its presence and sibilance
export const DB_MIN = -12;
export const DB_MAX = 12;
export const EVEN_MAX_RATIO = 8;           // compression at Even-out 100%
export const EVEN_MAX_THRESHOLD_DB = -40;  // where it starts at 100%; 0 dB (no effect) at Off
const EVEN_KNEE_DB = 12;
const EVEN_ATTACK_S = 0.003;
const EVEN_RELEASE_S = 0.25;
const PERCENT = 100;

const clamp = (v, low, high) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : 0;
};
export const clampDb = (v) => clamp(v, DB_MIN, DB_MAX);
export const clampEven = (v) => clamp(v, 0, 1);

/** 3 → "+3 dB", −3 → "−3 dB", 0 → "0 dB". */
export function formatDb(v) {
  const n = Math.round(v);
  return n > 0 ? `+${n} dB` : n < 0 ? `−${-n} dB` : '0 dB';
}

/** 0 → "Off", 0.5 → "50%". */
export const formatEven = (v) => (v > 0 ? `${Math.round(v * PERCENT)}%` : 'Off');

/** The effect settings held in `s` (state), clamped. */
export const fxOf = (s) => ({ bass: clampDb(s.fxBass), treble: clampDb(s.fxTreble), even: clampEven(s.fxEven) });

export const isNeutralFx = (fx) => fx.bass === 0 && fx.treble === 0 && fx.even === 0;

/** DynamicsCompressor settings for Even-out `amount` (0–1). Browsers add their own make-up gain. */
export function compressorFor(amount) {
  return {
    threshold: EVEN_MAX_THRESHOLD_DB * amount,
    ratio: 1 + (EVEN_MAX_RATIO - 1) * amount,
    knee: EVEN_KNEE_DB,
    attack: EVEN_ATTACK_S,
    release: EVEN_RELEASE_S,
  };
}

/**
 * @param {{ createContext?: () => AudioContext }} [deps]
 * @returns {{ track: (el: HTMLMediaElement) => void, apply: (fx: object) => void,
 *            state: () => {routed: number, context: string} }}
 */
export function createVoiceFx({ createContext = () => new AudioContext() } = {}) {
  const waiting = new Set();   // elements seen before the chain existed
  const routed = new WeakSet();
  let routedCount = 0;
  let ctx = null;
  let chain = null;            // { bass, treble, comp }
  let isUnavailable = false;

  function wake() {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});   // retried at the next play
  }

  function route(el) {
    if (routed.has(el) || !el.isConnected) return;
    ctx.createMediaElementSource(el).connect(chain.bass);
    routed.add(el);
    routedCount += 1;
    el.addEventListener('play', wake);
  }

  function build() {
    try {
      ctx = createContext();
    } catch (err) {
      isUnavailable = true;
      console.warn('voice effects unavailable: no Web Audio', err);
      return false;
    }
    const bass = Object.assign(ctx.createBiquadFilter(), { type: 'lowshelf' });
    const treble = Object.assign(ctx.createBiquadFilter(), { type: 'highshelf' });
    const comp = ctx.createDynamicsCompressor();
    bass.frequency.value = BASS_HZ;
    treble.frequency.value = TREBLE_HZ;
    bass.connect(treble).connect(comp).connect(ctx.destination);
    chain = { bass, treble, comp };
    for (const el of waiting) route(el);
    waiting.clear();
    return true;
  }

  /** Every <audio> the player makes, rebuilt ones too (audionode's onElement). */
  function track(el) {
    if (chain) route(el);
    else waiting.add(el);
  }

  /** Set the effects; the first non-neutral setting builds the chain. */
  function apply(fx) {
    if (!chain && (isNeutralFx(fx) || isUnavailable || !build())) return;
    chain.bass.gain.value = fx.bass;
    chain.treble.gain.value = fx.treble;
    const c = compressorFor(fx.even);
    for (const [k, v] of Object.entries(c)) chain.comp[k].value = v;
    wake();
  }

  function state() {
    return { routed: routedCount, context: isUnavailable ? 'unavailable' : ctx ? ctx.state : 'none' };
  }

  return { track, apply, state };
}

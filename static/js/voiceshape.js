// ── Voice shape (V1, docs/18) ────────────────────────────────────────────────
// Kokoro's native Pitch and Expressiveness knobs: the server rescales the F0 curve the
// model predicts (kokoro_reader/voiceshape.py) and caches each setting apart. Neutral
// sends nothing, so audio cached before V1 stays a hit. Siri is shaped after rendering (V2).

export const PITCH_MIN = 0.85;   // the server's measured range
export const PITCH_MAX = 1.15;
export const EXPR_MIN = 0.5;
export const EXPR_MAX = 1.5;
const NEUTRAL = 1;
const PERCENT = 100;

const clamp = (v, low, high) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : NEUTRAL;
};

export const clampPitch = (v) => clamp(v, PITCH_MIN, PITCH_MAX);
export const clampExpr = (v) => clamp(v, EXPR_MIN, EXPR_MAX);

/** The /api/tts query for `s` (state): `{}` when neutral. */
export function shapeParams(s) {
  const pitch = clampPitch(s.voicePitch);
  const expr = clampExpr(s.voiceExpr);
  if (pitch === NEUTRAL && expr === NEUTRAL) return {};
  return { pitch: String(pitch), expr: String(expr) };
}

const percent = (v) => Math.round((v - NEUTRAL) * PERCENT);

/** 1.1 → "+10%", 0.85 → "−15%", 1 → "0%". */
export function formatPitch(v) {
  const p = percent(v);
  return p > 0 ? `+${p}%` : p < 0 ? `−${-p}%` : '0%';
}

/** 1.5 → "150%". */
export const formatExpr = (v) => `${Math.round(v * PERCENT)}%`;

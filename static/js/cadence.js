// ── cadence.js ───────────────────────────────────────────
// C1/N5: the rhythm between sentences. Pure: no DOM, no timers.
//
// 1. Which beat follows a sentence. The server ends every WAV in silence, and how much
//    depends on what comes next — only the client knows that, so it names a tier and the
//    server (tts_engine.PAUSE_TAIL_MS) owns the milliseconds. Baked into the audio rather
//    than scheduled here, so a throttled timer in a background window cannot stretch it.
// 2. When to hand over to the next sentence. `ended` → `play()` costs the element's own
//    start-up latency on top of that silence. Instead the armed spare is started that long
//    before the end, so its first sample lands where the old WAV stops. The lead is learnt,
//    not fixed: measured play() → media-clock start is 7–60 ms in Chromium but ~400 ms in
//    WebKit, whose timers also fire ~100 ms late (C1b). Rather than model each part, every
//    boundary measures its own gap (next clock start − previous clock end) and corrects the
//    lead by a share of it, so whatever the browser adds is absorbed. The outgoing element
//    is not cut at the hand-over — it plays out to `ended` (audionode.drain), so a lead
//    longer than the silent tail still never cuts speech; they overlap only on overshoot.

export const PAUSE = Object.freeze({ SENTENCE: 'sentence', PARAGRAPH: 'paragraph', SECTION: 'section' });

/** The lead before anything is measured: Chromium's play() → clock start (C1b, headless). */
export const HANDOFF_LEAD_MS = 50;
/** Ceiling on the learnt lead: WebKit measured 360–514 ms start + ~100 ms timer lateness. */
export const MAX_HANDOFF_LEAD_MS = 800;
/** A boundary gap beyond this is a stall or a hidden tab, not latency: ignored. */
export const MAX_GAP_SAMPLE_MS = 1000;
/**
 * Share of a measured gap corrected at the next boundary: 1/n over the first gaps (the lead
 * is their running mean), then this floor, which damps WebKit's ±100 ms jitter.
 */
export const MIN_LEAD_GAIN = 0.25;
/** Arm this long before the lead: longer than the slowest `timeupdate` period (250 ms). */
export const ARM_WINDOW_MS = 400;
/** Timer lateness tolerated when the hand-over re-checks the position at fire time. */
export const HANDOFF_SLACK_MS = 30;
const MS_PER_S = 1000;
const SECTION_KINDS = new Set(['heading']);

/**
 * Same paragraph? The pipeline gives every sentence of a block that block's text as `raw`;
 * a sentence joined across two blocks (T2) carries both, so it borders each of them.
 */
function sameBlock(a, b) {
  const [x, y] = [String(a.raw || ''), String(b.raw || '')];
  if (!x || !y) return false;
  return x === y || x.endsWith(` ${y}`) || y.startsWith(`${x} `);
}

/**
 * The beat after sentence `idx`: short inside a paragraph, longer at its end, longest
 * around a heading.
 * @param {Array<{raw?: string, kind?: string}>} list
 * @param {number} idx
 * @returns {string} one of PAUSE
 */
export function pauseAfter(list, idx) {
  const current = list[idx];
  const next = list[idx + 1];
  if (!current || !next) return PAUSE.PARAGRAPH;
  if (SECTION_KINDS.has(current.kind) || SECTION_KINDS.has(next.kind)) return PAUSE.SECTION;
  if (current.kind === next.kind && sameBlock(current, next)) return PAUSE.SENTENCE;
  return PAUSE.PARAGRAPH;
}

const remainingMs = (currentTime, duration) => (duration - currentTime) * MS_PER_S;
const known = (...xs) => xs.every(Number.isFinite);

/**
 * The next lead, from the current one and the gap one boundary measured with it. A late
 * start (gap > 0) asks for more lead, an early one (gap < 0) for less; capped both ways.
 * @param {number} lead ms
 * @param {number} gapMs next clock start − previous clock end, ms
 * @param {number} [samples] gaps already folded in
 * @returns {number}
 */
export function nextLead(lead, gapMs, samples = 0) {
  if (!Number.isFinite(gapMs) || Math.abs(gapMs) > MAX_GAP_SAMPLE_MS) return lead;
  const gain = Math.max(MIN_LEAD_GAIN, 1 / (samples + 1));
  return Math.min(MAX_HANDOFF_LEAD_MS, Math.max(0, lead + gain * gapMs));
}

/**
 * Milliseconds until the early hand-over, or null when it is not yet time to schedule one.
 * @param {number} currentTime seconds
 * @param {number} duration seconds
 * @param {number} [lead] ms, from nextLead
 * @returns {number|null}
 */
export function handoffDelayMs(currentTime, duration, lead = HANDOFF_LEAD_MS) {
  if (!known(currentTime, duration)) return null;
  const left = remainingMs(currentTime, duration);
  if (left > lead + ARM_WINDOW_MS) return null;
  return Math.max(0, left - lead);
}

/** True once the element is within the hand-over lead of its end (re-checked at fire time). */
export function isAtHandoff(currentTime, duration, lead = HANDOFF_LEAD_MS) {
  if (!known(currentTime, duration)) return false;
  return remainingMs(currentTime, duration) <= lead + HANDOFF_SLACK_MS;
}

// ── Transport rules ──────────────────────────────────────────────────────────
// The small decisions main.js makes about player events: which key presses are the
// reader's, which status lines are announced, when the resume position is saved, and
// where the cursor lands after a rebuild replaces the script.
//
// Pure apart from `Element.closest` on the key target, so it unit-tests in plain Node.

import { resolveReadFrom } from './readfrom.js';

/** Controls whose own activation key is Space: taking it would make them unusable (A6). */
const SPACE_OWNER_SELECTOR = 'button, [role="button"], summary';
/** Player phases that change once per sentence: announcing them talks over the voice (A7). */
const QUIET_PHASES = new Set(['loading', 'playing']);
const LOUD_LEVELS = new Set(['warn', 'error']);
/** Phases where playback has come to rest, so the position is worth writing now (A10). */
const RESTING_PHASES = new Set(['paused', 'idle']);

/** True when Space on `target` activates that control rather than toggling playback. */
export function ownsSpace(target) {
  return Boolean(target?.closest?.(SPACE_OWNER_SELECTOR));
}

/** True when a player status should reach a screen reader. */
export function isAnnounced({ state, level } = {}) {
  return LOUD_LEVELS.has(level) || !QUIET_PHASES.has(state);
}

/** True when playback has stopped moving, so the resume position should be saved. */
export function isResting(phase) {
  return RESTING_PHASES.has(phase);
}

/**
 * Where the cursor belongs in a rebuilt script (A4): the sentence that holds the old
 * one's first text item, else the next one after it, else the last sentence.
 * @param {Array<{page:number, items?:number[]}>} before the script the cursor pointed into
 * @param {number} index the cursor in `before`
 * @param {Array<{page:number, items?:number[]}>} after the rebuilt script
 * @returns {number} an index into `after`, or -1 when it is empty
 */
export function remapIndex(before, index, after) {
  const list = Array.isArray(after) ? after : [];
  if (list.length === 0) return -1;
  const anchor = Array.isArray(before) ? before[index] : undefined;
  if (!anchor) return Math.min(Math.max(Number.isInteger(index) ? index : 0, 0), list.length - 1);
  const item = Array.isArray(anchor.items) ? anchor.items[0] : null;
  const { index: hit } = resolveReadFrom(list, { page: anchor.page, item });
  return hit >= 0 ? hit : list.length - 1;
}

/**
 * subs.js — the pure rules behind the Subs tab (T6): what a substitution row is, when
 * one is valid, and which rows are sent to `/api/script/build`.
 *
 * The server applies substitutions and is the authority (`kokoro_reader/routes/script.py`
 * validates them again). These rules mirror it so the tab can say what is wrong while
 * the user types, and so an invalid row is never sent and never fails a whole build.
 *
 * Imports nothing and touches no DOM, so it unit-tests in plain Node.
 */

/** Mirrors `config.MAX_SUBSTITUTIONS` / `MAX_SUB_FIND_CHARS` / `MAX_SUB_REPLACE_CHARS`. */
export const MAX_SUBSTITUTIONS = 100;
export const MAX_FIND_CHARS = 80;
export const MAX_REPLACE_CHARS = 200;

/** Mirrors the route's control-character rule: NUL is normalize's sentinel. */
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

export const MESSAGES = Object.freeze({
  emptyFind: 'Enter the text to replace.',
  duplicate: 'This text already has a substitution.',
  control: 'Line breaks and control characters are not allowed.',
  tooMany: `Up to ${MAX_SUBSTITUTIONS} substitutions.`,
});

/**
 * A new frozen row from untrusted input (saved prefs, form fields). Never throws.
 * @param {unknown} raw @returns {{find:string, replace:string, ignore_case:boolean}}
 */
export function makeSub(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return Object.freeze({
    find: typeof src.find === 'string' ? src.find.slice(0, MAX_FIND_CHARS) : '',
    replace: typeof src.replace === 'string' ? src.replace.slice(0, MAX_REPLACE_CHARS) : '',
    ignore_case: src.ignore_case === true,
  });
}

/** Do `a` and `b` claim the same printed word? Mirrors `subs.same_find`. */
export function sameFind(a, b) {
  const [x, y] = [a.find.trim(), b.find.trim()];
  if (a.ignore_case || b.ignore_case) return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

/**
 * One message per row, or '' for a valid row. A row is judged against the rows above
 * it, so the first of two duplicates stays valid and only the later one is flagged.
 * @param {ReadonlyArray<{find:string, replace:string, ignore_case:boolean}>} rows
 * @returns {string[]}
 */
export function validate(rows) {
  return rows.map((row, i) => {
    if (!row.find.trim()) return MESSAGES.emptyFind;
    if (CONTROL_CHARS_RE.test(row.find) || CONTROL_CHARS_RE.test(row.replace)) return MESSAGES.control;
    if (rows.slice(0, i).some((above) => above.find.trim() && sameFind(above, row))) return MESSAGES.duplicate;
    if (i >= MAX_SUBSTITUTIONS) return MESSAGES.tooMany;
    return '';
  });
}

/**
 * The message for a row about to be added below `rows`, or '' when it can be added.
 * @param {ReadonlyArray<object>} rows @param {object} draft @returns {string}
 */
export function validateDraft(rows, draft) {
  if (rows.length >= MAX_SUBSTITUTIONS) return MESSAGES.tooMany;
  return validate([...rows, makeSub(draft)]).at(-1);
}

/**
 * The rows the server should apply: valid ones only, trimmed, as new objects.
 * @param {ReadonlyArray<object>} rows @returns {Array<{find:string, replace:string, ignore_case:boolean}>}
 */
export function toPayload(rows) {
  const errors = validate(rows);
  return rows
    .filter((_, i) => !errors[i])
    .map((row) => ({ find: row.find.trim(), replace: row.replace.trim(), ignore_case: row.ignore_case }));
}

/** Would these two lists make the server say anything differently? */
export function samePayload(a, b) {
  return JSON.stringify(toPayload(a)) === JSON.stringify(toPayload(b));
}

/** Saved prefs are untrusted: keep only an array of well-formed rows, capped. */
export function loadSubs(saved) {
  return Object.freeze(Array.isArray(saved) ? saved.slice(0, MAX_SUBSTITUTIONS).map(makeSub) : []);
}

// ── Immutable edits: each returns a new list and leaves its input untouched ─────────

/** @returns {ReadonlyArray<object>} */
export function addSub(rows, raw) {
  return Object.freeze([...rows, makeSub(raw)]);
}

/** @returns {ReadonlyArray<object>} */
export function updateSub(rows, index, patch) {
  if (index < 0 || index >= rows.length) return rows;
  return Object.freeze(rows.map((row, i) => (i === index ? makeSub({ ...row, ...patch }) : row)));
}

/** @returns {ReadonlyArray<object>} */
export function removeSub(rows, index) {
  if (index < 0 || index >= rows.length) return rows;
  return Object.freeze(rows.filter((_, i) => i !== index));
}

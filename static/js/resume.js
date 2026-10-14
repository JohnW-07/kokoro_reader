/**
 * resume.js — where reading picks up when a document is reopened (N4).
 *
 * The saved `last_index` is a raw script index. A rebuild that joins sentences over page
 * turns renumbers everything after the first join, so restoring the index alone silently
 * moved John's place. The record also keeps `last_sentence`, the start page and opening
 * text of the sentence he was on; restore finds that sentence again, and only falls back
 * to the index for a record saved before the mark existed or a sentence no longer there.
 *
 * Pure: imports only the pure spans.js, never mutates its input.
 */

import { spansOf } from './spans.js';

/** Opening text kept in the mark. Matches MAX_RESUME_TEXT_CHARS in kokoro_reader/notes_store.py. */
export const RESUME_TEXT_CHARS = 80;

/** The mark saved for `sentence`: its start page and opening text, else null. */
export function resumeMark(sentence) {
  if (!sentence || !Number.isInteger(sentence.page)) return null;
  return { page: sentence.page, text: String(sentence.text || '').slice(0, RESUME_TEXT_CHARS) };
}

/**
 * The index to resume at, or -1 when there is nothing to resume.
 *
 * A sentence matches the mark when one of its parts is on the mark's page and its text
 * contains the mark's: a sentence joined since still contains either half's opening. Of
 * several matches the one nearest the saved index wins.
 * @param {Array<{page:number, text:string}>} sentences the freshly built script
 * @param {{last_index?:number, last_sentence?:{page:number, text:string}|null}|null} record
 */
export function resumeIndex(sentences, record) {
  const list = Array.isArray(sentences) ? sentences : [];
  if (!list.length || !record) return -1;
  const saved = Number.isInteger(record.last_index) && record.last_index > 0 ? record.last_index : 0;
  const mark = record.last_sentence;
  if (mark && typeof mark.text === 'string' && mark.text) {
    const hits = list
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => String(s?.text || '').includes(mark.text)
        && spansOf(s).some((part) => part.page === mark.page))
      .map(({ index }) => index);
    if (hits.length) return hits.reduce((best, i) => (Math.abs(i - saved) < Math.abs(best - saved) ? i : best));
  }
  return saved > 0 ? Math.min(saved, list.length - 1) : -1;
}

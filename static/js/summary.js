/**
 * summary.js — the rules behind the Summary tab (N9). Pure: no DOM, no fetch of its own.
 *
 * The server is stateless about pages, so the text to summarise is gathered here from the
 * script (`state.sentences`): one page, or the section the reader is in (U2's headings).
 */

/** Mirrors kokoro_reader/summary.py MAX_TEXT_CHARS; the harness fails if the two drift. */
export const MAX_TEXT_CHARS = 12000;
export const BACKEND_APPLE = 'apple';
export const BACKEND_QWEN = 'qwen';
export const BACKEND_NAMES = Object.freeze({
  [BACKEND_APPLE]: 'Apple on-device model',
  [BACKEND_QWEN]: 'local Qwen model',
});
const STATUS_UNAVAILABLE = 503;
const SENTENCE_END = /(?<=[.!?…]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/u;

/** What a script sentence says out loud. */
export const speakable = (s) => String(s?.text || s?.raw || '').trim();

/**
 * Join sentences into one text, stopping at a sentence boundary before MAX_TEXT_CHARS.
 * @returns {{text: string, used: number, total: number}}
 */
export function joinCapped(list) {
  const parts = [];
  let length = 0;
  for (const s of list) {
    const text = speakable(s);
    if (!text) continue;
    const next = length + (parts.length ? 1 : 0) + text.length;
    if (next > MAX_TEXT_CHARS) break;
    parts.push(text);
    length = next;
  }
  return { text: parts.join(' '), used: parts.length, total: list.filter((s) => speakable(s)).length };
}

/** The page the reader is on: the cursor sentence's page. 0 when there is no script. */
export function cursorPage({ sentences = [], index = 0 } = {}) {
  const page = Number(sentences[Math.min(Math.max(index, 0), sentences.length - 1)]?.page);
  return Number.isInteger(page) && page > 0 ? page : 0;
}

function scopeOf(kind, page, label, list) {
  const { text, used, total } = joinCapped(list);
  return text ? Object.freeze({ kind, page, label, text, clipped: used < total }) : null;
}

/** Everything read on `page`, or null when nothing is. */
export function pageScope(sentences, page) {
  const list = (sentences || []).filter((s) => s?.page === page);
  return scopeOf('page', page, `page ${page}`, list);
}

/**
 * The section holding sentence `index`: from the last heading at or before it up to the next
 * heading. Null when the paper has no headings or the reader is before the first one.
 * @param {Array<{index:number, title:string, page:number}>} sections from anchors.sectionsFromScript
 */
export function sectionScope(sections, sentences, index) {
  const starts = (sections || []).filter((s) => Number.isInteger(s?.index)).sort((a, b) => a.index - b.index);
  const at = starts.filter((s) => s.index <= index).pop();
  if (!at) return null;
  const end = starts.find((s) => s.index > at.index)?.index ?? (sentences || []).length;
  return scopeOf('section', at.page, `“${at.title}”`, (sentences || []).slice(at.index, end));
}

/** Apple first; the local Qwen model only when the reader turned the LLM on (Q13). */
export const backendsFor = (options) => (options?.use_llm ? [BACKEND_APPLE, BACKEND_QWEN] : [BACKEND_APPLE]);

/**
 * Ask each backend in turn; one that is unavailable (503) hands over to the next.
 * @param {{post: Function, scope: object, docId: string, backends: string[]}} args
 * @returns {Promise<{summary: string, backend: string, cached: boolean}>}
 */
export async function requestSummary({ post, scope, docId, backends }) {
  let lastError = null;
  for (const backend of backends) {
    try {
      return await post({ doc_id: docId || '', page: scope.page, text: scope.text, backend });
    } catch (err) {
      if (err?.status !== STATUS_UNAVAILABLE) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/** A sentence list the player can read: the summary split where its sentences end. */
export function summarySentences(summary, page) {
  return Object.freeze(String(summary || '').split(SENTENCE_END).map((t) => t.trim()).filter(Boolean)
    .map((text) => Object.freeze({ text, raw: text, page, kind: 'summary', items: [] })));
}

/** docs/17 S1: "this page" is the page on screen; before one is shown, the cursor's page. */
export function summaryPage(viewed, s) {
  return Number.isInteger(viewed) && viewed > 0 ? viewed : cursorPage(s);
}

/**
 * docs/17 S2: the notes as the player's sentences, in reading order: heading, context, each
 * point; `role` says which. A reply without notes falls back to its flat summary.
 */
export function notesSentences(reply, page) {
  if (!Array.isArray(reply?.points)) {
    return Object.freeze(summarySentences(reply?.summary, page).map((s) => Object.freeze({ ...s, role: 'text' })));
  }
  const parts = [['heading', reply.heading], ['context', reply.context], ...reply.points.map((p) => ['point', p])];
  return Object.freeze(parts.map(([role, t]) => [role, String(t || '').trim()]).filter(([, text]) => text)
    .map(([role, text]) => Object.freeze({ text, raw: text, page, kind: 'summary', items: [], role })));
}

/** One line for the panel's status, from a failed request. */
export function errorMessage(err) {
  if (err?.status === STATUS_UNAVAILABLE) return `Summaries are unavailable: ${err.message}.`;
  if (err?.kind === 'timeout') return 'The summary took too long. Try again, or a shorter scope.';
  return `Could not summarise: ${err?.message || 'unknown error'}.`;
}

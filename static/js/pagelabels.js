/**
 * pagelabels.js — the page numbers the paper prints, as opposed to the PDF's page index (N8).
 *
 * A book's page 23 is often its printed page 11: front matter in roman numerals, chapter
 * openers with no number at all. The PDF's own page labels say so when it has them; when it
 * does not, the printed numbers are read back from the margin lines the classifier already
 * set aside (page numbers, running headers and footers), and a page is only labelled where
 * two printed numbers agree on the run it belongs to. Anything else shows the index.
 *
 * Pure: no DOM, no imports, inputs never mutated, so it unit-tests in Node.
 */

/** Printed numbers that agree on an offset before a run is believed. */
const MIN_AGREEING_ANCHORS = 2;
/** How far past its outermost printed number a run reaches: the unnumbered chapter opener
 *  in front of it (every book's page 1), or a blank page after it. */
const EXTEND_PAGES = 1;

const KIND = Object.freeze({ ARABIC: 'arabic', ROMAN: 'roman' });

const ARABIC_RE = /^\d{1,4}$/;
const ROMAN_RE = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
/** "3 of 12", "Page 3 of 12", "3 / 12" at the end of a line: page 3, never 12. */
const OF_TOTAL_RE = /(?:^|\s)(?:page\s+)?(\d{1,4})\s*(?:of|\/)\s*\d{1,4}$/i;
const INDEX_INPUT_RE = /^#\s*(\d+)$/;
const PAGE_PREFIX_RE = /^(?:page\s+|p\.\s*)/i;
const DIGITS_RE = /^\d+$/;

const ROMAN_DIGITS = Object.freeze([
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]);
const ROMAN_VALUE = Object.freeze({ i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 });

const isPageCount = (n) => Number.isInteger(n) && n >= 1;

function romanValue(token) {
  const lower = token.toLowerCase();
  const oneCase = token === lower || token === token.toUpperCase();
  if (!token || !oneCase || !ROMAN_RE.test(lower)) return 0;
  return [...lower].reduce((sum, ch, i) => {
    const v = ROMAN_VALUE[ch];
    return ROMAN_VALUE[lower[i + 1]] > v ? sum - v : sum + v;
  }, 0);
}

function toRoman(value, upper) {
  let rest = value;
  const out = ROMAN_DIGITS.reduce((acc, [v, s]) => {
    const times = Math.floor(rest / v);
    rest -= times * v;
    return acc + s.repeat(times);
  }, '');
  return upper ? out.toUpperCase() : out;
}

function parseToken(token) {
  if (ARABIC_RE.test(token)) {
    const value = Number(token);
    return value >= 1 ? { kind: KIND.ARABIC, value, upper: false } : null;
  }
  const value = romanValue(token);
  return value >= 1 ? { kind: KIND.ROMAN, value, upper: token !== token.toLowerCase() } : null;
}

/**
 * The page numbers a margin line could be printing: its first or last word when that is a
 * number, or N of "N of M".
 * @param {string} text @returns {Array<{kind:string, value:number, upper:boolean}>}
 */
export function pageCandidates(text) {
  const line = String(text ?? '').trim();
  if (!line) return [];
  const ofTotal = line.match(OF_TOTAL_RE);
  if (ofTotal) return [parseToken(ofTotal[1])].filter(Boolean);
  const words = line.split(/\s+/);
  const edges = [...new Set([words[0], words[words.length - 1]])];
  return edges.map(parseToken).filter(Boolean);
}

const labelOf = (kind, value, upper) => (kind === KIND.ROMAN ? toRoman(value, upper) : String(value));

/** True when every label is missing or just repeats its page's index. */
const isIdentity = (labels) => labels.every((label, i) => label === null || label === String(i + 1));

const finish = (labels) => (isIdentity(labels) ? null : Object.freeze(labels));

/**
 * The PDF's own `/PageLabels`, unless it has none or they only repeat the index.
 * @param {Array<string>|null} labels pdf.js `getPageLabels()` @param {number} numPages
 * @returns {ReadonlyArray<string|null>|null}
 */
export function fromPdfLabels(labels, numPages) {
  if (!Array.isArray(labels) || labels.length !== numPages || !isPageCount(numPages)) return null;
  return finish(labels.map((l) => (typeof l === 'string' && l.trim() ? l.trim() : null)));
}

/** Printed numbers grouped by the run they imply (kind + offset from the index), biggest first. */
function agreeingRuns(marks, numPages) {
  const runs = new Map();
  for (const mark of Array.isArray(marks) ? marks : []) {
    const page = mark?.page;
    if (!Number.isInteger(page) || page < 1 || page > numPages) continue;
    for (const { kind, value, upper } of pageCandidates(mark.text)) {
      const offset = value - page;
      const key = `${kind}:${offset}:${upper}`;
      const run = runs.get(key) || { kind, offset, upper, pages: new Set() };
      runs.set(key, { ...run, pages: new Set([...run.pages, page]) });
    }
  }
  return [...runs.values()]
    .map((run) => ({ ...run, pages: [...run.pages].sort((a, b) => a - b) }))
    .filter((run) => run.pages.length >= MIN_AGREEING_ANCHORS)
    .sort((a, b) => b.pages.length - a.pages.length || a.pages[0] - b.pages[0]);
}

/**
 * Labels from the printed page numbers: filled between two numbers that agree on their
 * run, and {@link EXTEND_PAGES} beyond its ends. A run with more printed numbers wins the
 * pages two runs both claim; pages no run reaches stay null (the pill shows the index).
 * @param {Array<{page:number, text:string}>} marks margin lines (pagenum / header / footer)
 * @param {number} numPages
 * @returns {ReadonlyArray<string|null>|null} null when nothing beyond the index was found
 */
export function labelsFromMarks(marks, numPages) {
  if (!isPageCount(numPages)) return null;
  const labels = new Array(numPages).fill(null);
  const labelAt = (run, p) => labelOf(run.kind, p + run.offset, run.upper);
  // Free for `run`: unlabelled, or already carrying this run's own label (a shared anchor).
  const free = (run, from, to) => labels.slice(from - 1, to).every((l, i) => l === null || l === labelAt(run, from + i));
  const fill = (run, from, to) => {
    for (let p = from; p <= to; p++) labels[p - 1] = labelAt(run, p);
  };
  const placed = agreeingRuns(marks, numPages).filter((run) => {
    let used = false;
    run.pages.slice(1).forEach((to, i) => {
      const from = run.pages[i];
      if (free(run, from, to)) { fill(run, from, to); used = true; }
    });
    return used;
  });
  for (const run of placed) {
    const first = run.pages[0];
    const last = run.pages[run.pages.length - 1];
    const before = Math.max(first - EXTEND_PAGES, 1 - run.offset, 1);
    const after = Math.min(last + EXTEND_PAGES, numPages);
    for (let p = first - 1; p >= before && free(run, p, p); p--) fill(run, p, p);
    for (let p = last + 1; p <= after && free(run, p, p); p++) fill(run, p, p);
  }
  return finish(labels);
}

/**
 * The labels to show: the PDF's own when it has real ones, else the printed numbers.
 * @param {{pdfLabels?: string[]|null, marks?: object[], numPages: number}} input
 */
export function choosePageLabels({ pdfLabels = null, marks = [], numPages } = {}) {
  return fromPdfLabels(pdfLabels, numPages) || labelsFromMarks(marks, numPages);
}

/**
 * The page pill: the printed number first and the index second when they differ.
 * @param {number} page 1-based index @param {number} total @param {ReadonlyArray<string|null>|null} labels
 */
export function pillText(page, total, labels) {
  const label = Array.isArray(labels) ? labels[page - 1] : null;
  return label && label !== String(page) ? `p. ${label} · ${page}/${total}` : `Page ${page} / ${total}`;
}

/**
 * Where "Go to page" goes: `#n` is always the index; otherwise a printed label (any case),
 * then a plain index. -1 when the input names no page.
 * @param {string} text @param {ReadonlyArray<string|null>|null} labels @param {number} numPages
 * @returns {number} 1-based page index, or -1
 */
export function resolvePageInput(text, labels, numPages) {
  const input = String(text ?? '').trim();
  const inRange = (n) => (Number.isInteger(n) && n >= 1 && n <= numPages ? n : -1);
  const asIndex = input.match(INDEX_INPUT_RE);
  if (asIndex) return inRange(Number(asIndex[1]));
  const wanted = input.replace(PAGE_PREFIX_RE, '').toLowerCase();
  if (!wanted) return -1;
  const byLabel = (Array.isArray(labels) ? labels : []).findIndex((l) => l && l.toLowerCase() === wanted);
  if (byLabel >= 0) return byLabel + 1;
  return DIGITS_RE.test(wanted) ? inRange(Number(wanted)) : -1;
}

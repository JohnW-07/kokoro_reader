/**
 * toc.js — the paper's contents, for "jump to chapter" (N7).
 *
 * The PDF's own outline (bookmarks) when it has one; otherwise the headings the script
 * already found, ranked by size so the largest repeated size is the chapter level. Each
 * entry is tied to the sentence reading starts at: the heading sentence itself when one
 * matches, else the first sentence read on (or after) its page.
 *
 * Pure apart from awaiting the pdf.js document handed in; no DOM, inputs never mutated.
 */

import { resolveReadFrom } from './readfrom.js';

/** Deepest level the tree shows; finer headings fold into it. */
export const MAX_DEPTH = 2;
/** A heading size has to recur to rank as a level: a one-off (the book's title) does not. */
const MIN_RANKED_USES = 2;
/** Glyph sizes this close are one level (pdf.js reports 24.79 and 24.8 for the same font). */
const SIZE_STEP = 0.5;
/** How far above a destination's top a heading may sit and still be the one it points at. */
const TOP_SLACK = 0.02;
/** Titles shorter than this must match exactly, not by prefix ("1" is not "1.1 Why"). */
const MIN_PREFIX_CHARS = 4;

const EMPTY = Object.freeze({ source: 'none', entries: Object.freeze([]) });

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const isPage = (n) => Number.isInteger(n) && n >= 1;

/** pdf.js: [ref | pageIndex, {name}, ...args]; the top is arg 3 for XYZ, arg 2 for FitH/FitBH. */
function destTop(dest) {
  const name = dest?.[1]?.name;
  if (name === 'XYZ') return dest[3];
  if (name === 'FitH' || name === 'FitBH') return dest[2];
  return null;
}

/** `{page, top}` for an outline item's destination, or null when it points nowhere in this file. */
async function resolveDest(doc, raw) {
  try {
    const dest = typeof raw === 'string' ? await doc.getDestination(raw) : raw;
    if (!Array.isArray(dest) || dest.length === 0) return null;
    const target = dest[0];
    const index = Number.isInteger(target) ? target : await doc.getPageIndex(target);
    const page = index + 1;
    if (!isPage(page)) return null;
    const y = destTop(dest);
    if (!Number.isFinite(y)) return { page, top: null };
    const [, y0, , y1] = (await doc.getPage(page)).view;
    return { page, top: clamp01((y1 - y) / (y1 - y0)) };
  } catch {
    return null;   // a broken name tree or ref costs this entry, never the outline
  }
}

async function flatten(doc, items, depth) {
  const out = [];
  for (const node of Array.isArray(items) ? items : []) {
    const at = node?.dest ? await resolveDest(doc, node.dest) : null;
    const children = await flatten(doc, node?.items, depth + 1);
    const title = String(node?.title || '').trim();
    const page = at?.page ?? children[0]?.page;
    if (title && page) out.push(Object.freeze({ title, depth, page, top: at?.top ?? null }));
    out.push(...children);
  }
  return out;
}

/**
 * The PDF outline as a flat, reading-order list. URL entries and entries whose destination
 * cannot be resolved are dropped; a parent with no destination opens at its first child.
 * @param {object|null} doc a pdf.js PDFDocumentProxy
 * @returns {Promise<ReadonlyArray<{title:string, depth:number, page:number, top:number|null}>>}
 */
export async function outlineFromPdf(doc) {
  if (typeof doc?.getOutline !== 'function') return Object.freeze([]);
  try {
    return Object.freeze(await flatten(doc, await doc.getOutline(), 0));
  } catch {
    return Object.freeze([]);
  }
}

const sizeKey = (size) => Math.round(size / SIZE_STEP) * SIZE_STEP;

/** Depth per heading size: how many recurring sizes are larger, capped at MAX_DEPTH. */
function depthBySize(sections) {
  const uses = new Map();
  for (const s of sections) if (s.size > 0) uses.set(sizeKey(s.size), (uses.get(sizeKey(s.size)) || 0) + 1);
  const ranked = [...uses].filter(([, n]) => n >= MIN_RANKED_USES).map(([size]) => size);
  return (size) => (size > 0 ? Math.min(MAX_DEPTH, ranked.filter((r) => r > sizeKey(size)).length) : MAX_DEPTH);
}

/** A heading wrapped over two lines reads on with a space; "Chapter 2" + its name gets a dot. */
const joinTitles = (a, b) => (/^\p{Ll}/u.test(b) ? `${a} ${b}` : `${a} · ${b}`);

/**
 * Detected headings as contents entries. Adjacent heading sentences of one size on one page
 * are one heading ("Chapter 2" / "Descriptive statistics").
 * @param {Array<{index:number, page:number, title:string, size?:number, top?:number}>} sections
 */
export function headingEntries(sections) {
  const list = (Array.isArray(sections) ? sections : []).filter((s) => isPage(s?.page) && s.title);
  const depthOf = depthBySize(list);
  const merged = list.reduce((acc, s) => {
    const last = acc[acc.length - 1];
    const continues = last && last.page === s.page && last.size === s.size && last.lastIndex + 1 === s.index;
    if (continues) return [...acc.slice(0, -1), { ...last, title: joinTitles(last.title, s.title), lastIndex: s.index }];
    return [...acc, { ...s, lastIndex: s.index }];
  }, []);
  return Object.freeze(merged.map((s) => Object.freeze({
    title: s.title, depth: depthOf(s.size || 0), page: s.page, top: s.top ?? null, index: s.index,
  })));
}

const normal = (title) => String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function titlesMatch(a, b) {
  const [x, y] = [normal(a), normal(b)];
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= MIN_PREFIX_CHARS && long.startsWith(`${short} `);
}

/** The sentence an outline entry starts reading at: its heading, else its page's first. */
function sentenceFor(entry, sections, sentences) {
  const onPage = sections.filter((s) => s.page === entry.page);
  const named = onPage.find((s) => titlesMatch(s.title, entry.title));
  if (named) return named.index;
  if (Number.isFinite(entry.top)) {
    const below = onPage.find((s) => (s.top ?? 0) >= entry.top - TOP_SLACK);
    if (below) return below.index;
  }
  return resolveReadFrom(sentences, { page: entry.page, item: null }).index;
}

/**
 * The contents to show: outline entries when the PDF has an outline, else detected headings,
 * each with the sentence `index` a jump starts at (-1 when nothing is read from there on).
 * @param {{outline?: object[], sections?: object[], sentences?: object[]}} input
 * @returns {{source:'outline'|'headings'|'none', entries: ReadonlyArray<object>}}
 */
export function buildToc({ outline = [], sections = [], sentences = [] } = {}) {
  const secs = Array.isArray(sections) ? sections : [];
  if (Array.isArray(outline) && outline.length) {
    const entries = outline.map((e) => Object.freeze({ ...e, index: sentenceFor(e, secs, sentences) }));
    return Object.freeze({ source: 'outline', entries: Object.freeze(entries) });
  }
  const entries = headingEntries(secs);
  return entries.length ? Object.freeze({ source: 'headings', entries }) : EMPTY;
}

/**
 * The entry the reader is in: the one with the latest start at or before `index` (on a tie,
 * the later, deeper one). -1 before the first.
 */
export function currentEntry(entries, index) {
  let best = -1;
  (entries || []).forEach((e, i) => {
    if (e.index >= 0 && e.index <= index && (best < 0 || e.index >= entries[best].index)) best = i;
  });
  return best;
}

/** Each entry's parent position: the nearest earlier entry that is shallower, else -1. */
export function parentsOf(entries) {
  const stack = [];
  return (entries || []).map((e, i) => {
    while (stack.length && entries[stack[stack.length - 1]].depth >= e.depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : -1;
    stack.push(i);
    return parent;
  });
}

/** Positions from `i`'s parent up to its top-level entry. */
export function ancestorsOf(parents, i) {
  const out = [];
  for (let p = parents[i] ?? -1; p >= 0; p = parents[p]) out.push(p);
  return out;
}

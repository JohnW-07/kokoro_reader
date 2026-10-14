/**
 * readfrom.js — "Read from here": which sentence a click on the PDF starts at.
 *
 * A sentence is `{page, items, ...}`, where `items` are pdf.js text-item indices on
 * `page` (the same indices the text layer's spans are built from). A click resolves
 * to `{page, item}`; `item` is null when no text span could be tied to the click.
 * A sentence over a page turn (N4) is matched by its share of whichever page was clicked.
 *
 * Pure: no DOM, imports only the pure spans.js, the input is never mutated, so it
 * unit-tests in Node.
 */

import { spansOf } from './spans.js';

export const MATCH = Object.freeze({ EXACT: 'exact', FOLLOWING: 'following', NONE: 'none' });

const NONE = Object.freeze({ index: -1, match: MATCH.NONE });

const isPage = (n) => Number.isInteger(n) && n >= 1;
const isItem = (n) => Number.isInteger(n) && n >= 0;
/** `s`'s items on `page`, or null when no part of it is there. */
const itemsOn = (s, page) => spansOf(s).find((part) => part.page === page)?.items ?? null;

/** Index of the first sentence whose items on `page` include `item`, else -1. */
function exactHit(sentences, page, item) {
  return sentences.findIndex((s) => itemsOn(s, page)?.includes(item));
}

/**
 * The sentence on `page` that comes next in the content stream after `item`: the one
 * with the smallest first item above it. Ties go to the earlier sentence. With no item,
 * the first sentence on the page.
 */
function followingOnPage(sentences, page, item) {
  if (!isItem(item)) return sentences.findIndex((s) => itemsOn(s, page) !== null);
  let best = -1;
  let bestStart = Infinity;
  sentences.forEach((s, index) => {
    const after = (itemsOn(s, page) ?? []).filter((i) => i > item);
    if (after.length === 0) return;
    const start = Math.min(...after);
    if (start < bestStart) { best = index; bestStart = start; }
  });
  return best;
}

/** The first sentence on the nearest later page, else -1. */
function firstOnLaterPage(sentences, page) {
  let best = -1;
  sentences.forEach((s, index) => {
    if (!isPage(s?.page) || s.page <= page) return;
    if (best < 0 || s.page < sentences[best].page) best = index;
  });
  return best;
}

/**
 * Resolve a click to the sentence reading should start at.
 * @param {Array<{page:number, items?:number[]}>} sentences the loaded script
 * @param {{page:number, item?:number|null}} target the clicked page and pdf.js item index
 * @returns {{index:number, match:string}} index -1 with MATCH.NONE when nothing follows
 */
export function resolveReadFrom(sentences, target) {
  const list = Array.isArray(sentences) ? sentences : [];
  const page = target?.page;
  if (!isPage(page) || list.length === 0) return NONE;
  const item = isItem(target.item) ? target.item : null;

  if (item !== null) {
    const exact = exactHit(list, page, item);
    if (exact >= 0) return { index: exact, match: MATCH.EXACT };
  }
  const following = followingOnPage(list, page, item);
  if (following >= 0) return { index: following, match: MATCH.FOLLOWING };
  const later = firstOnLaterPage(list, page);
  return later >= 0 ? { index: later, match: MATCH.FOLLOWING } : NONE;
}

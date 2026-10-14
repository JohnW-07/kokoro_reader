/**
 * spans.js — where a sentence sits on the page (N4).
 *
 * A sentence is `{page, items}` on one page. One that runs over a page turn also lists
 * `spans: [{page, items}, …]`, its share of each page, in reading order; `page`/`items`
 * stay its start. Every consumer that paints or hit-tests a sentence goes through
 * `spansOf`, so a one-page sentence and a two-page one look the same to it.
 *
 * Pure: no DOM, no imports, never mutates its input.
 */

const isPage = (n) => Number.isInteger(n) && n >= 1;
const isItem = (n) => Number.isInteger(n) && n >= 0;
const itemsOf = (part) => (Array.isArray(part?.items) ? part.items.filter(isItem) : []);

/**
 * Each page's share of `sentence`, start page first. Parts without a real page are dropped.
 * @param {{page:number, items?:number[], spans?:Array<{page:number, items:number[]}>}} sentence
 * @returns {Array<{page:number, items:number[]}>}
 */
export function spansOf(sentence) {
  const parts = Array.isArray(sentence?.spans) && sentence.spans.length ? sentence.spans : [sentence];
  return parts.filter((part) => isPage(part?.page)).map((part) => ({ page: part.page, items: itemsOf(part) }));
}

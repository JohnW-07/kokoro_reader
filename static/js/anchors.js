/**
 * anchors.js — where a note sits, as pure data (U8).
 *
 * A note is anchored to a *place in the paper*, never to a pixel: `{page, y, hl}`
 * with `y` a 0..1 fraction of the page box, the same convention `highlights.js`
 * normalises its rects to. Zoom and window resizes change the page's CSS geometry
 * and nothing else, so an anchor read back through the page's current rect lands
 * where it was written.
 *
 * No DOM and no imports, so every rule here is testable in Node: the grouping of
 * blocks into notes, the page order they are laid out in, the stack that keeps two
 * notes off each other, and the paper's own section headings.
 */

/** The two ways the column can be laid out: beside the text, or by section (U8). */
export const VIEW_MARGIN = 'margin';
export const VIEW_SECTIONS = 'sections';
/** Two anchors this close on one page are the same place — one note, not two. */
export const ANCHOR_NEAR_Y = 0.04;
/** Breathing room between two stacked notes, in px. */
export const NOTE_GAP_PX = 10;
/**
 * The highest page number an anchor can name. No paper has this many pages, and an
 * anchor beyond it is junk: without a ceiling `{page: 1e20}` is a well-formed anchor
 * that matches no page in the document, so the note silently loses its place.
 */
export const MAX_PAGE = 10000;
/** A section heading claims anchors at or below it; a hair of slack for rounding. */
const SECTION_EPSILON = 1e-6;
/**
 * How far above its baseline a section starts for a note made from a highlight, in ems of its
 * heading's glyph size (U15). A line's `y` is its baseline, but a highlight of the heading is
 * anchored at its top ({@link anchorFromHighlight}), which the text layer draws 0.80–1.15 em
 * above the baseline on every true heading of the 11-paper corpus, in Chromium and WebKit (the
 * top of that range is a π title); at its baseline the section lost every such note to the one
 * before it. A highlight of the line above starts at least 1.9 em above a true heading's
 * baseline there (1.6 em on an equation taken for a heading), so stays outside. A reading
 * position is not a highlight's top: it can sit on that line's lower edge, which a tight
 * heading's reach overlaps, so it keeps the baseline ({@link sectionFor}).
 */
export const HEADING_REACH_EM = 1.25;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Coerce an untrusted anchor to `{page, y, hl}`, or null when it names no place.
 * @returns {{page:number, y:number, hl:string}|null}
 */
export function cleanAnchor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const page = Math.trunc(Number(raw.page));
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) return null;
  return Object.freeze({
    page,
    y: isNum(Number(raw.y)) ? clamp01(Number(raw.y)) : 0,
    hl: typeof raw.hl === 'string' ? raw.hl : '',
  });
}

/**
 * The anchor a note made from a highlight gets: the highlight's top-left bar (D1).
 * @param {{id?:string, page?:number, rects?:Array<{y:number}>}} highlight
 */
export function anchorFromHighlight(highlight) {
  if (!highlight) return null;
  const rects = Array.isArray(highlight.rects) ? highlight.rects : [];
  const tops = rects.map((r) => Number(r?.y)).filter(isNum);
  return cleanAnchor({
    page: highlight.page,
    y: tops.length ? Math.min(...tops) : 0,
    hl: highlight.id,
  });
}

/**
 * True when a note written now would belong to the note already anchored at `a`.
 * Two highlights are the same place only if they are the same highlight; two reading
 * positions only if they are on one page and within {@link ANCHOR_NEAR_Y} of each other.
 */
export function sameAnchor(a, b) {
  if (!a || !b) return a === b || (!a && !b);
  if (a.hl || b.hl) return a.hl === b.hl;
  return a.page === b.page && Math.abs(a.y - b.y) <= ANCHOR_NEAR_Y;
}

/**
 * Does the row being written now open a note of its own, rather than carry on the one
 * it sits in (D1)? Only three things say it does, and none of them is "the reader has
 * moved a little": a note already pinned keeps its place, because its rows are written
 * and moving them is what tore notes in two the first time round.
 *
 * - a run nobody has pinned yet has no place in the paper and must be given one;
 * - a blank row before it: the reader deliberately ended the last note, the same
 *   gesture that ends a paragraph everywhere else;
 * - another page: writing about a different page of the paper is a different note,
 *   and this is the case that keeps a second unhighlighted note from being drawn at
 *   the first one's anchor, off the top of the column.
 *
 * Writing about somewhere else on the *same* page continues the note in hand. That is
 * deliberate: a highlight made while a note is being written is usually the thing the
 * note is about, not the start of a new one, and the blank row is there for when it is.
 *
 * @param {{page:number}|null} held   where the note is already pinned
 * @param {{text?:string, type?:string}|null} prev  the row just above the one being written
 * @param {{page:number}} anchor      where the reader is now
 */
export function opensNote(held, prev, anchor) {
  if (!held) return true;
  if (isBlankRow(prev)) return true;
  return Boolean(anchor) && anchor.page !== held.page;
}

/** A row with nothing in it. A divider is not blank: it is the thing the reader wrote. */
const isBlankRow = (row) => Boolean(row) && row.type !== 'divider' && !String(row.text || '');

/**
 * Is block `id` a note with nothing written in it — one blank row, heading a note of its
 * own? What a click on an empty column leaves behind when the reader never types there;
 * kept, it would be an empty note pinned in the paper for every such click.
 */
export function isEmptyNote(blocks, id) {
  const note = groupNotes(blocks).find((n) => n.blocks[0].id === id);
  return Boolean(note) && note.blocks.length === 1 && isBlankRow(note.blocks[0]);
}

/**
 * `blocks` as they are saved: without the note block `id` heads while {@link isEmptyNote}
 * holds, so a row opened but never written in is never on disk, even if the app goes away
 * before the reader leaves it. The same list when there is nothing to leave out.
 */
export function withoutEmptyNote(blocks, id) {
  return id && isEmptyNote(blocks, id) ? blocks.filter((b) => b.id !== id) : blocks;
}

/** Page order, then down the page. An unanchored note sorts before every anchored one. */
export function compareAnchors(a, b) {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  return a.page - b.page || a.y - b.y;
}

/**
 * Split a flat block list into notes: an anchored block opens one, the blocks after it
 * belong to it until the next anchored block. Blocks before the first anchored one are
 * the unanchored note, which has no place in the paper and stays at the top.
 * @param {Array<{anchor?:object}>} blocks
 * @returns {Array<{anchor:object|null, blocks:Array<object>}>}
 */
export function groupNotes(blocks) {
  const notes = [];
  for (const block of blocks || []) {
    const anchor = cleanAnchor(block.anchor);
    if (anchor || notes.length === 0) notes.push({ anchor, blocks: [block] });
    else notes[notes.length - 1].blocks.push(block);
  }
  return notes;
}

/**
 * The same blocks, with their notes in page order. The sort is stable, so two notes
 * anchored to one place keep the order they were written in, and a note only ever moves
 * as a whole. Returns the input untouched when it is already in order — the editor
 * commits on every keystroke and must not re-render for a no-op.
 */
export function sortNotes(blocks) {
  const notes = groupNotes(blocks);
  const sorted = [...notes].sort((a, b) => compareAnchors(a.anchor, b.anchor));
  if (sorted.every((note, i) => note === notes[i])) return blocks;
  return sorted.flatMap((note) => note.blocks);
}

/**
 * Where each note is drawn, given where it wants to be. Notes are placed top down and
 * pushed to just below the one above when they would overlap it — the rule Google Docs
 * uses, and the only one that cannot hide a note behind another.
 * @param {Array<{desired:number, height:number}>} notes in desired-top order
 * @returns {number[]} the top of each note, in the same order
 */
export function stackTops(notes, gap = NOTE_GAP_PX) {
  let floor = -Infinity;
  return (notes || []).map((note) => {
    const top = Math.max(Number(note.desired) || 0, floor);
    floor = top + Math.max(0, Number(note.height) || 0) + gap;
    return top;
  });
}

/**
 * The paper's own section headings, in page order, each with the 0..1 `y` of its heading's
 * baseline and the `top` a highlight of it is anchored by: that baseline less
 * {@link HEADING_REACH_EM} of its size.
 *
 * The script already says which sentences are headings; the page geometry the script was
 * built from says where they are. `items` in both are indices into the same filtered
 * pdf.js item array (see `buildPageGeometry`), which is what lets the two be joined.
 *
 * @param {Array<{kind?:string, page?:number, raw?:string, text?:string, items?:number[]}>} sentences
 * @param {Array<{page:number, height:number, lines?:Array<{y:number, size?:number, items?:number[]}>}>} pages
 * `size` (the heading line's glyph size, 0 when unknown) ranks headings for the contents tree
 * (N7); `index` is the heading sentence's position in the script.
 * @returns {Array<{page:number, y:number, top:number, title:string, size:number, index:number}>}
 */
export function sectionsFromScript(sentences, pages) {
  const yByPage = new Map();
  for (const page of pages || []) {
    if (!(Number(page?.height) > 0)) continue;
    const ys = new Map();
    for (const line of page.lines || []) {
      const at = Object.freeze({
        y: clamp01(line.y / page.height),
        top: clamp01((line.y - HEADING_REACH_EM * (Number(line.size) || 0)) / page.height),
        size: Number(line.size) || 0,
      });
      for (const item of line.items || []) if (!ys.has(item)) ys.set(item, at);
    }
    yByPage.set(Number(page.page), ys);
  }
  const sections = [];
  (sentences || []).forEach((sentence, index) => {
    if (sentence?.kind !== 'heading') return;
    const title = String(sentence.raw || sentence.text || '').trim();
    const page = Math.trunc(Number(sentence.page));
    if (!title || !Number.isInteger(page) || page < 1) return;
    const at = yByPage.get(page)?.get((sentence.items || [])[0]);
    sections.push({
      page, y: isNum(at?.y) ? at.y : 0, top: isNum(at?.top) ? at.top : 0, title, size: at?.size || 0, index,
    });
  });
  return sections.sort((a, b) => a.page - b.page || a.y - b.y);
}

/**
 * The section a note belongs to: the last heading at or above its anchor. A note made from a
 * highlight is measured against the heading's `top`, where a highlight of it is anchored; a
 * reading position against its baseline `y` (U15).
 * @returns {{page:number, y:number, top?:number, title:string}|null}
 */
export function sectionFor(sections, anchor) {
  if (!anchor) return null;
  const edge = (section) => (anchor.hl && isNum(section.top) ? section.top : section.y);
  let found = null;
  for (const section of sections || []) {
    if (compareAnchors({ page: section.page, y: edge(section) }, anchor) > SECTION_EPSILON) break;
    found = section;
  }
  return found;
}

/**
 * What the section view writes above a note: its section's heading, or the page it sits
 * on when the script found no heading above it (a paper with no headings at all, or a
 * note in the front matter). Never invented copy — both are things the paper says.
 */
export function sectionHeading(sections, anchor) {
  if (!anchor) return '';
  return sectionFor(sections, anchor)?.title || `Page ${anchor.page}`;
}

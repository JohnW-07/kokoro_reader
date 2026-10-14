/**
 * docstats.js — document-level facts over every `PageGeometry` → the `DocStats` wire
 * payload: body size, running heads/feet, and the bibliography span. Pure: no DOM, so
 * it unit-tests in plain Node. Re-exported by pdfview.js.
 */
import { DEFAULT_GLYPH_SIZE, modalValue, round } from './pagegeom.js';

// ── Tunables ──────────────────────────────────────────────────────────────────
const EDGE_BAND_RATIO = 0.16;         // top/bottom band that may hold a running head/foot
const REPEAT_Y_RATIO = 0.50;          // a short edge line at the same y on ≥half the pages
const REPEAT_Y_TOLERANCE = 2;         // baselines within this many units are the same position
const MAX_RUNNING_HEAD_CHARS = 70;    // a running head is short; a body line at that y is not
const REPEAT_PAGE_RATIO = 0.30, MIN_PAGES_FOR_REPEAT = 4;   // ≥30% of pages, ≥4 pages
// N10: small type in the outer band counts from 2 pages up — a 2-3 page web printout.
// Mirrors config.PRINT_CHROME_BAND / SMALL_EDGE_SIZE_RATIO / MIN_SMALL_EDGE_REPEAT_PAGES.
const OUTER_BAND_RATIO = 0.06, SMALL_EDGE_SIZE_RATIO = 0.75, MIN_SMALL_EDGE_PAGES = 2;

/** Matches a standalone bibliography heading, optionally numbered. */
export const BIBLIOGRAPHY_RE =
    /^\s*(\d+|[IVXLC]+)?[\.\)]?\s*(references|bibliography|works cited)\s*$/i;

/** An appendix ENDS the bibliography; papers routinely put one after the references. */
export const APPENDIX_RE =
    /^\s*(appendix|appendices|supplement(ary|al)?(\s+material)?)\b[\s:.]*(\p{Lu}[\s\S]{0,60})?$/iu;

//: Fraction of the document before which a "References" heading is not believed.
const REFERENCE_MIN_POSITION = 0.35;

// ── Pure helpers: document statistics ─────────────────────────────────────────
/** Lowercase, digits → `#`, punctuation stripped — so "Page 3 of 12" ≡ "Page 7 of 12". */
export function normaliseRepeatKey(text) {
    // MUST stay byte-identical to classify.normalize_key in Python: this key is the only
    // thing linking the `repeated` set computed here to the header rule applied there.
    // Digit *runs* collapse to a single '#', so "Page 3 of 12" and "Page 17 of 12" match.
    return String(text).toLowerCase()
        .replace(/[^\w\s]|_/g, ' ')
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ').trim();
}

const inBand = (l, h, ratio) => h > 0 && (l.y <= ratio * h || l.y >= h - ratio * h);
const isEdgeLine = (l, h) => inBand(l, h, EDGE_BAND_RATIO);
const isSmallEdgeLine = (l, h, bodySize) =>
    inBand(l, h, OUTER_BAND_RATIO) && l.size > 0 && l.size <= SMALL_EDGE_SIZE_RATIO * bodySize;

/**
 * Normalised texts of running heads/feet: edge-band lines on ≥30% of pages. Below
 * MIN_PAGES_FOR_REPEAT pages only small outer-band lines count (needs `bodySize`).
 * Mirrors classify/furniture._repeated_furniture in Python.
 * @param {Array<object>} pages PageGeometry payloads  @param {number} [bodySize]
 * @returns {string[]}
 */
export function computeRepeated(pages, bodySize = 0) {
    const short = pages.length < MIN_PAGES_FOR_REPEAT;
    if (short && (!bodySize || pages.length < MIN_SMALL_EDGE_PAGES)) return [];
    const byKey = new Map();
    for (const page of pages) {
        for (const line of page.lines) {
            if (!isEdgeLine(line, page.height)) continue;
            if (short && !isSmallEdgeLine(line, page.height, bodySize)) continue;
            const key = normaliseRepeatKey(line.text);
            if (!key) continue;
            if (!byKey.has(key)) byKey.set(key, new Set());
            byKey.get(key).add(page.page);
        }
    }
    const minPages = Math.max(MIN_SMALL_EDGE_PAGES, Math.ceil(REPEAT_PAGE_RATIO * pages.length));
    return [...byKey].filter(([, seen]) => seen.size >= minPages).map(([key]) => key);
}

/** Page number of the first bibliography heading in the back half, else `null`. */
export function findReferencePage(pages) {
    return findReferenceSpan(pages).page;
}

/**
 * Where the bibliography starts, and where it stops.
 *
 * Three things the old midpoint rule got wrong on real papers: a paper with a long
 * appendix puts References well before the halfway mark (missed entirely, so the whole
 * bibliography was read aloud); a two-column paper starts its references mid-page, so
 * the conclusion above them was deleted; and an appendix AFTER the references was
 * deleted with them.
 * @returns {{page: number|null, y: number|null, endPage: number|null}}
 */
export function findReferenceSpan(pages) {
    if (!pages.length) return { page: null, y: null, endPage: null };
    const minIndex = Math.floor(pages.length * REFERENCE_MIN_POSITION);
    let start = null;
    for (let i = 0; i < pages.length; i++) {
        if (i < minIndex) continue;
        const hit = pages[i].lines.find(line => BIBLIOGRAPHY_RE.test(line.text));
        if (hit) { start = { page: pages[i].page, y: hit.y }; break; }
    }
    if (!start) return { page: null, y: null, endPage: null };

    let endPage = null;
    for (const page of pages) {
        if (page.page < start.page) continue;
        const appendix = page.lines.find(
            line => line.y > (page.page === start.page ? start.y : -1) && APPENDIX_RE.test(line.text),
        );
        if (appendix) { endPage = page.page; break; }
    }
    return { ...start, endPage };
}

/** Document-level facts; `body_size` is the modal glyph height weighted by character count. */
/**
 * Baseline y values in the edge bands occupied by a short line on most pages.
 *
 * Text repetition misses the commonest running head in a book, because the section title
 * changes: "2.4 Vector Spaces 35", then "2.5 Linear Independence 41". What never changes
 * is the *position*. Guarded by "short" and "in the edge band" so a body paragraph that
 * happens to start at a consistent y is not mistaken for furniture.
 * @param {Array} pages @returns {number[]}
 */
export function computeRepeatedY(pages) {
    if (pages.length < MIN_PAGES_FOR_REPEAT) return [];
    const counts = new Map();
    for (const page of pages) {
        for (const line of runningHeadCandidates(page)) {
            const slot = Math.round(line.y / REPEAT_Y_TOLERANCE) * REPEAT_Y_TOLERANCE;
            counts.set(slot, (counts.get(slot) || 0) + 1);
        }
    }
    const minPages = Math.max(2, Math.ceil(REPEAT_Y_RATIO * pages.length));
    return [...counts].filter(([, n]) => n >= minPages).map(([slot]) => slot).sort((a, b) => a - b);
}

/**
 * At most two lines per page can be a running head: the very first and the very last, and
 * only when each is ALONE on its baseline.
 *
 * Without the "alone" test this rule is catastrophic on two-column papers: the columns
 * share baselines and the leading is constant, so every y in the band recurs on every page
 * and whole paragraphs get deleted as furniture. Ordinary body lines always have a
 * neighbour across the gutter; a running head does not.
 */
function runningHeadCandidates(page) {
    const out = [];
    const usable = page.lines.filter(l => l.text.trim());
    if (usable.length < 2) return out;
    for (const line of [usable[0], usable[usable.length - 1]]) {
        if (!isEdgeLine(line, page.height)) continue;
        if (line.text.trim().length > MAX_RUNNING_HEAD_CHARS) continue;
        const sameRow = usable.filter(l => Math.abs(l.y - line.y) <= REPEAT_Y_TOLERANCE);
        if (sameRow.length !== 1) continue;          // a neighbour means it is body text
        if (!out.includes(line)) out.push(line);
    }
    return out;
}

/** Flatten the bibliography span into the DocStats wire fields. */
function referenceFields(pages) {
    const span = findReferenceSpan(pages);
    return { reference_page: span.page, reference_y: span.y, reference_end_page: span.endPage };
}

export function computeDocStats(pages) {
    const sizes = [], weights = [];
    for (const page of pages) {
        for (const line of page.lines) line.item_size.forEach((size, i) => {
            sizes.push(round(size));
            weights.push((line.item_text[i] || '').length || 1);
        });
    }
    const bodySize = modalValue(sizes, weights, DEFAULT_GLYPH_SIZE) || DEFAULT_GLYPH_SIZE;
    return {
        body_size: bodySize,
        num_pages: pages.length,
        repeated: computeRepeated(pages, bodySize),
        repeated_y: computeRepeatedY(pages),
        ...referenceFields(pages),
    };
}

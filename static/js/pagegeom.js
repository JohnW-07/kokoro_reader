/**
 * pagegeom.js — one page of pdf.js text items → the `PageGeometry` wire payload.
 * Line clustering, script marking, column detection and reading order. Pure: no DOM and
 * no imports, so every rule here unit-tests in plain Node. Re-exported by pdfview.js.
 */

// ── Tunables ──────────────────────────────────────────────────────────────────
export const DEFAULT_GLYPH_SIZE = 10;   // fallback when a font has no height
const LINE_TOL_RATIO = 0.5, MIN_LINE_TOL = 1.0;       // same line if |Δy| ≤ half a glyph
const SPACE_GAP_RATIO = 0.25;         // insert a space when the gap > 25% of glyph height
const SCRIPT_Y_RATIO = 0.10;          // a script sits >10% of a glyph off the baseline
const SCRIPT_SIZE_RATIO = 0.9;        // ...and is set smaller; full-size type never is
const SIZE_DECIMALS = 1;              // sizes are bucketed to 0.1pt before taking the mode
const MIN_COLUMN_BOXES = 4;           // items per column, before column order is considered
const MAX_STRADDLE_RATIO = 0.06;      // at a true gutter almost nothing crosses it
const MAX_COLUMN_BOX_RATIO = 0.55;    // an item wider than this is full-width furniture
const MIN_COLUMN_SHARE = 0.20;        // each column must hold ≥20% of the column-sized items
const MIN_GUTTER_RATIO = 0.008;       // columns must not touch; real gutters can be ~7pt
const MIN_COLUMN_HEIGHT_RATIO = 0.5;  // each column must span ≥50% of the content height
const COLUMN_SEARCH = { lo: 0.40, hi: 0.60, steps: 21 };  // candidate gutter positions
/**
 * Document-level column consensus (J6).
 *
 * The per-page detector is wrong in both directions on real papers, and both directions
 * produce nonsense audio. Measured over 353 pages of 11 papers, the *document* separates
 * the two populations cleanly where no single page can: in a real two-column paper many
 * pages agree on the same gutter x, in a one-column paper the few detections are scattered
 * singletons. Fraction of a document's pages falling in its largest agreeing cluster:
 *
 *   genuinely 2-column   InContextLimitation 7/12 = 58%, VLAW 10/14 = 71%,
 *                        PiZero 13/17 = 76%, PI0_6 14/18 = 78%, VLALitReview 36/38 = 95%
 *   genuinely 1-column   GR00TN1 1/36 = 2.8%, Cosmos 3/75 = 4.0%, MaskViT 1/22 = 4.5%,
 *                        iVideoGPT 2/31 = 6.5%, PSI 4/42 = 9.5%, VJEPA_2 5/48 = 10.4%
 *
 * 25% is the geometric midpoint of that gap (sqrt(10.4 x 58.3) = 24.6): 2.4x above the
 * worst spurious cluster and 2.3x below the weakest genuine one.
 */
const MIN_CONSENSUS_COVERAGE = 0.25;
const MIN_CONSENSUS_SPLITS = 2;       // ... and never a cluster of one: 1/4 also clears 25%
const MIN_CONSENSUS_PAGES = 3;        // below this a fraction means nothing; the page decides
/**
 * Candidates are grid points 1% of the page width apart (6.12pt on Letter, 5.95pt on A4),
 * so +/-9pt binds a centre to the grid step either side and nothing further out. That is
 * exactly VLAW's 294/300/306 — one gutter the search resolved three ways — while keeping
 * VJEPA_2's 330/337/343 cluster from swallowing its 306/312 pair. A page wider than ~900pt
 * spaces the grid further than this and simply fails to bin, which errs single-column.
 */
const SPLIT_BIN_POINTS = 9;

// ── Pure helpers: geometry ────────────────────────────────────────────────────
export const round = (v, d = SIZE_DECIMALS) => Number(v.toFixed(d));

function median(values) {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Most frequent value, weighted (`weights[i]` pairs with `values[i]`); `fallback` if empty. */
export function modalValue(values, weights, fallback = null) {
    const tally = new Map();
    values.forEach((v, i) => tally.set(v, (tally.get(v) || 0) + (weights[i] || 1)));
    let best = fallback, bestWeight = -1;
    for (const [v, w] of tally) if (w > bestWeight) { best = v; bestWeight = w; }
    return best;
}

/**
 * Normalise one pdf.js text item into top-origin page coordinates. `transform=[a,b,c,d,e,f]`
 * has its origin at the BOTTOM left; the wire contract is top-origin, so `y = pageHeight - f`.
 * @param {object} item  pdf.js TextItem
 * @param {number} pageHeight  page height in PDF user units
 */
export function itemGeometry(item, pageHeight) {
    const t = item.transform || [1, 0, 0, 1, 0, 0];
    const size = item.height || Math.hypot(t[2], t[3]) || 0;
    const width = item.width || 0;
    // Sideways text: the text direction is vertical, so `width` measures the item's reach
    // DOWN the page, not across it. Reported as-is it becomes a box straddling the whole
    // text column at one y -- which is how PiZero.pdf p1's arXiv stamp ended up inside a
    // body sentence. Report the narrow margin box it actually occupies instead.
    const turned = Math.abs(t[1]) > Math.abs(t[0]) || Math.abs(t[2]) > Math.abs(t[3]);
    const topPdf = (t[5] || 0) + (turned && t[1] >= 0 ? width : 0);
    return {
        text: typeof item.str === 'string' ? item.str : '',
        x: t[4] || 0,
        y: pageHeight - topPdf,
        width: turned ? size : width,
        size,
        font: item.fontName || '',
        turned,
    };
}

/**
 * Join item strings into one line. pdf.js splits mid-word constantly, so a space goes in only
 * where the gap exceeds SPACE_GAP_RATIO of the glyph height AND neither side already carries
 * whitespace — a naive join produces "in forma tion".
 * @param {Array<{text:string,x:number,width:number,size:number}>} parts  x-ordered
 */
export function joinItemTexts(parts) {
    let out = '';
    parts.forEach((part, i) => {
        if (i > 0) {
            const prev = parts[i - 1];
            const gap = part.x - (prev.x + prev.width);
            const glyph = Math.max(prev.size, part.size) || DEFAULT_GLYPH_SIZE;
            const alreadySpaced = /\s$/.test(out) || /^\s/.test(part.text);
            if (!alreadySpaced && gap > SPACE_GAP_RATIO * glyph) out += ' ';
        }
        out += part.text;
    });
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Cluster items into visual lines by baseline y, tolerating half a glyph height of drift.
 * The reference y follows the *largest* type in the cluster, not the first item seen: items
 * arrive sorted by y, so a line carrying an inline fraction is met numerator-first and an
 * anchor pinned there is already half a glyph high before the real baseline arrives. Cosmos
 * p12's Figure 7 caption shredded into five "lines" that way -- the denominator sat 7.35
 * from the numerator, past a 5.08 tolerance -- and every orphan fragment became its own
 * block. Re-anchoring only ever moves the reference *onto* more type, so a line still
 * cannot ratchet downwards through a paragraph.
 * @param {Array<object>} geoms items from `itemGeometry`, any order
 */
export function clusterLines(geoms) {
    const sorted = [...geoms].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const clusters = [];
    let cur = null;
    for (const g of sorted) {
        const tol = Math.max(LINE_TOL_RATIO * Math.max(g.size, cur ? cur.size : 0), MIN_LINE_TOL);
        if (cur && Math.abs(g.y - cur.refY) <= tol) {
            cur.parts.push(g);
            if (g.size > cur.size) { cur.size = g.size; cur.refY = g.y; }
        } else {
            cur = { refY: g.y, size: g.size, parts: [g] };
            clusters.push(cur);
        }
    }
    return clusters;
}

/**
 * Re-order a cluster's items into reading order and mark its scripts.
 *
 * A cluster spans up to three baselines. x alone is the wrong key across them: a fraction's
 * bar is a drawn rule, never an item, and its denominator is typically set a little to the
 * LEFT of its numerator, so Cosmos p12's `H/s_HW` extracts as `s_HW H`. Ordering by role --
 * numerator, then denominator; base, then script -- and emitting the `/` and `_` the page
 * only drew is what lets `mathspeak` reach it: `_SLASH_RE` and `_SUB_RE` already turn
 * `H/s_HW` into "H over s sub H W".
 *
 * A script must be BOTH off the baseline and set smaller, and must follow a base on its own
 * line: a raised glyph with nothing before it is a footnote or reference marker, and
 * `classify._tag_footnotes` matches `item_text[first]` against the bare marker.
 * The marker goes on the item that carries it, never into the join alone -- `pipeline.
 * _char_stream` walks `text` and `item_text` in lockstep and abandons the block's
 * highlighting if they disagree.
 * @param {Array<object>} parts one cluster's items
 */
function orderByRole(parts) {
    const byX = [...parts].sort((a, b) => a.x - b.x);
    const inked = byX.filter(p => p.text.trim());
    if (inked.length < 2) return byX;
    const baseSize = modalValue(inked.map(p => round(p.size)),
        inked.map(p => p.text.length), 0);
    const onBase = byX.filter(p => round(p.size) === baseSize);
    if (!onBase.length) return byX;
    const baseY = median(onBase.map(p => p.y));
    const role = p => (p.size > baseSize * SCRIPT_SIZE_RATIO
        || Math.abs(p.y - baseY) <= SCRIPT_Y_RATIO * baseSize) ? 0 : (p.y < baseY ? -1 : 1);

    const out = [];
    for (let i = 0; i < byX.length; i++) {
        if (role(byX[i]) === 0) { out.push(byX[i]); continue; }
        let end = i;
        while (end < byX.length && role(byX[end]) !== 0) end++;
        const run = byX.slice(i, end);
        i = end - 1;
        if (!out.length) { out.push(...run); continue; }   // no base: a bare marker
        const above = run.filter(p => role(p) === -1);
        const below = run.filter(p => role(p) === 1);
        out.push(...markScripts(above, above.length && below.length ? '' : '^'));
        out.push(...markScripts(below, above.length ? '/' : '_'));
    }
    return out;
}

/** Prefix a script group's leading glyph with `lead`, and each further size drop with `_`. */
function markScripts(group, lead) {
    let prev = null;
    return group.map(p => {
        if (!p.text.trim()) return p;
        const sep = prev === null ? lead : (round(p.size) < round(prev.size) ? '_' : '');
        prev = p;
        return sep ? { ...p, text: sep + p.text } : p;
    });
}

/** Build one `Line` (minus `idx`) from a cluster's items. */
function buildLine(parts) {
    const ordered = orderByRole(parts);
    const weights = ordered.map(p => p.text.length || 1);
    // pdf.js reports the gap between two text runs as a whitespace item whose `width` is
    // the distance skipped, not a glyph advance: VLALitReview.pdf p7 carries one 1072pt
    // wide on a 576pt page. Inside the box it turns a 74pt figure label into what every
    // width test reads as full-measure prose, so the figure walk stops on its first step
    // and the diagram is read aloud. Only inked items describe where a line actually is.
    const inked = ordered.filter(p => p.text.trim());
    const extent = inked.length ? inked : ordered;
    return {
        text: joinItemTexts(ordered),
        x0: Math.min(...extent.map(p => p.x)),
        x1: Math.max(...extent.map(p => p.x + p.width)),
        y: median(ordered.map(p => p.y)),
        size: modalValue(ordered.map(p => round(p.size)), weights, 0),
        font: modalValue(ordered.map(p => p.font), weights, ''),
        items: ordered.map(p => p.index),
        item_x: ordered.map(p => p.x),
        item_text: ordered.map(p => p.text),
        item_size: ordered.map(p => p.size),
        // Only the item knows it is sideways: its box is one em wide, which upright "III" is too.
        turned: ordered.some(p => p.turned),
    };
}

// ── Pure helpers: column detection and reading order ──────────────────────────
const byReadingOrder = lines => [...lines].sort((a, b) => (a.y - b.y) || (a.x0 - b.x0));

function columnSpansPage(left, right, boxes) {
    const ys = boxes.map(b => b.y), content = Math.max(...ys) - Math.min(...ys);
    if (content <= 0) return false;
    const span = g => Math.max(...g.map(l => l.y)) - Math.min(...g.map(l => l.y));
    return Math.min(span(left), span(right)) >= MIN_COLUMN_HEIGHT_RATIO * content;
}

/**
 * Score one candidate gutter position. The discriminating signal is the *straddle count*:
 * at a real gutter almost no column-sized item crosses it, while a few points either side
 * dozens do. Gutter width is only a sanity check — real two-column layouts can leave as
 * little as 7pt of white space, so requiring a wide band rejects valid pages.
 * @returns {{x:number, straddle:number, gutter:number}|null}
 */
function scoreSplit(boxes, x, pageWidth) {
    const left = boxes.filter(b => b.x1 <= x);
    const right = boxes.filter(b => b.x0 >= x);
    if (left.length < MIN_COLUMN_BOXES || right.length < MIN_COLUMN_BOXES) return null;
    if (Math.min(left.length, right.length) < MIN_COLUMN_SHARE * boxes.length) return null;
    const straddle = boxes.length - left.length - right.length;
    if (straddle > MAX_STRADDLE_RATIO * boxes.length) return null;
    const gutter = Math.min(...right.map(b => b.x0)) - Math.max(...left.map(b => b.x1));
    if (gutter < MIN_GUTTER_RATIO * pageWidth) return null;
    if (!columnSpansPage(left, right, boxes)) return null;
    return { x, straddle, gutter };
}

/** Fewest straddlers wins; a wider gutter breaks ties. */
function betterSplit(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.straddle !== b.straddle) return a.straddle < b.straddle ? a : b;
    return a.gutter >= b.gutter ? a : b;
}

/**
 * x of a two-column gutter, or `null` when single-column. Runs on *item* boxes ({x0,x1,y}),
 * not lines: the two columns share baselines, so only the items reveal the empty band.
 * Deliberately conservative — a false positive makes the audio nonsense.
 * @returns {number|null}
 */
export function detectColumnSplit(boxes, pageWidth) {
    if (!(pageWidth > 0)) return null;
    // Judge on column-sized items only: a title or full-width figure is *expected* to cross
    // the gutter, and counting those as straddlers vetoes the split on the pages needing it.
    const narrow = boxes.filter(b => b.x1 - b.x0 <= MAX_COLUMN_BOX_RATIO * pageWidth);
    if (narrow.length < MIN_COLUMN_BOXES * 2) return null;

    let best = null;
    const steps = COLUMN_SEARCH.steps - 1;
    for (let i = 0; i <= steps; i++) {
        const frac = COLUMN_SEARCH.lo + (COLUMN_SEARCH.hi - COLUMN_SEARCH.lo) * (i / steps);
        best = betterSplit(best, scoreSplit(narrow, pageWidth * frac, pageWidth));
    }
    return best ? best.x : null;
}

const boxOf = g => ({ x0: g.x, x1: g.x + g.width, y: g.y });
const linesFrom = geoms => clusterLines(geoms).map(c => buildLine(c.parts));

/** The `.str` items of one page, indexed as `renderTextLayer` indexes them. */
const pageGeoms = (items, pageHeight) => items
    .filter(item => typeof item.str === 'string')
    .map((item, index) => ({ ...itemGeometry(item, pageHeight), index }))
    .filter(g => g.text !== '');

/**
 * One page's vote on where the gutter is, for `consensusSplit` to pool. Shares `pageGeoms`
 * with `buildPageGeometry` so a page can never be judged on different items than it is laid
 * out from. Sideways text is excluded for the reason given in `buildPageGeometry`.
 * @returns {number|null}
 */
export function splitCandidate(items, pageWidth, pageHeight) {
    return detectColumnSplit(pageGeoms(items, pageHeight).filter(g => !g.turned).map(boxOf), pageWidth);
}

/**
 * The whole document's verdict on its column layout, from every page's `splitCandidate`.
 * One entry per page, in page order; a page that failed to extract contributes `null` and so
 * only dilutes coverage, which can only push the answer towards single-column.
 *
 * The three return values are exactly the three `splitHint` values, so the result feeds
 * straight into `buildPageGeometry`:
 *   number     — this is the gutter; every page uses it, including pages that found nothing
 *   null       — this document is single-column; no page is split
 *   undefined  — too few pages to say; each page keeps its own per-page verdict
 * @param {Array<number|null>} candidates
 */
export function consensusSplit(candidates) {
    if (candidates.length < MIN_CONSENSUS_PAGES) return undefined;
    const found = candidates.filter(x => typeof x === 'number');
    const cluster = c => found.filter(x => Math.abs(x - c) <= SPLIT_BIN_POINTS);
    const largest = found.reduce((best, c) => (cluster(c).length > best.length ? cluster(c) : best), []);
    const need = Math.max(MIN_CONSENSUS_SPLITS, MIN_CONSENSUS_COVERAGE * candidates.length);
    // The median, not the bin centre: a cluster's members are the same gutter resolved to
    // neighbouring grid points, and the one most pages actually landed on is the safest x.
    // Snapped back onto a real vote, because an even-sized cluster's median is an average:
    // [300, 300, 306, 306] would yield 303, a gutter no page found, and `extractGeometry`
    // compares a page's own vote with the verdict exactly -- so every page would be stale
    // and the whole document re-extracted.
    if (largest.length < need) return null;
    const mid = median(largest);
    return largest.reduce((best, x) => (Math.abs(x - mid) < Math.abs(best - mid) ? x : best));
}

/**
 * Cluster a page's items into lines in reading order: top-to-bottom for one column, whole left
 * column then whole right when a gutter is found. Clustering runs per column so two columns
 * sharing a baseline never merge into one zig-zagging line.
 * @param {number|null|undefined} splitHint  the document's verdict; `undefined` to detect here
 */
export function orderPageLines(geoms, pageWidth, splitHint) {
    const split = splitHint === undefined ? detectColumnSplit(geoms.map(boxOf), pageWidth) : splitHint;
    if (split === null) return byReadingOrder(linesFrom(geoms));
    // Text that runs across the gutter takes everything on its baseline, even the items
    // that sit wholly on one side: PiZero's title opens with a "π0" left of it (U12). Only
    // text reaching an em past the gutter on both sides counts: a blank item, or a glyph
    // that merely touches it (VLAW p2's "fi"), would stitch the two columns together.
    const spans = g => g.text.trim() !== '' && Math.min(split - g.x, g.x + g.width - split) >= g.size;
    const onFull = new Set(clusterLines(geoms).filter(c => c.parts.some(spans)).flatMap(c => c.parts));
    const side = g => (onFull.has(g) ? 'full' : g.x + g.width <= split ? 'left' : g.x >= split ? 'right' : 'full');
    const [left, right, full] = ['left', 'right', 'full'].map(s => linesFrom(geoms.filter(g => side(g) === s)));
    const colYs = [...left, ...right].map(l => l.y);
    // Nothing sits inside either column: a full-page figure or table, under a *document*
    // verdict that the page itself would never have produced (J6). Without this, `top` is
    // Infinity and `bottom` -Infinity, so the above-the-columns and below-the-columns
    // buckets each match every line and the whole page is emitted twice.
    if (!colYs.length) return byReadingOrder(linesFrom(geoms));
    const top = Math.min(...colYs), bottom = Math.max(...colYs);
    return [
        ...byReadingOrder(full.filter(l => l.y < top)),
        ...byReadingOrder([...left, ...full.filter(l => l.y >= top && l.y <= bottom)]),
        ...byReadingOrder(right),
        ...byReadingOrder(full.filter(l => l.y > bottom)),
    ];
}

/**
 * Turn one page's raw `getTextContent().items` into a `PageGeometry` payload.
 * TRAP (kept from the original implementation): `renderTextLayer` only creates spans for
 * TextItem entries (those with `.str`); TextMarkedContent entries are skipped. The `items`
 * indices we emit MUST index into that same filtered array, or highlights silently land on
 * the wrong words.
 * @param {number} page 1-based; @param width/height in PDF user units
 * @param {number|null|undefined} splitHint  the document's gutter from `consensusSplit`;
 *   omit it and the page decides for itself, which is what every pre-J6 caller gets.
 */
export function buildPageGeometry(items, page, width, height, splitHint) {
    const geoms = pageGeoms(items, height);
    // Sideways text never shares a line with upright text, and must not be judged as a
    // column box either: one margin stamp is wider than the page once its vertical reach
    // is read as horizontal, and that alone can veto a real gutter.
    const lines = spliceByY(
        orderPageLines(geoms.filter(g => !g.turned), width, splitHint),
        linesFrom(geoms.filter(g => g.turned)),
    );
    return { page, width, height, lines: lines.map((line, idx) => ({ idx, ...line })) };
}

/** Sideways lines placed back into the upright reading order at their own y. */
function spliceByY(lines, extra) {
    return extra.reduce((acc, line) => {
        const at = acc.findIndex(l => l.y > line.y);
        return at < 0 ? [...acc, line] : [...acc.slice(0, at), line, ...acc.slice(at)];
    }, lines);
}

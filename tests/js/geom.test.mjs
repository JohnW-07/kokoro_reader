// Throwaway harness: feeds synthetic pdf.js-shaped items to the pure helpers in pdfview.js.
import {
    buildPageGeometry, clusterLines, itemGeometry, joinItemTexts,
    modalValue, computeRepeated, computeDocStats, detectColumnSplit, BIBLIOGRAPHY_RE,
    consensusSplit, splitCandidate,
} from '../../static/js/pdfview.js';

const H = 792, W = 612;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const eq = (name, got, want) =>
    ok(name, JSON.stringify(got) === JSON.stringify(want), `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

// pdf.js-shaped item: transform [a,b,c,d,e,f] with f in BOTTOM-origin PDF space.
const item = (str, x, yTop, size = 10, width = null, font = 'g_d0_f1') => ({
    str, width: width === null ? str.length * size * 0.5 : width, height: size,
    transform: [size, 0, 0, size, x, H - yTop], fontName: font,
});
const marked = () => ({ type: 'beginMarkedContent', id: 'span' });   // no .str

console.log('\n1. baseline clustering + top-origin y flip');
{
    const items = [item('alpha', 72, 700.0), item('beta', 140, 700.3), item('next', 72, 720)];
    const g = buildPageGeometry(items, 1, W, H);
    eq('   y=700.0 and y=700.3 (size 10) cluster into one line', g.lines.length, 2);
    eq('   line 0 items', g.lines[0].items, [0, 1]);
    eq('   line 1 items', g.lines[1].items, [2]);
    const geo = itemGeometry(item('x', 72, 700.0), H);
    eq('   y is flipped: f=92 on a 792pt page -> y=700', geo.y, 700);
    eq('   line y (median baseline) is top-origin', g.lines[0].y, 700.15);
    eq('   x0/x1 from item extents', [g.lines[0].x0, g.lines[0].x1], [72, 140 + 4 * 5]);
    ok('   raw f is NOT emitted', g.lines[0].y !== 92);
    // 10pt apart with a 40pt glyph must NOT split (tolerance scales with glyph height)
    const big = clusterLines([item('A', 72, 100, 40), item('B', 200, 110, 40)]
        .map((it, index) => ({ ...itemGeometry(it, H), index })));
    eq('   tolerance scales with glyph size (40pt glyphs, dy=10)', big.length, 1);
    const small = clusterLines([item('A', 72, 100, 8), item('B', 200, 110, 8)]
        .map((it, index) => ({ ...itemGeometry(it, H), index })));
    eq('   ... but 8pt glyphs 10pt apart are two lines', small.length, 2);
}

console.log('\n2. gap -> space join rule');
{
    // "in" ends at 100+10=110; "formation" starts at 110.5 -> gap 0.5 < 0.25*10
    const tight = [item('in', 100, 300, 10, 10), item('formation', 110.5, 300, 10, 45)];
    eq('   tiny gap joins mid-word', buildPageGeometry(tight, 1, W, H).lines[0].text, 'information');
    // "the" ends at 200+15=215; "cat" starts at 220 -> gap 5 > 2.5
    const wide = [item('the', 200, 300, 10, 15), item('cat', 220, 300, 10, 15)];
    eq('   wide gap inserts a space', buildPageGeometry(wide, 1, W, H).lines[0].text, 'the cat');
    eq('   existing trailing space is not doubled',
        joinItemTexts([{ text: 'the ', x: 200, width: 15, size: 10 }, { text: 'cat', x: 220, width: 15, size: 10 }]),
        'the cat');
    eq('   existing leading space is not doubled',
        joinItemTexts([{ text: 'the', x: 200, width: 15, size: 10 }, { text: ' cat', x: 220, width: 15, size: 10 }]),
        'the cat');
}

console.log('\n3. TextMarkedContent filtering keeps item indices aligned');
{
    const items = [marked(), item('alpha', 72, 300), marked(), item('beta', 140, 300)];
    const g = buildPageGeometry(items, 1, W, H);
    eq('   indices are into the .str-filtered array', g.lines[0].items, [0, 1]);
    eq('   text survives', g.lines[0].text, 'alpha beta');
}

console.log('\n4. two-column ordering');
{
    const items = [item('A Two Column Paper Title', 72, 60, 14, 468)];   // full width straddler
    for (let i = 0; i < 20; i++) {
        const y = 100 + i * 31;
        items.push(item(`left line ${i}`, 72, y, 10, 218));    // 72..290
        items.push(item(`right line ${i}`, 322, y, 10, 218));  // 322..540  (gutter 32pt)
    }
    const boxes = items.map(it => itemGeometry(it, H)).map(g => ({ x0: g.x, x1: g.x + g.width, y: g.y }));
    ok('   gutter detected near the page centre', detectColumnSplit(boxes, W) !== null,
        `split=${detectColumnSplit(boxes, W)}`);
    const g = buildPageGeometry(items, 1, W, H);
    const texts = g.lines.map(l => l.text);
    const lastLeft = texts.map((t, i) => t.startsWith('left') ? i : -1).reduce((a, b) => Math.max(a, b));
    const firstRight = texts.findIndex(t => t.startsWith('right'));
    eq('   title first', texts[0], 'A Two Column Paper Title');
    ok('   every left-column line precedes every right-column line',
        lastLeft < firstRight, `lastLeft=${lastLeft} firstRight=${firstRight}`);
    eq('   left and right sharing a baseline are NOT merged', g.lines.length, 41);
    eq('   idx renumbered sequentially', g.lines.map(l => l.idx), [...Array(41).keys()]);
    eq('   reading order, first four', texts.slice(0, 4),
        ['A Two Column Paper Title', 'left line 0', 'left line 1', 'left line 2']);
    eq('   ... and the seam at the gutter', texts.slice(19, 23),
        ['left line 18', 'left line 19', 'right line 0', 'right line 1']);
}

console.log('\n5. single column is NOT mistaken for two columns');
{
    const items = [];
    for (let i = 0; i < 30; i++) items.push(item(`body line ${i} of prose`, 72, 100 + i * 20, 10, 468));
    eq('   full-width prose yields no split', detectColumnSplit(
        items.map(it => itemGeometry(it, H)).map(g => ({ x0: g.x, x1: g.x + g.width, y: g.y })), W), null);
    const g = buildPageGeometry(items, 1, W, H);
    eq('   plain top-to-bottom order', g.lines.map(l => l.text).slice(0, 3),
        ['body line 0 of prose', 'body line 1 of prose', 'body line 2 of prose']);
}

console.log('\n6. repeated running heads');
{
    const page = n => ({
        page: n, width: W, height: H,
        lines: [
            { idx: 0, text: 'Preprint under review — page ' + n, x0: 72, x1: 540, y: 40, size: 8,
              items: [0], item_x: [72], item_text: ['Preprint'], item_size: [8] },
            { idx: 1, text: `Body text on page ${n}`, x0: 72, x1: 540, y: 400, size: 10,
              items: [1], item_x: [72], item_text: ['Body'], item_size: [10] },
            { idx: 2, text: n === 3 ? 'A one-off footer note' : `${n}`, x0: 72, x1: 540, y: 760,
              size: 8, items: [2], item_x: [72], item_text: ['f'], item_size: [8] },
        ],
    });
    const pages = [1, 2, 3, 4, 5, 6, 7, 8].map(page);
    const rep = computeRepeated(pages);
    ok('   header on 8/8 pages is repeated', rep.includes('preprint under review page #'), JSON.stringify(rep));
    ok('   one-off footer is not repeated', !rep.includes('a one off footer note'), JSON.stringify(rep));
    ok('   mid-page body line is never repeated', !rep.some(r => r.startsWith('body text')), JSON.stringify(rep));

    // header on exactly 6 of 8 pages (30% floor = 3) must still count
    const mixed = pages.map((p, i) => i < 6 ? p
        : { ...p, lines: p.lines.map(l => l.idx === 0 ? { ...l, text: 'Something else entirely' } : l) });
    ok('   header on 6/8 pages is repeated', computeRepeated(mixed).includes('preprint under review page #'),
        JSON.stringify(computeRepeated(mixed)));
    eq('   a 3-page doc reports nothing', computeRepeated(pages.slice(0, 3)), []);

    // N10: small type in the outer 6% band repeats on a 2-page printout (Avelo booking no.)
    const short = (size) => [1, 2].map(p => ({
        page: p, width: W, height: H, lines: [
            { idx: 0, text: 'Booking number: #3341144806', x0: 466, x1: 582, y: 26.3, size,
              items: [0], item_x: [466], item_text: ['Booking number: #3341144806'], item_size: [size] },
            { idx: 1, text: 'b'.repeat(300), x0: 72, x1: 540, y: 300, size: 10,
              items: [1], item_x: [72], item_text: ['b'.repeat(300)], item_size: [10] },
        ],
    }));
    eq('   small edge line on 2/2 pages is repeated', computeDocStats(short(6)).repeated, ['booking number #']);
    eq('   body-size edge line on 2/2 pages is not', computeDocStats(short(10)).repeated, []);
    eq('   small edge line on 1 page is not', computeDocStats(short(6).slice(0, 1)).repeated, []);
}

console.log('\n7. doc stats: modal body size + reference page');
{
    const line = (text, size, y, page) => ({
        idx: 0, text, x0: 72, x1: 540, y, size, items: [0], item_x: [72],
        item_text: [text], item_size: [size],
    });
    const pages = [
        { page: 1, width: W, height: H, lines: [line('Title of the paper', 18, 100), line('a'.repeat(400), 9.9, 300)] },
        { page: 2, width: W, height: H, lines: [line('b'.repeat(400), 9.9, 300)] },
        { page: 3, width: W, height: H, lines: [line('c'.repeat(50), 7.5, 300)] },
        { page: 4, width: W, height: H, lines: [line('References', 11, 100), line('d'.repeat(200), 9.9, 300)] },
    ];
    const stats = computeDocStats(pages);
    eq('   body_size is the char-weighted mode', stats.body_size, 9.9);
    eq('   num_pages', stats.num_pages, 4);
    eq('   reference_page found in the back half', stats.reference_page, 4);
    eq('   modalValue is weighted, not counted', modalValue(['a', 'b', 'b'], [10, 1, 1], null), 'a');
    const front = [{ page: 1, width: W, height: H, lines: [line('References', 11, 100)] },
                   ...pages.slice(1, 3), { ...pages[3], lines: [line('d'.repeat(200), 9.9, 300)] }];
    eq('   a heading in the front half only is ignored', computeDocStats(front).reference_page, null);
    for (const h of ['References', 'REFERENCES', '5. References', 'VI) Bibliography', 'Works Cited']) {
        ok(`   heading matches: ${JSON.stringify(h)}`, BIBLIOGRAPHY_RE.test(h));
    }
    for (const h of ['References to prior work follow.', 'See references']) {
        ok(`   non-heading rejected: ${JSON.stringify(h)}`, !BIBLIOGRAPHY_RE.test(h));
    }
}

console.log('\n9. rotated margin stamps do not join a body line');
{
    // PiZero.pdf p1 prints its arXiv stamp up the left margin: transform [0,20,-20,0,32,228.8].
    // `itemGeometry` read `width` (334.4, the stamp's *vertical* extent) as horizontal reach,
    // so the stamp landed across the text column at one y and clustered into the body line
    // sitting there -- "The model arXiv:2410.24164v4 [cs.LG] 8 Jan 2026can then be used ...".
    const stamp = {
        str: 'arXiv:2410.24164v4 [cs.LG] 8 Jan 2026', width: 334.4, height: 20,
        transform: [0, 20, -20, 0, 32, 228.8], fontName: 'g_d0_f9',
    };
    const body = item('can then be used directly to perform tasks', 49, 560.1);
    const g = buildPageGeometry([stamp, body], 1, W, H);

    eq('   the stamp is its own line', g.lines.length, 2);
    ok('   no line mixes the stamp into prose',
        g.lines.every(l => !(l.text.includes('arXiv') && l.text.includes('perform'))),
        JSON.stringify(g.lines.map(l => l.text)));
    const turned = g.lines.find(l => l.text.includes('arXiv'));
    ok('   it keeps a margin-width box, not a column-crossing one',
        turned.x1 - turned.x0 <= 2 * stamp.height, `${turned.x0}..${turned.x1}`);
    ok('   and it stays in page order, not appended after the body',
        g.lines.indexOf(turned) === 0, String(g.lines.indexOf(turned)));
    eq('   it is flagged turned, and the body line is not (U31)', g.lines.map(l => l.turned), [true, false]);
}

console.log('\n10. column detection is decided per DOCUMENT, not per page (J6)');
{
    // ── the three page shapes the corpus actually contains ────────────────────
    // A clean two-column page: 20 lines a side, columns 72..290 and 322..540.
    const twoColumn = (extraStraddlers = 0) => {
        const items = [];
        for (let i = 0; i < 20; i++) {
            const y = 100 + i * 31;
            items.push(item(`left line ${i}`, 72, y, 10, 218));
            items.push(item(`right line ${i}`, 322, y, 10, 218));
        }
        // PiZero p1's veto: a *centred* title, author list and URL are narrow enough to pass
        // MAX_COLUMN_BOX_RATIO yet still cross the gutter, so they count as straddlers.
        for (let i = 0; i < extraStraddlers; i++) items.push(item(`Centred Line ${i}`, 194, 60 + i * 14, 11, 224));
        return items;
    };
    // A single-column page whose table rows happen to look like two columns.
    const spurious = () => {
        const items = [];
        for (let i = 0; i < 12; i++) {
            const y = 200 + i * 20;
            items.push(item(`row label ${i}`, 72, y, 10, 150));   // 72..222
            items.push(item(`0.${i}4 0.${i}7`, 260, y, 10, 120)); // 260..380
        }
        return items;
    };
    const plainPage = () => {
        const items = [];
        for (let i = 0; i < 30; i++) items.push(item(`body line ${i} of prose`, 72, 100 + i * 20, 10, 468));
        return items;
    };
    const texts = g => g.lines.map(l => l.text);

    // ── the per-page candidate, exposed so a document can be judged as a whole ─
    const gutter = splitCandidate(twoColumn(), W, H);
    ok('   splitCandidate finds the gutter on a clean two-column page', gutter !== null, String(gutter));
    eq('   ... and nothing on full-width prose', splitCandidate(plainPage(), W, H), null);
    eq('   ... and nothing on a page with no items at all', splitCandidate([], W, H), null);
    eq('   a genuine two-column page with centred furniture is vetoed (the PiZero p1 defect)',
        splitCandidate(twoColumn(6), W, H), null);

    // ── 1. five pages agree, one detects nothing -> all six use the consensus ──
    const doc6 = [gutter, gutter, gutter, gutter, gutter, null];
    eq('   6-page doc, 5 agreeing -> consensus is the shared gutter', consensusSplit(doc6), gutter);
    const vetoed = twoColumn(6);
    const forced = buildPageGeometry(vetoed, 6, W, H, consensusSplit(doc6));
    const lastLeft = texts(forced).map((t, i) => t.startsWith('left') ? i : -1).reduce((a, b) => Math.max(a, b));
    const firstRight = texts(forced).findIndex(t => t.startsWith('right'));
    ok('   the vetoed page now reads column by column, not across the gutter',
        lastLeft < firstRight, `lastLeft=${lastLeft} firstRight=${firstRight}`);
    ok('   ... where per-page detection still reads straight across it',
        texts(buildPageGeometry(vetoed, 6, W, H)).some(t => t.includes('left') && t.includes('right')),
        JSON.stringify(texts(buildPageGeometry(vetoed, 6, W, H)).slice(0, 3)));

    // ── 2. three scattered singletons over 30 pages -> no page is split ────────
    const scattered = Array.from({ length: 30 }, (_, i) => (i === 4 ? 250.92 : i === 17 ? 306 : i === 25 ? 355 : null));
    eq('   30-page doc, 3 scattered singletons -> no consensus', consensusSplit(scattered), null);
    const killed = buildPageGeometry(spurious(), 5, W, H, consensusSplit(scattered));
    ok('   the spurious page reads top to bottom once the document overrules it',
        texts(killed)[0].includes('row label 0') && texts(killed)[0].includes('0.04'),
        JSON.stringify(texts(killed).slice(0, 3)));
    ok('   ... where per-page detection interleaved it',
        splitCandidate(spurious(), W, H) !== null, String(splitCandidate(spurious(), W, H)));

    // ── 3. VLAW: splits at 306/300/294 are one gutter, not three ───────────────
    const vlaw = [306, 306, 306, 306, 306, 306, 300, 300, 294, 294, null, null, null, null];
    eq('   306/300/294 bin into a single consensus', consensusSplit(vlaw), 306);
    eq('   ... and the bin is tight enough to exclude the next grid step out',
        consensusSplit([306, 306, 306, 318, 318, 318, 318, 318, 318, 318]), 318);

    // ── 4. a page that found a different gutter is corrected, not left alone ───
    const offset = [];
    for (let i = 0; i < 20; i++) {
        const y = 100 + i * 31;
        offset.push(item(`narrow ${i}`, 72, y, 10, 158));   //  72..230
        offset.push(item(`wide ${i}`, 260, y, 10, 280));    // 260..540
    }
    const own = splitCandidate(offset, W, H);
    ok('   the outlier page detects its own, different gutter', own !== null && Math.abs(own - gutter) > 20,
        `own=${own} consensus=${gutter}`);
    const strong = [gutter, gutter, gutter, gutter, gutter, gutter, gutter, gutter, gutter, own];
    eq('   one outlier does not move the consensus', consensusSplit(strong), gutter);
    const corrected = buildPageGeometry(offset, 10, W, H, consensusSplit(strong));
    eq('   the outlier page is rebuilt at the consensus x',
        JSON.stringify(corrected), JSON.stringify(buildPageGeometry(offset, 10, W, H, gutter)));
    ok('   ... which is genuinely different from what it decided alone',
        JSON.stringify(corrected) !== JSON.stringify(buildPageGeometry(offset, 10, W, H)));

    // ── 5. empty and failed pages neither poison the consensus nor throw ───────
    const withHoles = [gutter, gutter, gutter, gutter, gutter, null, null, null];
    eq('   pages that extracted nothing only dilute coverage', consensusSplit(withHoles), gutter);
    eq('   an empty page builds cleanly under a consensus', buildPageGeometry([], 3, W, H, gutter).lines, []);
    eq('   ... and under a forced single column', buildPageGeometry([], 3, W, H, null).lines, []);
    eq('   a document of nothing but failures has no consensus',
        consensusSplit([null, null, null, null, null, null]), null);

    // ── 6. too few pages to judge -> the per-page detector still decides ───────
    eq('   a one-page document defers to the page', consensusSplit([gutter]), undefined);
    eq('   ... even when that page found nothing', consensusSplit([null]), undefined);
    eq('   a two-page document defers as well', consensusSplit([gutter, null]), undefined);
    eq('   an empty document defers', consensusSplit([]), undefined);
    eq('   deferring means today\'s per-page output, byte for byte',
        JSON.stringify(buildPageGeometry(twoColumn(), 1, W, H, consensusSplit([gutter]))),
        JSON.stringify(buildPageGeometry(twoColumn(), 1, W, H)));

    // ── 7. the coverage gate sits where the corpus says it does ───────────────
    const cov = (agreeing, pages) =>
        consensusSplit([...Array(agreeing).fill(306), ...Array(pages - agreeing).fill(null)]);
    eq('   5 of 20 pages (25%) is a consensus', cov(5, 20), 306);
    eq('   4 of 20 pages (20%) is not', cov(4, 20), null);
    eq('   VJEPA_2\'s worst spurious cluster (5 of 48) is rejected', cov(5, 48), null);
    eq('   InContextLimitation\'s weakest genuine one (7 of 12) is accepted', cov(7, 12), 306);
    eq('   a lone split in a short document is never a consensus', cov(1, 4), null);
}

console.log('\n11. a document verdict a page cannot use (J6 follow-ups)');
{
    // ── a full-page figure inside a two-column document ───────────────────────
    // Nothing on it sits wholly inside either column, so the verdict's left and right
    // buckets are both empty. Before the guard, the above- and below-the-columns
    // buckets each matched every line and the page was emitted twice -- every sentence
    // read aloud twice, with the highlight indices renumbered under it.
    const straddlers = [
        item('A full width heading across the whole measure', 72, 100, 10, 460),
        item('Another full width line of the same table', 72, 120, 10, 460),
        item('And a third full width line here as well', 72, 140, 10, 460),
    ];
    const forced = buildPageGeometry(straddlers, 7, W, H, 306);
    eq('   every line survives exactly once under a forced split', forced.lines.length, 3);
    eq('   ... and in reading order, as an unsplit page',
        JSON.stringify(forced.lines.map(l => l.text)),
        JSON.stringify(buildPageGeometry(straddlers, 7, W, H, null).lines.map(l => l.text)));

    // ── the verdict is always a gutter some page actually voted for ────────────
    // `median` averages an even-sized cluster, and `extractGeometry` compares each
    // page's own vote with the verdict exactly: a verdict of 303 makes every page
    // disagree, and the whole document is extracted a second time.
    const evenCluster = [300, 300, 306, 306, null, null];
    ok('   an even cluster does not average into a gutter nobody found',
        evenCluster.includes(consensusSplit(evenCluster)),
        `got ${consensusSplit(evenCluster)}`);
    eq('   an odd cluster still answers with its median',
        consensusSplit([300, 306, 306, null, null, null]), 306);
}

console.log('\n12. a whitespace item\'s width does not stretch the line box');
{
    // pdf.js reports the gap between two text runs as a whitespace item whose `width` is
    // the distance skipped, not a glyph advance: VLALitReview.pdf p7 carries one 1072pt
    // wide on a 576pt page. Inside the box it turns a 74pt figure label into what every
    // width test reads as full-measure prose, so the figure walk stops on its first step
    // and the diagram is read aloud.
    const label = item('Bimanual UR5e', 346.1, 127.6, 5.3, 74.0);
    const gap = { str: '   ', width: 1072.8, height: 0, transform: [5.3, 0, 0, 5.3, 420.1, H - 127.6], fontName: 'g_d0_f1' };
    const g = buildPageGeometry([label, gap], 1, W, H);

    eq('   the gap joins the label\'s line', g.lines.length, 1);
    const line = g.lines[0];
    ok('   the box stops at the last inked glyph',
        line.x1 - line.x0 <= 74.0, `${line.x0}..${line.x1}`);
    ok('   and cannot run wider than the page', line.x1 <= W, String(line.x1));
    eq('   the whitespace item is still carried for highlighting', line.items, [0, 1]);
    // A line that is *only* whitespace has no inked extent to fall back on.
    const blank = buildPageGeometry([gap], 1, W, H).lines[0];
    ok('   an all-whitespace line still reports a box', Number.isFinite(blank.x1));
}

console.log('\n13. a stacked inline fraction is one line, in reading order');
{
    // Cosmos p12 Figure 7 sets `H/s_HW x W/s_HW` inline. pdf.js hands back three baselines
    // per visual line -- numerator 257.88, main 261.80, denominator 265.23 with its own
    // subscript at 266.24 -- and the fraction bar is a drawn rule, not an item. Anchoring
    // the cluster on the first item (the numerator) shredded the caption into five "lines",
    // and ordering a cluster by x alone extracted the denominator before the numerator.
    const main = (str, x, w) => item(str, x, 261.80, 10.16, w);
    const num = (str, x, w) => item(str, x, 257.88, 6.97, w, 'g_d0_f5');
    const den = (str, x, w) => item(str, x, 265.23, 6.97, w, 'g_d0_f5');
    const dsub = (str, x, w) => item(str, x, 266.24, 4.98, w, 'g_d0_f6');
    const items = [
        main('Figure 7:', 62.4, 40.55), main(' ', 102.9, 3.31),
        main('Visualization of discrete tokenizers', 106.3, 243.19),
        main('. Tokens along spatial (', 349.5, 106.43), main(' ', 455.9, 6.24),
        num('\u{1d43b}', 462.3, 6.52), den('\u{1d460}', 457.1, 3.76),
        dsub('\u{1d43b}\u{1d44a}', 460.9, 12.27), dsub(' ', 473.1, 5.26),
        item('×', 478.4, 261.80, 9.96, 7.75, 'g_d0_f7'),
        item(' ', 486.1, 261.80, 9.96, 8.31, 'g_d0_f7'),
        num('\u{1d44a}', 494.5, 7.49), den('\u{1d460}', 490.0, 3.76),
        dsub('\u{1d43b}\u{1d44a}', 493.8, 12.27), dsub(' ', 506.1, 2.56),
        main(') and', 508.6, 24.29),
    ];

    eq('   all three baselines cluster into one line',
        clusterLines(items.map(it => itemGeometry(it, H))).length, 1);
    const line = buildPageGeometry(items, 12, W, H).lines[0];
    eq('   numerator precedes denominator, nested subscript marked',
        line.text,
        'Figure 7: Visualization of discrete tokenizers. Tokens along spatial ( '
        + '\u{1d43b}/\u{1d460}_\u{1d43b}\u{1d44a} × '
        + '\u{1d44a}/\u{1d460}_\u{1d43b}\u{1d44a} ) and');
    // The highlight mapping walks `text` and `item_text` in lockstep, so a marker the join
    // emitted must also live on the item that carries it (pipeline._char_stream).
    eq('   the join is exactly the item texts',
        line.item_text.join('').replace(/\s+/g, ' ').trim(), line.text);
    eq('   every item is still carried', [...line.items].sort((a, b) => a - b),
        items.map((_, i) => i));
}

console.log('\n14. a bare script needs a base, and only a smaller glyph is a script');
{
    // A raised glyph with nothing before it on the line is a footnote or reference marker,
    // not an exponent: `_tag_footnotes` matches `line.item_text[first]` against the bare
    // marker and a `^` prefix would hide it.
    const marker = buildPageGeometry([
        item('1', 72.0, 697.0, 6.0, 3.0), item('Equal contribution.', 76.0, 700.0, 9.0, 80.0),
    ], 1, W, H).lines[0];
    eq('   a line-leading marker is left bare', marker.text, '1Equal contribution.');

    const sub = buildPageGeometry([
        item('x', 72.0, 700.0, 10.0, 5.0), item('t', 77.0, 702.5, 6.0, 3.0),
        item(' is the state', 80.5, 700.0, 10.0, 60.0),
    ], 1, W, H).lines[0];
    eq('   a trailing subscript is marked', sub.text, 'x_t is the state');

    const sup = buildPageGeometry([
        item('R', 72.0, 700.0, 10.0, 6.0), item('d', 78.0, 697.5, 6.0, 3.0),
        item(' is the space', 81.5, 700.0, 10.0, 60.0),
    ], 1, W, H).lines[0];
    eq('   a trailing superscript is marked', sup.text, 'R^d is the space');

    // Same baseline, same size, a bigger drop cap: neither is a script.
    const plain = buildPageGeometry([
        item('The', 72.0, 700.0, 14.0, 22.0), item(' model learns', 94.0, 700.0, 10.0, 60.0),
    ], 1, W, H).lines[0];
    eq('   full-size type on the baseline is never a script', plain.text, 'The model learns');
}

console.log('\n15. an item on a full-width line\'s baseline belongs to that line (U12 D2)');
{
    // PiZero p1's title, as pdf.js gives it: "π" and its subscript sit wholly left of the
    // document's gutter, the rest of the line crosses it. Filed by x alone, "π0" became a
    // line of its own in the left column, read after the text it opens, and the title's
    // first line no longer wrapped into its second.
    const title = [
        item('\u03c0', 73.8, 78.3, 24.79, 13.8, 'g_d6_f2'),
        item('0', 87.6, 81.9, 17.22, 7.9, 'g_d6_f2'),
        item(': A Vision-Language-Action Flow Model for', 96.0, 78.28, 23.91, 442.2, 'g_d6_f3'),
        item('General Robot Control', 194.0, 106.17, 23.91, 224.0, 'g_d6_f3'),
        item('Physical Intelligence', 257.4, 137.55, 10.96, 97.1, 'g_d6_f4'),
    ];
    const split = buildPageGeometry(title, 1, W, H, 306);
    eq('   the title line opens with its own first glyph', split.lines[0].text,
        '\u03c0_0: A Vision-Language-Action Flow Model for');
    eq('   ... and its second line follows it', split.lines[1].text, 'General Robot Control');
    eq('   the lines are the unsplit page\'s', split.lines.map(l => l.text),
        buildPageGeometry(title, 1, W, H, null).lines.map(l => l.text));

    // A column's own line one step under a full-width one keeps its column.
    const under = [
        item('A full width heading across the whole measure', 72, 100, 10, 460),
        item('left column text', 72, 114, 10, 200), item('right column text', 330, 114, 10, 200),
        item('left again', 72, 126, 10, 200), item('right again', 330, 126, 10, 200),
    ];
    eq('   column lines under a full-width line stay in their columns',
        buildPageGeometry(under, 1, W, H, 306).lines.map(l => l.text),
        ['A full width heading across the whole measure', 'left column text', 'left again',
         'right column text', 'right again']);

    // Only text that really runs across the gutter claims its baseline. VLAW p2 ends a left
    // column line on a 2pt "fi" that touches the gutter, and a blank item may bridge it:
    // neither may stitch a left column line to the right column line beside it.
    const touching = [
        item('left column text', 72, 114, 10, 200), item('fi', 304, 114, 10, 4),
        item('right column text', 330, 114, 10, 200),
        item('left again', 72, 126, 10, 200), item(' ', 281, 126, 10, 54),
        item('right again', 330, 126, 10, 200),
    ];
    const stitched = buildPageGeometry(touching, 1, W, H, 306).lines
        .filter(l => /left/.test(l.text) && /right/.test(l.text));
    eq('   a glyph touching the gutter or a blank item joins no columns', stitched.length, 0);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

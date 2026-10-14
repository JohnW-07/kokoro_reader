// Harness for the pure anchoring model (U8): where a note sits in the paper, which
// note a block belongs to, the order they are laid out in, and the stack that keeps
// two notes off each other. No DOM.
// Run: node tests/js/anchors.test.mjs

import {
  ANCHOR_NEAR_Y,
  MAX_PAGE,
  NOTE_GAP_PX,
  VIEW_MARGIN,
  VIEW_SECTIONS,
  anchorFromHighlight,
  cleanAnchor,
  compareAnchors,
  groupNotes,
  isEmptyNote,
  opensNote,
  sameAnchor,
  sectionFor,
  sectionHeading,
  sectionsFromScript,
  sortNotes,
  stackTops,
  withoutEmptyNote,
} from '../../static/js/anchors.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

const block = (id, anchor = null) => ({ id, type: 'p', text: id, checked: false, anchor });
const ids = (list) => list.map((b) => b.id).join('');

console.log('\n1. cleaning an untrusted anchor');
{
  ok('a whole anchor survives', JSON.stringify(cleanAnchor({ page: 3, y: 0.5, hl: 'a' }))
    === JSON.stringify({ page: 3, y: 0.5, hl: 'a' }));
  ok('y is clamped into the page', cleanAnchor({ page: 1, y: 4 }).y === 1
    && cleanAnchor({ page: 1, y: -2 }).y === 0);
  ok('a missing y is the top of the page', cleanAnchor({ page: 2 }).y === 0);
  ok('a missing highlight is no highlight', cleanAnchor({ page: 2 }).hl === '');
  ok('a page below 1 names no place', cleanAnchor({ page: 0, y: 0.5 }) === null);
  ok('a page past the last one any paper has names no place',
    cleanAnchor({ page: MAX_PAGE + 1 }) === null && cleanAnchor({ page: 1e20 }) === null);
  ok('the last page a paper may have is still a place', cleanAnchor({ page: MAX_PAGE }).page === MAX_PAGE);
  ok('junk names no place', cleanAnchor(null) === null && cleanAnchor('3') === null
    && cleanAnchor({ y: 0.5 }) === null && cleanAnchor({ page: NaN }) === null);
  ok('the anchor is frozen', Object.isFrozen(cleanAnchor({ page: 1 })));
}

console.log('\n2. anchoring to a highlight');
{
  const hl = { id: 'h1', page: 4, rects: [{ y: 0.6 }, { y: 0.3 }, { y: 0.45 }] };
  const anchor = anchorFromHighlight(hl);
  ok('a note sits beside the top of the highlight (D1)',
    anchor.page === 4 && anchor.y === 0.3, JSON.stringify(anchor));
  ok('it remembers which highlight', anchor.hl === 'h1');
  ok('a highlight with no rects still anchors to its page',
    anchorFromHighlight({ id: 'h2', page: 2 }).y === 0);
  ok('nothing to anchor to → null', anchorFromHighlight(null) === null);
}

console.log('\n3. is this the same place?');
{
  const at = (page, y, hl = '') => cleanAnchor({ page, y, hl });
  ok('one highlight is one place', sameAnchor(at(1, 0.1, 'a'), at(1, 0.9, 'a')));
  ok('two highlights are two places', !sameAnchor(at(1, 0.1, 'a'), at(1, 0.1, 'b')));
  ok('a highlight is never the same place as a bare position',
    !sameAnchor(at(1, 0.1, 'a'), at(1, 0.1)));
  ok('positions within ANCHOR_NEAR_Y are one place',
    sameAnchor(at(2, 0.40), at(2, 0.40 + ANCHOR_NEAR_Y)));
  ok('... and further apart are not', !sameAnchor(at(2, 0.40), at(2, 0.41 + ANCHOR_NEAR_Y)));
  ok('the same y on another page is another place', !sameAnchor(at(2, 0.4), at(3, 0.4)));
  ok('unanchored equals unanchored', sameAnchor(null, null));
  ok('unanchored is not somewhere', !sameAnchor(null, at(1, 0)));
}

console.log('\n4. blocks → notes');
{
  const a = cleanAnchor({ page: 1, y: 0.2 });
  const b = cleanAnchor({ page: 2, y: 0.5 });
  const notes = groupNotes([block('x'), block('y'), block('a', a), block('a2'), block('b', b)]);
  ok('three notes', notes.length === 3, String(notes.length));
  ok('the blocks before the first anchor are the unanchored note',
    notes[0].anchor === null && ids(notes[0].blocks) === 'xy');
  ok('an anchored block opens a note and the next blocks continue it',
    notes[1].anchor.page === 1 && ids(notes[1].blocks) === 'aa2');
  ok('the next anchored block opens the next note', ids(notes[2].blocks) === 'b');
  ok('an empty list has no notes', groupNotes([]).length === 0 && groupNotes(null).length === 0);
}

console.log('\n5. page order');
{
  const at = (page, y) => cleanAnchor({ page, y });
  ok('an unanchored note comes first', compareAnchors(null, at(1, 0)) < 0);
  ok('pages sort before positions on them', compareAnchors(at(2, 0.9), at(3, 0.1)) < 0);
  ok('and down a page', compareAnchors(at(2, 0.1), at(2, 0.9)) < 0);

  const blocks = [block('b', at(5, 0.1)), block('b2'), block('a', at(2, 0.4))];
  const sorted = sortNotes(blocks);
  ok('a note moves as a whole', ids(sorted) === 'abb2', ids(sorted));
  ok('an ordered list is returned untouched, so no re-render happens',
    sortNotes(sorted) === sorted);
  const tied = [block('a', at(2, 0.4)), block('b', at(2, 0.4))];
  ok('two notes in one place keep the order they were written in',
    sortNotes(tied) === tied);
}

console.log('\n6. stacking');
{
  const tops = stackTops([
    { desired: 0, height: 40 },
    { desired: 20, height: 30 },
    { desired: 400, height: 10 },
  ]);
  ok('a note that fits stays where it wants to be', tops[0] === 0 && tops[2] === 400);
  // Asserted as a number, not as `40 + NOTE_GAP_PX`: written against the constant the
  // assertion moves with it, and a gap of 0 -- two notes touching -- still passes.
  ok('an overlapping note is pushed below the one above it', tops[1] === 50, String(tops[1]));
  ok('the gap the stack leaves is the documented one', NOTE_GAP_PX === 10, String(NOTE_GAP_PX));
  const pair = stackTops([{ desired: 0, height: 10 }, { desired: 5, height: 10 }], 0);
  ok('with no gap it is pushed to exactly the bottom edge', pair[1] === 10);
  ok('no notes, no tops', stackTops([]).length === 0 && stackTops(null).length === 0);
  ok('a missing height still moves the next note off it',
    stackTops([{ desired: 0 }, { desired: 0, height: 5 }], 10)[1] === 10);
}

console.log('\n7. the paper’s own sections');
{
  const sentences = [
    { kind: 'heading', page: 1, raw: 'Introduction', items: [4] },
    { kind: 'body', page: 1, raw: 'We show that…', items: [5] },
    { kind: 'heading', page: 3, raw: 'Method', items: [0] },
    { kind: 'heading', page: 2, raw: 'Related Work', items: [1] },
  ];
  const pages = [
    { page: 1, height: 800, lines: [{ y: 80, items: [4] }, { y: 120, items: [5] }] },
    { page: 2, height: 800, lines: [{ y: 400, items: [1] }] },
    { page: 3, height: 800, lines: [{ y: 200, items: [0] }] },
  ];
  const sections = sectionsFromScript(sentences, pages);
  ok('only headings become sections', sections.length === 3, String(sections.length));
  ok('they come back in page order',
    sections.map((s) => s.title).join('|') === 'Introduction|Related Work|Method');
  ok('each sits where its line does', sections[0].y === 0.1 && sections[1].y === 0.5);
  ok('a heading the geometry does not know sits at the top of its page',
    sectionsFromScript([{ kind: 'heading', page: 2, raw: 'Lost', items: [99] }], pages)[0].y === 0);
  ok('no script, no sections', sectionsFromScript(null, null).length === 0);
  // N7: the contents tree ranks headings by size and jumps to the heading sentence itself.
  const sized = sectionsFromScript(sentences, [
    { page: 1, height: 800, lines: [{ y: 80, size: 14.2, items: [4] }] },
    { page: 2, height: 800, lines: [{ y: 400, size: 10, items: [1] }] },
  ]);
  ok('each section carries its heading line\'s glyph size', sized[0].size === 14.2 && sized[1].size === 10,
    JSON.stringify(sized.map((x) => x.size)));
  ok('... and 0 when the geometry does not know the line', sized[2].size === 0, String(sized[2].size));
  ok('each section carries the index of its heading sentence',
    sized.map((x) => x.index).join() === '0,3,2', sized.map((x) => x.index).join());

  const at = (page, y) => cleanAnchor({ page, y });
  ok('a note is filed under the last heading above it',
    sectionFor(sections, at(2, 0.9)).title === 'Related Work');
  ok('a heading claims a note level with it', sectionFor(sections, at(3, 0.25)).title === 'Method');
  ok('a note above every heading has no section', sectionFor(sections, at(1, 0.05)) === null);
  ok('... and is filed under its page instead', sectionHeading(sections, at(1, 0.05)) === 'Page 1');
  ok('a paper with no headings files every note under its page',
    sectionHeading([], at(7, 0.5)) === 'Page 7');
  ok('an unanchored note has no heading at all', sectionHeading(sections, null) === '');
}

console.log('\n8. what opens a note of its own');
{
  const at = (page, y = 0.5) => cleanAnchor({ page, y });
  const row = (text, type = 'p') => ({ id: 'x', type, text, checked: false, anchor: null });
  ok('a run nobody has pinned must be pinned', opensNote(null, row('written'), at(4)) === true);
  ok('a blank row above ends the note before it',
    opensNote(at(1), row(''), at(1, 0.51)) === true);
  ok('a divider is a row, not a blank one', opensNote(at(1), row('', 'divider'), at(1, 0.51)) === false);
  ok('another page is another note', opensNote(at(1), row('written'), at(2)) === true);
  ok('the same page carries the note on', opensNote(at(3, 0.1), row('written'), at(3, 0.9)) === false);
  ok('the first row of the document has nothing above it to break from',
    opensNote(at(1), null, at(1, 0.9)) === false);
}

console.log('\n9. a note with nothing written in it');
{
  const at = (page, y = 0.5) => cleanAnchor({ page, y });
  const row = (id, text, anchor = null, type = 'p') => ({ id, type, text, checked: false, anchor });
  const doc = [row('a', 'written', at(1)), row('e', '', at(6)), row('c', 'more', at(9))];
  ok('one blank row heading a note of its own is an empty note', isEmptyNote(doc, 'e') === true);
  ok('a note with words in it is not', isEmptyNote(doc, 'a') === false);
  ok('a blank row with more rows under it is not',
    isEmptyNote([row('e', '', at(6)), row('f', 'then this')], 'e') === false);
  ok('a blank row inside another note is not a note at all',
    isEmptyNote([row('a', 'written', at(1)), row('b', '')], 'b') === false);
  ok('a divider is something written', isEmptyNote([row('d', '', at(2), 'divider')], 'd') === false);
  ok('an unknown row is not an empty note', isEmptyNote(doc, 'zz') === false);
  ok('what is saved leaves the empty note out', ids(withoutEmptyNote(doc, 'e')) === 'ac');
  ok('... and leaves the list it was given alone', ids(doc) === 'aec');
  ok('a note written in is saved whole', withoutEmptyNote(doc, 'a') === doc);
  ok('a blank row with rows under it is saved', ids(withoutEmptyNote([row('e', '', at(6)), row('f', 'x')], 'e')) === 'ef');
  ok('no row to leave out saves everything', withoutEmptyNote(doc, null) === doc);
}

console.log('\n10. the two views');
{
  ok('the views are named', VIEW_MARGIN === 'margin' && VIEW_SECTIONS === 'sections');
}

console.log('\n11. a note made on a heading is filed under that heading (U15)');
{
  // Real geometry: each line's baseline `y`, glyph `size` and page `height` as
  // pdfview.buildPageGeometry gives them, and the top of a real highlight of the heading
  // (highlights.js over its text-layer spans, headless Chromium; WebKit agrees within 0.001).
  // `mark` is a note made from a highlight, `at` one made at the reading position.
  const head = (page, raw, item) => ({ kind: 'heading', page, raw, items: [item] });
  const line = (y, size, item) => ({ y, size, items: [item] });
  const mark = (page, y) => cleanAnchor({ page, y, hl: 'h' });
  const at = (page, y) => cleanAnchor({ page, y });
  const title = (sections, anchor) => sectionFor(sections, anchor)?.title;
  const A4 = 841.89;

  // GR00T N1 (one column): the title, §1 below it on p1, and §2.3 at the top of p8.
  const groot = sectionsFromScript([
    head(1, 'GR00T N1', 2), head(1, '1. Introduction', 25),
    head(5, '2.2. Training Data Generation', 240), head(8, '2.3. Training Details', 2),
  ], [
    { page: 1, height: A4, lines: [line(97.767, 16.9, 2), line(400.97, 10, 23), line(434.579, 13, 25)] },
    { page: 5, height: A4, lines: [line(358.532, 12, 240)] },
    { page: 8, height: A4, lines: [line(62.126, 8, 0), line(96.267, 12, 2)] },
  ]);
  ok('a highlight of "1. Introduction" is filed under it',
    title(groot, mark(1, 0.50256)) === '1. Introduction', title(groot, mark(1, 0.50256)));
  ok('... so is one of a heading at the top of a page, in both engines',
    title(groot, mark(8, 0.10130)) === '2.3. Training Details' && title(groot, mark(8, 0.10209)) === '2.3. Training Details',
    title(groot, mark(8, 0.10130)));
  ok('a highlight of the line just above a heading stays in the section before it',
    title(groot, mark(1, (400.97 - 10) / A4)) === 'GR00T N1' && title(groot, mark(8, (62.126 - 8) / A4)) === '2.2. Training Data Generation');
  const spanning = anchorFromHighlight({ id: 'h', page: 1,
    rects: [{ y: (400.97 - 10) / A4 }, { y: 0.50256 }] });
  ok('a highlight from the end of a section over the next heading goes where it starts',
    title(groot, spanning) === 'GR00T N1', title(groot, spanning));
  ok('the reading position on a heading’s baseline is in that section',
    title(groot, at(1, 434.579 / A4)) === '1. Introduction');
  ok('... but not one in the gap above the heading',
    title(groot, at(1, (434.579 - 20) / A4)) === 'GR00T N1', title(groot, at(1, (434.579 - 20) / A4)));

  // PI0_6 p9 (two columns): the run-in "1) …" heading sits one line gap (1.1 em) under the line
  // before it, so its highlight reach covers that line's lower edge. A reading position there is
  // still in the section before (§D, on p7): only a highlight is anchored by the heading's top.
  const tight = sectionsFromScript([
    head(7, 'D. Pre-training, data collection, and learning from experience', 77),
    head(9, '1) How much does RECAP improve the policy?', 126),
  ], [
    { page: 7, height: 792, lines: [line(384.027, 10, 77)] },
    { page: 9, height: 792, lines: [line(425.944, 10, 124), line(437.01, 10, 126)] },
  ]);
  ok('a reading position on the lower edge of the line above a tight heading stays before it',
    title(tight, at(9, (425.944 + 1) / 792)).startsWith('D. '), title(tight, at(9, (425.944 + 1) / 792)));

  // VLALitReview (two columns): §B in the left column, §A above it.
  const lit = sectionsFromScript([head(3, 'A. DATA REQUIREMENTS AND SCARCITY', 5), head(3, 'B. EMBODIMENT TRANSFER', 26)],
    [{ page: 3, height: 782.929, lines: [line(69.113, 9, 5), line(284.822, 10, 24), line(307.958, 9, 26)] }]);
  ok('a highlight of a two-column paper’s heading is filed under it',
    title(lit, mark(3, 0.38361)) === 'B. EMBODIMENT TRANSFER', title(lit, mark(3, 0.38361)));
  ok('... and the line above it is not', title(lit, mark(3, (284.822 - 10) / 782.929)) === 'A. DATA REQUIREMENTS AND SCARCITY');

  // VLAW p3 (two columns): "3. Preliminaries" (left, 12 pt) is 9.3 pt lower on the page than
  // "1. World model…" (right, 10 pt), whose WebKit highlight top it would take at a reach of 1.47 em.
  const vlaw = sectionsFromScript([head(3, '3. Preliminaries', 55), head(3, '1. World model post-training', 327)],
    [{ page: 3, height: 792, lines: [line(397.561, 10, 327), line(406.865, 12, 55)] }]);
  ok('a highlight of a heading is not taken by a bigger one just below it in the other column',
    title(vlaw, mark(3, 0.49139)) === '1. World model post-training', title(vlaw, mark(3, 0.49139)));

  // PI0_6: the title whose highlight reaches highest above its baseline (1.14 em, the π).
  const pi = sectionsFromScript([head(1, 'π*0.6: a VLA That Learns From Experience', 0)],
    [{ page: 1, height: 792, lines: [line(82.039, 23.9, 0)] }]);
  ok('a highlight of a title set with a tall glyph is filed under it',
    sectionHeading(pi, mark(1, 0.06910)) === pi[0]?.title, sectionHeading(pi, mark(1, 0.06910)));

  const top = sectionsFromScript([head(1, 'Before', 0), head(2, 'At the top', 0)], [
    { page: 1, height: 800, lines: [line(400, 12, 0)] }, { page: 2, height: 800, lines: [line(10, 12, 0)] },
  ]);
  ok('a heading reaching past the top of its page claims the page’s top edge',
    top[1].top === 0 && title(top, mark(2, 0)) === 'At the top', JSON.stringify(top[1]));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

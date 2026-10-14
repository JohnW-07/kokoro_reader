// Harness for the read-along wiring in main.js (U28): boots the real shell against the faked
// browser in shellenv.mjs. A paper with a saved place opens there without playing, the
// reader's scroll lights Follow, and Follow (or F/S), Play, a step or a jump clears it; only playback
// moves the view, a note being typed in the margin holds it, and a superseded paper's
// restore never scrolls its successor.
import { El, byId, fetchLog, makePage } from './shellenv.mjs';
import { VIEW_MARGIN, VIEW_SECTIONS } from '../../static/js/anchors.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));
const DEADLINE_TICKS = 400;            // x5ms: every wait below gives up after 2 s
const waitFor = async (cond) => { for (let i = 0; i < DEADLINE_TICKS && !cond(); i++) await tick(5); };

const SAVED_INDEX = 40;                // the fake script has one sentence per page: page 41
const NOTE = { id: 'h1', page: 2, color: 'yellow', text: 'a note', note: '', rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.02 }] };
const reply = { lastIndex: SAVED_INDEX, highlights: [NOTE] };
const serverFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
    if (/\/api\/notes\//.test(String(url)) && !init.method) {
        const body = { doc_id: 'x', title: '', highlights: reply.highlights, last_index: reply.lastIndex, options: {} };
        return { ok: true, status: 200, json: async () => body };
    }
    return serverFetch(url, init);
};

// Geometry: the paper's scroller shows 0..800 (the fake default); every page sits far
// below it, so any sentence the reader is taken to is off screen until it is scrolled to.
const PAGE_TOP = 5000, PAGE_HEIGHT = 1100;
const baseRect = El.prototype.getBoundingClientRect;
El.prototype.getBoundingClientRect = function () {
    if (!this._cls.has('pdf-page-wrap')) return baseRect.call(this);
    return { top: PAGE_TOP, bottom: PAGE_TOP + PAGE_HEIGHT, left: 0, right: 600, width: 600, height: PAGE_HEIGHT };
};
// A gate every page render can be held on, to keep a restore waiting across a newer open,
// and one for fetching a page, to hold a re-layout part way.
const renders = { held: null, pages: null };
globalThis.pdfjsLib.getDocument = () => ({ promise: Promise.resolve({
    numPages: 203, destroy: async () => {},
    getPage: async () => {
        await renders.pages;
        return { ...makePage(), render: () => ({ promise: renders.held || Promise.resolve(), cancel() {} }) };
    },
}) });

// The fake text layer's spans are never attached to the page, so pdfView takes its
// page-while-spans-paint path: a scrollTo on the pages box rather than scrollIntoView.
// Fit-width's own re-anchoring scroll of #content-area is not the paper following.
const scrolls = [];
El.prototype.scrollIntoView = function (opts) { scrolls.push({ el: this, opts }); };
El.prototype.scrollTo = function (opts) { if (this.id !== 'content-area') scrolls.push({ el: this, opts }); };

await import('../../static/js/main.js');
await tick(5);
const { state, player, pdfView } = globalThis.window.kokoro;
const fileInput = byId.get('file-input');
let opened = 0;
/** Open a paper (distinct bytes, so a distinct doc id); resolves once its load settles. */
const open = async (name) => {
    fileInput.files = [{ name, type: 'application/pdf', _bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, ++opened]) }];
    fileInput.dispatch('change', { target: fileInput });
    await waitFor(() => state.get().docName === name && !state.get().loading);
    await tick(20);
};
await open('saved.pdf');

console.log('\n1. a paper opens at its saved reading place');
ok('   the cursor is at the saved sentence', state.get().index === SAVED_INDEX, String(state.get().index));
ok('   the view scrolled there once', scrolls.length === 1, `${scrolls.length} scrolls`);
ok('   ... instantly', scrolls[0]?.opts?.behavior === 'instant', JSON.stringify(scrolls[0]?.opts));
ok('   nothing started playing', !player.state().isPlaying && !player.state().isLoading);
ok('   ... and no audio was asked for', !fetchLog.some((u) => u.startsWith('/api/tts')));

console.log('\n2. the reader\'s scroll shows on Follow; Follow, Play, a step and a jump clear it');
const area = byId.get('content-area');
const follow = byId.get('followBtn');
const railFollow = byId.get('railFollowBtn');
const ppBtn = byId.get('ppBtn');
const lit = () => follow.classList.contains('attention') && railFollow.classList.contains('attention');
const dark = () => !follow.classList.contains('attention') && !railFollow.classList.contains('attention');
/** R1: pressing a lit Follow resumes; a plain one is left alone (pressing it would switch following off). */
const snapBack = () => { if (lit()) follow.click(); };
ok('   following: Follow is plain', dark());
area.dispatch('wheel');
ok('   a wheel on the paper lights Follow and its rail twin', lit());
/** Suspend with a wheel, then check `act` resumes: Follow lit before, plain after, the view brought along. */
const clearedBy = (name, act, { scrolled = true } = {}) => {
    area.dispatch('wheel');
    const wasLit = lit();
    const before = scrolls.length;
    act();
    ok(`   ${name} clears it`, wasLit && dark(), `lit before: ${wasLit}`);
    if (scrolled) ok('   ... and brings the sentence into view once', scrolls.length === before + 1, `${scrolls.length - before} scrolls`);
    player.stop();
};
clearedBy('pressing Follow', () => follow.click());
ok('   ... and following stays switched on', state.get().followEnabled === true);
clearedBy('the F key', () => document.dispatch('keydown', { code: 'KeyF' }));
clearedBy('the S key, an alias of F', () => document.dispatch('keydown', { code: 'KeyS' }));
ok('   ... and following stays switched on', state.get().followEnabled === true);
clearedBy('stepping to the next sentence', () => document.dispatch('keydown', { code: 'ArrowRight' }));
clearedBy('pressing Play', () => ppBtn.dispatch('click'));
{
    const { state: realState, toggle: realToggle } = player;
    player.state = () => ({ ...realState(), isPlaying: true, isRunning: true });   // mid-sentence, as far as the shell can tell
    player.toggle = () => {};
    area.dispatch('wheel');
    const before = scrolls.length;
    ppBtn.dispatch('click');
    ok('   pressing Pause leaves it lit and the view where the reader put it', lit() && scrolls.length === before);
    Object.assign(player, { state: realState, toggle: realToggle });
}

console.log('\n3. only playback moves the view');
snapBack();
{
    let before = scrolls.length;
    player.play(5);                                    // onIndex fires before the first await
    ok('   playing onto an off-screen sentence brings it into view', scrolls.length === before + 1, `${scrolls.length - before} scrolls`);
    player.stop();
    before = scrolls.length;
    player.setIndex(7);
    ok('   moving the cursor while stopped does not', scrolls.length === before, `${scrolls.length - before} scrolls`);
}

console.log('\n4. a jump to a note suspends following');
{
    snapBack();
    const row = byId.get('notes-panel').querySelector(`.nt-row[data-id="${NOTE.id}"]`);
    row?.click();
    ok('   clicking a note in the list lights Follow', Boolean(row) && lit(), row ? '' : 'no note row');
}

console.log('\n5. typing a margin note holds the paper still');
{
    snapBack();
    const noteEditor = Object.assign(new El('div'), { isContentEditable: true });
    byId.get('notes-column').appendChild(noteEditor);
    const elsewhere = new El('input');
    byId.get('sidebar').appendChild(elsewhere);
    /** Play sentence `idx` with `focused` holding the caret; how many scrolls it cost. */
    const playWith = (focused, idx) => {
        document.activeElement = focused;
        const before = scrolls.length;
        player.play(idx);
        player.stop();
        return scrolls.length - before;
    };
    const pick = (view) => byId.get('notes-column').querySelectorAll('.ne-switch-opt')
        .find((el) => el.dataset.view === view).click();
    pick(VIEW_MARGIN);
    ok('   the caret in a margin note: the next sentence does not scroll', playWith(noteEditor, 20) === 0);
    ok('   the caret in the sidebar: it does', playWith(elsewhere, 22) === 1);
    pick(VIEW_SECTIONS);
    ok('   the caret in the notes in sections view: it does', playWith(noteEditor, 24) === 1);
    pick(VIEW_MARGIN);
    state.set({ notesView: VIEW_SECTIONS });            // a stale report: the editor still draws the margin
    ok('   the view is the one the editor draws, not the last one reported', playWith(noteEditor, 26) === 0);
    state.set({ notesView: VIEW_MARGIN });
    document.activeElement = null;
}

console.log('\n6. only the paper on screen restores its place');
{
    let release = null;
    renders.held = new Promise((r) => { release = r; });
    await open('first.pdf');                            // its restore waits on the held render
    const before = scrolls.length;
    await open('second.pdf');
    release();
    renders.held = null;
    await tick(20);
    ok('   a superseded paper\'s restore does not scroll its successor', scrolls.length === before + 1, `${scrolls.length - before} scrolls`);
    area.dispatch('wheel');
    reply.lastIndex = 0;                               // no saved place: nothing restores
    await open('fresh.pdf');
    ok('   opening another paper resumes following', dark());
}

console.log('\n6b. a zoom moves the page that stands in for the sentence: it is followed again');
{
    // The fake's spans never attach, so readingEl is the page wrap, the same element across a zoom.
    const playOnce = (idx) => { const before = scrolls.length; player.play(idx); player.stop(); return scrolls.length - before; };
    ok('   (control) the first play onto page 6 scrolls there', playOnce(5) === 1);
    ok('   (control) replaying it at the same zoom does not: that page was just scrolled to', playOnce(5) === 0);
    const scale = pdfView.scale();
    const realStyle = globalThis.getComputedStyle;
    area.clientWidth = 900;                            // fit-width measures the column it fills
    globalThis.getComputedStyle = () => ({ ...realStyle(), paddingLeft: '0', paddingRight: '0' });
    document.dispatch('keydown', { code: 'Minus', metaKey: true });
    await waitFor(() => pdfView.scale() !== scale);
    globalThis.getComputedStyle = realStyle;
    ok('   after ⌘− the same page is scrolled to again', pdfView.scale() !== scale && playOnce(5) === 1,
        `scale ${scale} → ${pdfView.scale()}`);
    const zoomed = pdfView.scale();
    await pdfView.setScale(zoomed * 2);
    await pdfView.setScale(zoomed);                    // back where it was: the scale alone cannot tell
    ok('   after a zoom and back, the page is scrolled to again', pdfView.scale() === zoomed && playOnce(5) === 1);
    let releasePages = null;
    renders.pages = new Promise((r) => { releasePages = r; });
    const relayout = pdfView.setScale(zoomed * 2);     // the new scale is set before the pages move
    await tick(5);
    const during = playOnce(5);
    renders.pages = null;
    releasePages();
    await relayout;
    ok('   a follow mid-relayout does not count for the finished layout', playOnce(5) === 1, `during=${during}`);
}

console.log('\n7. pdfView.readingEl: the highlighted words, else their page while they paint');
{
    const page = state.get().sentences[0].page;
    await pdfView.renderPage(page);
    player.setIndex(0);
    ok('   spans not on the page yet: the page stands in', pdfView.readingEl() === pdfView.pageWrapEl(page));
    const span = document.querySelectorAll('.reading')[0];
    pdfView.pageWrapEl(page).querySelector('.textLayer').appendChild(span);
    ok('   spans painted: the first highlighted span', Boolean(span) && pdfView.readingEl() === span);
    pdfView.clearHighlights();
    ok('   nothing highlighted: nothing to follow', pdfView.readingEl() === null);
}

console.log('\n8. a highlight pressed from the keyboard keeps the focus, so the next Space is not play/pause');
{
    // Every change re-renders every rect: the focused one is replaced, as in a browser.
    const rectOf = (hl) => pdfView.pageWrapEl(hl.page).querySelector(`.hl-rect[data-hl-id="${hl.id}"]`);
    const press = (key, code = key) => document.activeElement.dispatchEvent({ type: 'keydown', key, code, bubbles: true });
    const focusShown = () => `focus=${document.activeElement?.tagName}.${document.activeElement?.className}`;
    const realToggle = player.toggle;
    let toggles = 0;
    player.toggle = () => { toggles += 1; };
    const spaceIsKept = (label) => {
        const before = toggles;
        press(' ', 'Space');
        ok(`   ... and after ${label} a Space neither plays nor pauses`, toggles === before, `${toggles - before} toggles`);
        press('Escape');
    };
    for (const [label, key, code] of [['Space', ' ', 'Space'], ['Enter', 'Enter', 'Enter']]) {
        const first = rectOf(NOTE);
        first?.focus();
        press(key, code);
        const rect = rectOf(NOTE);
        ok(`   ${label} opens the popover on the rebuilt rect, which has the focus`,
            Boolean(document.querySelector('.hl-popover.is-open')) && rect !== first && document.activeElement === rect,
            `rebuilt=${rect !== first} ${focusShown()}`);
        spaceIsKept(label);
    }
    rectOf(NOTE).focus();
    press('Enter');
    press('Escape');
    ok('   Escape closes the popover and the rebuilt rect keeps the focus',
        !document.querySelector('.hl-popover.is-open') && document.activeElement === rectOf(NOTE), focusShown());
    spaceIsKept('Escape');
    rectOf(NOTE).focus();
    press('Enter');
    const color = rectOf(NOTE).dataset.color;
    press('2', 'Digit2');
    ok('   a colour key recolours it and the rebuilt rect keeps the focus',
        rectOf(NOTE).dataset.color !== color && document.activeElement === rectOf(NOTE), `${color} ${focusShown()}`);
    spaceIsKept('a colour key');
    const NEXT = { ...NOTE, id: 'h2', page: 3, text: 'another note' };
    reply.highlights = [NOTE, NEXT];
    await open('twonotes.pdf');
    rectOf(NOTE).focus();
    press('Enter');
    press('Delete');
    press('Delete');
    ok('   deleting it moves the focus to the next highlight',
        !rectOf(NOTE) && document.activeElement === rectOf(NEXT), focusShown());
    spaceIsKept('a delete');
    player.toggle = realToggle;
}

console.log('\n9. the follow switch and smooth scrolling (N12)');
{
    const followBtn = follow;
    const smoothBox = byId.get('smoothScrollBox');
    const saves = [];
    globalThis.localStorage.setItem = (_k, v) => saves.push(JSON.parse(v));
    const checked = () => [followBtn, railFollow].map((b) => b.attrs['aria-checked']).join();
    const playOnce = (idx) => { const before = scrolls.length; player.play(idx); player.stop(); return scrolls.length - before; };
    snapBack();
    ok('   a fresh profile follows, and both switches say so', state.get().followEnabled === true && checked() === 'true,true', checked());
    ok('   ... and scrolls smoothly, Reduce Motion or not', playOnce(30) === 1 && scrolls.at(-1).opts.behavior === 'smooth',
        JSON.stringify(scrolls.at(-1).opts));
    document.dispatch('keydown', { code: 'KeyF' });
    ok('   F switches following off: both switches, the state and the saved prefs',
        state.get().followEnabled === false && checked() === 'false,false' && saves.at(-1)?.followEnabled === false, checked());
    ok('   ... and says so out loud (the toast is an alert)', /not following/i.test(byId.get('toast').textContent), byId.get('toast').textContent);
    ok('   off: playing onto an off-screen sentence leaves the view alone', playOnce(32) === 0);
    area.dispatch('wheel');
    ok('   off: a wheel does not light Follow', dark());
    const before = scrolls.length;
    railFollow.click();
    ok('   the rail twin switches it back on', state.get().followEnabled === true && checked() === 'true,true', checked());
    ok('   ... and says so', /following/i.test(byId.get('toast').textContent) && !/not/i.test(byId.get('toast').textContent));
    ok('   R1: switching it on scrolls to the sentence at once, smoothly', scrolls.length === before + 1
        && scrolls.at(-1).opts.behavior === 'smooth', `${scrolls.length - before} scrolls`);
    document.dispatch('keydown', { code: 'KeyS' });
    ok('   R1: S switches following off, as F does', state.get().followEnabled === false && checked() === 'false,false', checked());
    const beforeOn = scrolls.length;
    document.dispatch('keydown', { code: 'KeyS' });
    ok('   ... and back on', state.get().followEnabled === true && checked() === 'true,true', checked());
    ok('   ... scrolling to the sentence even though nothing moved the page meanwhile', scrolls.length === beforeOn + 1,
        `${scrolls.length - beforeOn} scrolls`);
    document.dispatch('keydown', { code: 'KeyF', target: new El('input') });
    ok('   F typed into a field is just a letter', state.get().followEnabled === true);
    document.dispatch('keydown', { code: 'KeyF', metaKey: true });
    ok('   ⌘F is left to the browser', state.get().followEnabled === true);
    smoothBox.checked = false;
    smoothBox.dispatch('change', { target: smoothBox });
    ok('   unticking smooth scrolling is saved', state.get().smoothScroll === false && saves.at(-1)?.smoothScroll === false);
    ok('   ... and the next follow scroll jumps', playOnce(36) === 1 && scrolls.at(-1).opts.behavior === 'instant',
        JSON.stringify(scrolls.at(-1).opts));
    globalThis.localStorage.getItem = () => JSON.stringify({ followEnabled: false, smoothScroll: false });
    state.loadPrefs();
    ok('   both prefs come back from storage', state.get().followEnabled === false && state.get().smoothScroll === false);
    globalThis.localStorage.getItem = () => JSON.stringify({ voice: 'af_aoede' });
    state.loadPrefs();
    ok('   prefs saved before N12 default to following, smoothly', state.get().followEnabled === true && state.get().smoothScroll === true);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

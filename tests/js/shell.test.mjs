// Harness for the app shell: boots the real main.js against a hand-written DOM
// fake (no browser is available in this environment) and drives a document
// through it end to end.
//
// Covers H1 (page batching actually reaches the server) and H6 (a PDF dropped
// outside #drop-zone must not navigate the webview away from the app).
//
// H1: Before the fix, main.js
// POSTed all 203 pages in one request, the route answered
//   400 {"detail": "Too many pages in one request (max 80)"}
// and the client silently fell through to its naive fallback splitter.

import {
    El, byId, body, listeners, rail, voiceSelect, N_PAGES, SERVER_MAX_PAGES, scriptCalls, fetchLog, savedNotes, ownedPages,
} from './shellenv.mjs';
import { stepZoom } from '../../static/js/zoom.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));

// ── boot ──────────────────────────────────────────────────────────────────────
await import('../../static/js/main.js');
await tick(5);

const kokoro = globalThis.window.kokoro;
const state = kokoro.state;

console.log('\n0. the shell boots');
ok('   main.js initialised and exposed its debug handle', !!kokoro && !!state);
ok('   a fresh profile starts on af_aoede', state.get().voice === 'af_aoede', state.get().voice);
ok('   the voice select shows af_aoede', voiceSelect.value === 'af_aoede', voiceSelect.value);
globalThis.localStorage.getItem = () => JSON.stringify({ voice: 'bm_george' });
state.loadPrefs();
ok('   a saved voice is kept, not reset to the new default (D7)', state.get().voice === 'bm_george', state.get().voice);
globalThis.localStorage.getItem = () => null;
state.set({ voice: 'af_alloy' });

// ── H1 ────────────────────────────────────────────────────────────────────────
console.log('\n1. H1 — a 203-page document is built in server-sized batches');
const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
byId.get('file-input').files = [{ name: 'thesis.pdf', type: 'application/pdf', _bytes: bytes }];
byId.get('file-input').dispatch('change', { target: byId.get('file-input') });
for (let i = 0; i < 400 && state.get().sentences.length === 0; i++) await tick(2);

ok('   the document loaded', state.get().numPages === N_PAGES, String(state.get().numPages));
ok('   more than one request was made', scriptCalls.length > 1, String(scriptCalls.length));
ok('   no request exceeded the server cap',
    scriptCalls.every((c) => c.pages.length <= SERVER_MAX_PAGES),
    `max=${Math.max(...scriptCalls.map((c) => c.pages.length))}`);
ok('   every page was owned by exactly one batch, in order',
    JSON.stringify(scriptCalls.flatMap((c) => ownedPages(c).map((p) => p.page)))
    === JSON.stringify(Array.from({ length: N_PAGES }, (_, i) => i + 1)));
ok('   every batch carried the same document-wide stats',
    scriptCalls.every((c) => c.stats.num_pages === N_PAGES)
    && new Set(scriptCalls.map((c) => JSON.stringify(c.stats))).size === 1);
ok('   the merged script covers the whole document, not the naive fallback',
    state.get().sentences.length === N_PAGES
    && state.get().sentences[0].page === 1
    && state.get().sentences.at(-1).page === N_PAGES,
    `${state.get().sentences.length} sentences`);
console.log(`        ${scriptCalls.length} batches, ${state.get().sentences.length} sentences, ` +
    `pages 1..${state.get().sentences.at(-1).page}`);
ok('   the merged skip counts survived the merge',
    state.get().scriptStats && state.get().scriptStats.skipped.table === N_PAGES,
    JSON.stringify(state.get().scriptStats));

// ── H6 ────────────────────────────────────────────────────────────────────────
console.log('\n2. H6 — a PDF dropped outside #drop-zone must not navigate away');
const strayOver = window.dispatch('dragover', { dataTransfer: { files: [] } });
const strayDrop = window.dispatch('drop', {
    dataTransfer: { files: [{ name: 'other.pdf', type: 'application/pdf' }] },
});
ok('   window drop is prevented (the webview keeps the app)', strayDrop.defaultPrevented === true);
ok('   window dragover is prevented too (without it the drop never reaches us)',
    strayOver.defaultPrevented === true);
const docDrop = document.dispatch('drop', { dataTransfer: { files: [] } });
ok('   document-level drop is prevented as well', docDrop.defaultPrevented === true);
const zoneDrop = byId.get('drop-zone').dispatch('drop', { dataTransfer: { files: [] } });
ok('   the drop zone still handles its own drop', zoneDrop.defaultPrevented === true);
ok('   a stray drop did not load a second document',
    state.get().docName === 'thesis.pdf', state.get().docName);

// ── T3: tabs, collapsible sidebar, the rail ───────────────────────────────────
console.log('\n3. T3 — the sidebar tabs (R9/R7: Read · Subs · Summary · Settings)');
const tabNamed = (name) => document.querySelectorAll('.tab').find((t) => t.dataset.tab === name);
tabNamed('settings').dispatch('click');
ok('   clicking Settings shows #tab-settings, and only it', byId.get('tab-settings')._cls.has('active')
    && document.querySelectorAll('.tab-panel').filter((p) => p._cls.has('active')).length === 1);
tabNamed('subs').dispatch('click');
ok('   clicking Subs shows #tab-subs', byId.get('tab-subs')._cls.has('active'));
ok('   ... and hides Read', !byId.get('tab-read')._cls.has('active'));
ok('   ... and marks only Subs selected',
    document.querySelectorAll('.tab').filter((t) => t.attrs['aria-selected'] === 'true').map((t) => t.dataset.tab).join() === 'subs');
tabNamed('read').dispatch('click');
ok('   clicking Read brings it back', byId.get('tab-read')._cls.has('active'));
ok('   R2: with a paper open, the contents section shows in its place', byId.get('toc-section').hidden === false);

console.log('\n4. T3 — the sidebar collapses to the rail and back');
const written = [];
globalThis.localStorage.setItem = (k, v) => written.push([k, JSON.parse(v)]);
const collapsed = () => body._cls.has('sidebar-collapsed');
const lastPrefs = () => written.at(-1);
ok('   a fresh profile starts expanded', !collapsed() && state.get().sidebarCollapsed === false);
ok('   ... with the rail inert and the sidebar live', rail.inert === true && byId.get('sidebar').inert === false);

byId.get('collapseBtn').dispatch('click');
ok('   the collapse button collapses', collapsed() && state.get().sidebarCollapsed === true);
ok('   the hidden sidebar is inert, the rail is live', byId.get('sidebar').inert === true && rail.inert === false);
ok('   aria-expanded follows', byId.get('collapseBtn').attrs['aria-expanded'] === 'false');
ok('   the state is saved to kokoro.prefs.v2 with the rest of the prefs',
    lastPrefs()?.[0] === 'kokoro.prefs.v2' && lastPrefs()[1].sidebarCollapsed === true
    && lastPrefs()[1].voice === state.get().voice && typeof lastPrefs()[1].options === 'object',
    JSON.stringify(lastPrefs()));

byId.get('expandBtn').click();
ok('   the rail\'s expand button expands', !collapsed() && state.get().sidebarCollapsed === false);
ok('   ... and saves it', lastPrefs()?.[1].sidebarCollapsed === false);

const key = (code, target = body, mods = {}) => {
    const ev = { type: 'keydown', code, key: code, target, preventDefault() { ev.defaultPrevented = true; }, defaultPrevented: false, ...mods };
    (listeners.get('keydown') || []).forEach((fn) => fn(ev));
    return ev;
};
key('KeyB');
ok('   B toggles it', collapsed());
key('KeyB');
ok('   B toggles it back', !collapsed());
key('KeyB', new El('input'));
ok('   B typed into an input does not toggle', !collapsed());
key('KeyB', Object.assign(new El('div'), { isContentEditable: true }));
ok('   B typed into a contenteditable does not toggle', !collapsed());
key('KeyB', body, { metaKey: true });
ok('   Cmd+B is left to the browser', !collapsed());

globalThis.localStorage.getItem = () => JSON.stringify({ voice: 'af_alloy', speed: 1, sidebarCollapsed: true });
state.loadPrefs();
ok('   a saved collapsed state is restored', state.get().sidebarCollapsed === true);
globalThis.localStorage.getItem = () => JSON.stringify({ voice: 'af_alloy', speed: 1.25, options: {} });
state.loadPrefs();
ok('   prefs written before T3 (no sidebarCollapsed) load as expanded, other fields intact',
    state.get().sidebarCollapsed === false && state.get().speed === 1.25);
globalThis.localStorage.getItem = () => null;

console.log('\n5. T3 — every rail button drives its sidebar twin');
const player = kokoro.player;
const calls = [];
for (const m of ['toggle', 'prev', 'next']) player[m] = () => calls.push(m);
ok('   rail transport is enabled with the sidebar\'s once a script exists',
    ['railPpBtn', 'railPrevBtn', 'railNextBtn'].every((id) => byId.get(id).disabled === false)
    && byId.get('ppBtn').disabled === false);
byId.get('railPpBtn').click();
byId.get('railPrevBtn').click();
byId.get('railNextBtn').click();
ok('   play/pause, prev and next reach the player through the sidebar handlers',
    calls.join() === 'toggle,prev,next', calls.join());
byId.get('ppBtn').disabled = true;
byId.get('railPpBtn').click();
ok('   a rail button does nothing while its twin is disabled', calls.length === 3, calls.join());
byId.get('ppBtn').disabled = false;

const slider = byId.get('speedSlider');
const changes = [];
slider.addEventListener('change', () => changes.push(state.get().speed));
state.set({ speed: 1 });
byId.get('railSpeedBtn').click();
ok('   the speed button steps the slider to the next preset', state.get().speed === 1.25 && slider.value === '1.25', `${state.get().speed}`);
ok('   ... through the slider\'s own input + change handlers (label, save)',
    byId.get('speedVal').textContent === '1.25×' && byId.get('railSpeedBtn').textContent === '1.25×'
    && changes.at(-1) === 1.25 && lastPrefs()?.[1].speed === 1.25);
state.set({ speed: 2 });
byId.get('railSpeedBtn').click();
ok('   ... and wraps from the fastest to the slowest', state.get().speed === 0.75, `${state.get().speed}`);

console.log('\n5b. V1 — the Pitch and Expressiveness sliders');
let cleared = 0;
const realClear = kokoro.tts.clear;
kokoro.tts.clear = () => { cleared += 1; realClear(); };
const pitch = byId.get('pitchSlider');
pitch.value = '1.1';
pitch.dispatch('input');
ok('   dragging Pitch sets the state and its label, nothing saved or dropped yet',
    state.get().voicePitch === 1.1 && byId.get('pitchVal').textContent === '+10%' && cleared === 0
    && lastPrefs()?.[1].voicePitch !== 1.1, byId.get('pitchVal').textContent);
pitch.dispatch('change');
ok('   letting go saves it and drops the audio in the old shape', lastPrefs()?.[1].voicePitch === 1.1 && cleared === 1);
const expr = byId.get('exprSlider');
expr.value = '9';
expr.dispatch('input');
expr.dispatch('change');
ok('   Expressiveness is clamped, labelled, saved and drops audio',
    state.get().voiceExpr === 1.5 && byId.get('exprVal').textContent === '150%'
    && lastPrefs()?.[1].voiceExpr === 1.5 && cleared === 2);
const bass = byId.get('bassSlider');
const applied = [];
const realApply = kokoro.voicefx.apply;
kokoro.voicefx.apply = (fx) => { applied.push(fx); };
bass.value = '4';
bass.dispatch('input');
ok('   dragging Bass applies it live, labelled, nothing saved yet',
    applied.at(-1)?.bass === 4 && byId.get('bassVal').textContent === '+4 dB' && lastPrefs()?.[1].fxBass !== 4,
    JSON.stringify(applied.at(-1)));
bass.dispatch('change');
ok('   letting go saves it, and keeps the cached audio (an effect, not a render)', lastPrefs()?.[1].fxBass === 4 && cleared === 2);
const even = byId.get('evenSlider');
even.value = '0.5';
even.dispatch('input');
ok('   Even out applies live too', applied.at(-1)?.even === 0.5 && byId.get('evenVal').textContent === '50%');
kokoro.voicefx.apply = realApply;
kokoro.tts.clear = realClear;
state.set({ voicePitch: 1, voiceExpr: 1, fxBass: 0, fxTreble: 0, fxEven: 0 });

console.log('\n6. T3 — the play state shows on both play buttons');
const ui = await import('../../static/js/ui.js');
const playButtons = ['ppBtn', 'railPpBtn'].map((id) => byId.get(id));
ui.setPlayIcon(true);
ok('   playing: both buttons show pause and are pressed',
    playButtons.every((b) => b.classList.contains('is-playing') && b.getAttribute('aria-pressed') === 'true'),
    playButtons.map((b) => b.className).join(' | '));
ui.setPlayIcon(false);
ok('   paused: both buttons show play and are not pressed',
    playButtons.every((b) => !b.classList.contains('is-playing') && b.getAttribute('aria-pressed') === 'false'));

// ── T6: the Subs tab ──────────────────────────────────────────────────────────
console.log('\n7. T6 — a substitution reaches the script build and rebuilds it');
const SUBS_DEADLINE_TICKS = 200;      // x5ms: comfortably past the 400ms rebuild debounce
const subsPanel = byId.get('tab-subs');
const inPanel = (sel) => subsPanel.querySelectorAll(sel);
const [addFind, addSay] = inPanel('.sub-add')[0].querySelectorAll('.sub-input');
const addForm = inPanel('.sub-add')[0];
const addError = inPanel('#subAddError')[0];
const addCase = inPanel('#subAddCase')[0];
/** Pages owned since call `from`; a full rebuild has owned every page once. */
const pagesSince = (from) => scriptCalls.slice(from).reduce((n, c) => n + ownedPages(c).length, 0);
const waitForRebuild = async (from) => {
    for (let i = 0; i < SUBS_DEADLINE_TICKS && pagesSince(from) < N_PAGES; i++) await tick(5);
};
ok('   the panel renders an add form into #tab-subs', !!addForm && !!addFind && !!addSay);
ok('   ... with labelled fields', inPanel('label').some((l) => l.attrs.for === 'subAddFind')
    && inPanel('label').some((l) => l.attrs.for === 'subAddSay'));

const typeInto = (input, text) => { input.value = text; input.dispatch('input'); };
calls.length = 0;
key('Space', addFind);
key('KeyB', addFind);
key('ArrowRight', addFind);
ok('   Space, B and arrows typed into a Subs field reach neither player nor sidebar',
    calls.length === 0 && !collapsed(), calls.join());

addForm.dispatch('submit');
ok('   submitting an empty find explains why', addError.hidden === false
    && addError.textContent === 'Enter the text to replace.' && addFind.attrs['aria-invalid'] === 'true');

const buildsBefore = scriptCalls.length;
typeInto(addFind, 'GR00T');
ok('   typing clears the message', addError.hidden === true);
typeInto(addSay, 'groot');
const submitted = addForm.dispatch('submit');
ok('   adding does not navigate', submitted.defaultPrevented === true);
ok('   the row is added, the form cleared', inPanel('.sub-row').length === 1 && addFind.value === '');
ok('   the delete button names its row', inPanel('.sub-delete')[0]?.attrs['aria-label'] === 'Delete substitution for GR00T');
ok('   the substitution is saved with the prefs',
    JSON.stringify(lastPrefs()?.[1].subs) === JSON.stringify([{ find: 'GR00T', replace: 'groot', ignore_case: false }]),
    JSON.stringify(lastPrefs()?.[1].subs));
await waitForRebuild(buildsBefore);
ok('   the whole script is rebuilt, once', pagesSince(buildsBefore) === N_PAGES, `${pagesSince(buildsBefore)} pages`);
ok('   every rebuilt batch carries the substitution next to the read options',
    scriptCalls.slice(buildsBefore).every((c) =>
        JSON.stringify(c.options.substitutions) === JSON.stringify([{ find: 'GR00T', replace: 'groot', ignore_case: false }])
        && c.options.read_headings === state.get().options.read_headings),
    `${scriptCalls.length - buildsBefore} calls: ${JSON.stringify(scriptCalls.at(-1)?.options)}`);
ok('   the notes record does not carry the substitutions', savedNotes.every((n) => !('substitutions' in (n.options || {}))));

typeInto(addFind, 'gr00t');
addCase.checked = true;
addCase.dispatch('change');
ok('   a case-insensitive duplicate is flagged while typing',
    addError.textContent === 'This text already has a substitution.' && addError.hidden === false);
const rowsBefore = inPanel('.sub-row').length;
addForm.dispatch('submit');
ok('   ... and cannot be added', inPanel('.sub-row').length === rowsBefore);
typeInto(addFind, '');
addCase.checked = false;
addCase.dispatch('change');

const firstRow = () => inPanel('.sub-row')[0];
const rowFind = firstRow().querySelectorAll('.sub-input')[0];
const buildsAfterAdd = scriptCalls.length;
typeInto(rowFind, '');
ok('   blanking a saved row flags it in place, without re-rendering the field',
    firstRow().querySelectorAll('.sub-error')[0].hidden === false && rowFind.attrs['aria-invalid'] === 'true'
    && firstRow().querySelectorAll('.sub-input')[0] === rowFind);
ok('   ... and typing alone neither saves nor rebuilds',
    lastPrefs()?.[1].subs?.[0]?.find === 'GR00T' && scriptCalls.length === buildsAfterAdd);
rowFind.dispatch('change');
ok('   committing saves the invalid row as typed', lastPrefs()?.[1].subs?.[0]?.find === '');
await waitForRebuild(buildsAfterAdd);
ok('   ... but never sends it: the build goes out without it',
    pagesSince(buildsAfterAdd) === N_PAGES && JSON.stringify(scriptCalls.at(-1).options.substitutions) === '[]');

const buildsBeforeDelete = scriptCalls.length;
inPanel('.sub-delete')[0].click();
ok('   delete removes the row and saves', inPanel('.sub-row').length === 0 && lastPrefs()?.[1].subs?.length === 0);
for (let i = 0; i < 100; i++) await tick(5);
ok('   deleting a row the server never saw does not rebuild', scriptCalls.length === buildsBeforeDelete,
    `${scriptCalls.length - buildsBeforeDelete} extra`);

globalThis.localStorage.getItem = () => JSON.stringify({ voice: 'af_alloy', speed: 1, subs: [{ find: 'π0', replace: 'pi zero' }, 'junk'] });
state.loadPrefs();
ok('   saved subs load through the same untrusted-input rules',
    state.get().subs.length === 2 && state.get().subs[0].find === 'π0' && state.get().subs[1].find === '');
globalThis.localStorage.getItem = () => null;

// ── T7: the notes editor ──────────────────────────────────────────────────────
console.log('\n8. T7 — the block editor lives in #notes-column and rides the record');
const notesColumn = byId.get('notes-column');
ok('   the editor is mounted there', !!notesColumn.querySelector('.ne-panel'));
ok('   ... with a save-state readout',
    notesColumn.querySelector('.ne-status')?.attrs['aria-live'] === 'polite');
ok('   ... and a document area', !!notesColumn.querySelector('.ne-doc'));
ok('   a loaded paper leaves it editable, with a block to type into',
    notesColumn.querySelector('.ne-doc').hidden === false
    && notesColumn.querySelectorAll('.ne-text').length === 1,
    `hidden=${notesColumn.querySelector('.ne-doc').hidden}`);
ok('   the empty-state hint is out of the way while a paper is open',
    notesColumn.querySelector('.ne-hint').hidden === true);
ok('   state carries the blocks the editor holds', Array.isArray(state.get().blocks));

await persistEditorText('a note that must survive a position save');
ok('   every saved record carries the blocks field',
    savedNotes.length > 0 && savedNotes.every((n) => Array.isArray(n.blocks)),
    `${savedNotes.length} saves`);
ok('   ... including the note just typed, alongside the playback position',
    savedNotes.at(-1).blocks.some((b) => b.text === 'a note that must survive a position save')
    && typeof savedNotes.at(-1).last_index === 'number',
    JSON.stringify(savedNotes.at(-1)?.blocks));

// The menu tells the editor to forget where the `/` was typed when it closes, so a
// command that ran after the close found nothing to replace and did nothing at all.
typeIntoEditor('/', '/');
ok('   typing "/" opens the command menu', notesColumn.querySelectorAll('.ne-slash-item').length > 0);
typeIntoEditor('/h1', '1');
const menuItems = notesColumn.querySelectorAll('.ne-slash-item');
ok('   ... and filters down to Heading 1',
    menuItems.length === 1 && menuItems[0].dataset.command === 'h1',
    menuItems.map((i) => i.dataset.command).join());
notesColumn.querySelector('.ne-text').dispatchEvent({ type: 'keydown', key: 'Enter' });
const converted = notesColumn.querySelector('.ne-block');
ok('   picking a command converts the block and clears what was typed',
    converted.dataset.type === 'h1' && converted.querySelector('.ne-text').textContent === '',
    `${converted.dataset.type} ${JSON.stringify(converted.querySelector('.ne-text').textContent)}`);
ok('   ... and the menu is gone', notesColumn.querySelectorAll('.ne-slash-item').length === 0);

// ── T7: keys, paste and markup never escape the editor ───────────────────────
console.log('\n9. T7 — the editor keeps its keys, and text stays text');
const sidebarCollapsed = () => state.get().sidebarCollapsed === true;
const ttsCalls = () => fetchLog.filter((p) => p.includes('/api/tts')).length;
typeIntoEditor('[] ', ' ');
const todoBox = notesColumn.querySelector('.ne-check');
ok('   "[] " made a to-do with a checkbox', !!todoBox);

// Control: the same key from an ordinary element does reach the global shortcuts.
const collapsedAtStart = sidebarCollapsed();
byId.get('toc-panel').dispatchEvent({ type: 'keydown', code: 'KeyB', key: 'b', bubbles: true });
ok('   (control) "b" outside the editor toggles the sidebar', sidebarCollapsed() !== collapsedAtStart);
byId.get('toc-panel').dispatchEvent({ type: 'keydown', code: 'KeyB', key: 'b', bubbles: true });

const ttsBefore = ttsCalls();
todoBox.dispatchEvent({ type: 'keydown', code: 'KeyB', key: 'b', bubbles: true });
todoBox.dispatchEvent({ type: 'keydown', code: 'Space', key: ' ', bubbles: true });
todoBox.dispatchEvent({ type: 'keydown', code: 'ArrowRight', key: 'ArrowRight', bubbles: true });
await tick(20);
ok('   "b" on a focused checkbox leaves the sidebar alone', sidebarCollapsed() === collapsedAtStart);
ok('   Space and → on it start no playback',
    ttsCalls() === ttsBefore && !byId.get('ppBtn').classList.contains('is-playing'),
    `tts ${ttsBefore} → ${ttsCalls()}`);

const clipboard = (data) => ({ getData: (type) => data[type] ?? '' });
const XSS = '<img src=x onerror="globalThis.pwned = 1">';
const editorText = () => notesColumn.querySelector('.ne-text');
editorText().dispatchEvent({ type: 'paste', clipboardData: clipboard({ 'text/html': `<b>bold</b>${XSS}`, 'text/plain': 'plain words' }) });
ok('   a rich paste inserts its plain text only', editorText().textContent === 'plain words',
    JSON.stringify(editorText().textContent));
editorText().dispatchEvent({ type: 'paste', clipboardData: clipboard({ 'text/html': XSS }) });
ok('   an HTML-only paste inserts nothing', editorText().textContent === 'plain words',
    JSON.stringify(editorText().textContent));
editorText().dispatchEvent({ type: 'paste', clipboardData: clipboard({ 'text/plain': XSS }) });
ok('   markup typed as text is rendered as literal text',
    editorText().textContent === `plain words${XSS}` && editorText().children.length === 0
    && editorText().innerHTML === '',
    `text=${JSON.stringify(editorText().textContent)} html=${JSON.stringify(editorText().innerHTML)}`);
ok('   ... and is stored verbatim', state.get().blocks[0].text === `plain words${XSS}`);

// U39 (U-F13): the ⌘ zoom chords are the exception. zoom.js claims them on `document`,
// so a caret in a note must not swallow them; ⌘B is not one and stays in the editor.
let lastKeydown = null;
globalThis.document.addEventListener('keydown', (e) => { lastKeydown = e; });
const chord = (code) => ({ type: 'keydown', code, key: code, metaKey: true, bubbles: true });
const zoomAtStart = state.get().zoom;
const expectedIn = stepZoom(zoomAtStart, 1);
editorText().dispatchEvent(chord('Equal'));
ok('   ⌘+ with the caret in a note zooms the page', state.get().zoom === expectedIn,
    `${zoomAtStart} → ${state.get().zoom}`);
ok('   ... and is claimed, so the browser does not zoom its own chrome too',
    lastKeydown?.code === 'Equal' && lastKeydown.defaultPrevented === true);
const zoomBeforeOut = state.get().zoom;
notesColumn.querySelector('.ne-check').dispatchEvent(chord('Minus'));
ok('   ⌘− from a to-do checkbox zooms out', state.get().zoom === stepZoom(zoomBeforeOut, -1),
    `${zoomBeforeOut} → ${state.get().zoom}`);
lastKeydown = null;
editorText().dispatchEvent(chord('KeyB'));
ok('   ⌘B in a note still never reaches the document', lastKeydown === null && sidebarCollapsed() === collapsedAtStart);
['Equal', 'Minus', 'Digit0'].forEach((code) => editorText().dispatchEvent({ ...chord(code), metaKey: false }));
ok('   a bare =, − or 0 typed in a note is the note\'s, not the document\'s', lastKeydown === null,
    lastKeydown?.code);
const zoomBeforeShift = state.get().zoom;
editorText().dispatchEvent({ ...chord('Equal'), shiftKey: true });
ok('   ⌘⇧= (what the + key really sends) zooms in from a note too',
    state.get().zoom === stepZoom(zoomBeforeShift, 1), `${zoomBeforeShift} → ${state.get().zoom}`);
editorText().dispatchEvent(chord('Minus'));

// ── T7: switching papers inside the save debounce ────────────────────────────
console.log('\n10. T7 — opening another paper writes the outgoing notes first');
const docA = state.get().docId;
const LAST_WORDS = 'typed just before switching';
const savesBefore = savedNotes.length;
editorText().textContent = LAST_WORDS;
editorText().dispatchEvent({ type: 'input', inputType: 'insertText', data: 'g' });
const fileInput = byId.get('file-input');
fileInput.files = [{ name: 'second.pdf', type: 'application/pdf', _bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]) }];
fileInput.dispatch('change', { target: fileInput });
for (let i = 0; i < 400 && !(state.get().docId && state.get().docId !== docA && state.get().sentences.length > 0
    && notesColumn.querySelector('.ne-doc').hidden === false); i++) await tick(5);
const docB = state.get().docId;
const holdsNote = (n) => (n.blocks || []).some((b) => b.text === LAST_WORDS);
ok('   the second paper opened', Boolean(docB) && docB !== docA, `${docA} → ${docB}`);
ok('   paper A was saved with the note typed just before the switch',
    savedNotes.slice(savesBefore).some((n) => n.doc_id === docA && holdsNote(n)),
    JSON.stringify(savedNotes.slice(savesBefore).map((n) => [n.doc_id, n.blocks?.map((b) => b.text)])));
await tick(700);   // past the debounce: any stray timer would have fired by now
ok('   paper B never received it', savedNotes.filter((n) => n.doc_id === docB).every((n) => !holdsNote(n)));
ok('   the editor shows paper B\'s (empty) notes',
    notesColumn.querySelectorAll('.ne-text').map((t) => t.textContent).join('') === '',
    JSON.stringify(notesColumn.querySelectorAll('.ne-text').map((t) => t.textContent)));

console.log('\n11. U7 — the notes column collapses, and the handle stays put');
const notesToggle = byId.get('notesToggleBtn');
const notesHidden = () => body._cls.has('notes-collapsed');
ok('   a fresh profile starts with the notes open',
    !notesHidden() && state.get().notesCollapsed === false && notesColumn.inert === false);
ok('   ... and the handle says so', notesToggle.attrs['aria-expanded'] === 'true'
    && notesToggle.attrs['aria-label'] === 'Hide notes');

notesToggle.click();
ok('   the handle collapses the column', notesHidden() && state.get().notesCollapsed === true);
ok('   the hidden column is inert', notesColumn.inert === true);
ok('   the same handle now offers to bring it back, and names the shortcut',
    notesToggle.attrs['aria-expanded'] === 'false' && notesToggle.attrs['aria-label'] === 'Show notes'
    && notesToggle.attrs.title === 'Show notes (N)');
ok('   the state is saved to kokoro.prefs.v2 beside the sidebar\'s',
    lastPrefs()?.[0] === 'kokoro.prefs.v2' && lastPrefs()[1].notesCollapsed === true
    && typeof lastPrefs()[1].sidebarCollapsed === 'boolean',
    JSON.stringify(lastPrefs()));

notesToggle.click();
ok('   clicking it again brings the notes back', !notesHidden() && state.get().notesCollapsed === false);
ok('   ... the column is live again, and the save records it',
    notesColumn.inert === false && lastPrefs()?.[1].notesCollapsed === false);

key('KeyN');
ok('   N collapses it', notesHidden());
key('KeyN');
ok('   N brings it back', !notesHidden());
key('KeyN', new El('input'));
ok('   N typed into an input does not toggle', !notesHidden());
key('KeyN', Object.assign(new El('div'), { isContentEditable: true }));
ok('   N typed into the notes editor does not toggle', !notesHidden());
key('KeyN', body, { metaKey: true });
ok('   Cmd+N is left to the browser', !notesHidden());

editorText().focus();
ok('   (control) the caret is in the notes editor', document.activeElement === editorText());
ok('   pressing the handle does not blur the editor first (Safari blurs it, Chrome focuses the button)',
    notesToggle.dispatch('mousedown').defaultPrevented === true);
notesToggle.click();
ok('   collapsing the column moves focus out of it, onto the handle',
    document.activeElement === notesToggle, String(document.activeElement?.id));
notesToggle.click();

ok('   both panels collapsed at once is a state the app holds',
    (() => { key('KeyB'); key('KeyN'); return collapsed() && notesHidden(); })());
key('KeyB');
key('KeyN');

globalThis.localStorage.getItem = () => JSON.stringify({ voice: 'af_alloy', speed: 1, notesCollapsed: true });
state.loadPrefs();
ok('   a saved collapsed notes column is restored', state.get().notesCollapsed === true);
globalThis.localStorage.getItem = () => JSON.stringify({ voice: 'af_alloy', speed: 1.25, sidebarCollapsed: true });
state.loadPrefs();
ok('   prefs written before U7 (no notesCollapsed) load with the notes open, the rest intact',
    state.get().notesCollapsed === false && state.get().sidebarCollapsed === true && state.get().speed === 1.25);
globalThis.localStorage.getItem = () => null;

/** Replace the block's text and fire the input event that typing `data` would. */
function typeIntoEditor(text, data) {
    const textEl = notesColumn.querySelector('.ne-text');
    textEl.textContent = text;
    textEl.dispatchEvent({ type: 'input', inputType: 'insertText', data });
}

/** Type into the editor the way an input event would, then let the debounce fire. */
async function persistEditorText(text) {
    const textEl = notesColumn.querySelector('.ne-text');
    textEl.textContent = text;
    textEl.dispatchEvent({ type: 'input', inputType: 'insertText', data: 'e' });
    for (let i = 0; i < 100 && !savedNotes.some((n) => n.blocks?.some((b) => b.text === text)); i++) await tick(10);
}

console.log('\nA1. notes export: the browser downloads, the desktop window saves through the bridge');
{
    const exportBtn = (format) => document.querySelector(`[data-export="${format}"]`);
    const toast = byId.get('toast');
    const { docId, docName } = state.get();
    ok('   (control) a document is loaded to export', !!docId && !!exportBtn('md') && !!exportBtn('json'));

    const opened = [];
    const anchors = [];
    const realOpen = window.open;
    const realCreate = document.createElement;
    window.open = (url) => opened.push(url);
    document.createElement = (t) => { const n = realCreate(t); if (t === 'a') anchors.push(n); return n; };
    exportBtn('md').click();
    exportBtn('json').click();
    ok('   browser: MD opens the export route', opened.length === 1 && opened[0].endsWith('/export.md'), String(opened));
    ok('   browser: JSON is an <a download> named after the paper',
        anchors.length === 1 && anchors[0].download === `${docName}.json`, anchors[0]?.download);

    const saves = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).endsWith('/export.md')
        ? { ok: true, status: 200, text: async () => '# Notes' }
        : realFetch(url, init));
    window.pywebview = { api: { save_export: async (name, text) => { saves.push([name, text]); return `chosen-${name}`; } } };
    opened.length = 0;
    anchors.length = 0;
    exportBtn('md').click();
    await tick(5);
    exportBtn('json').click();
    await tick(5);
    ok('   desktop: MD goes to save_export with the server\'s Markdown',
        saves[0]?.[0] === `${docName}.md` && saves[0]?.[1] === '# Notes', JSON.stringify(saves[0]));
    ok('   desktop: JSON goes to save_export with the highlights',
        saves[1]?.[0] === `${docName}.json` && Array.isArray(JSON.parse(saves[1]?.[1] ?? 'null')), JSON.stringify(saves[1]));
    ok('   desktop: neither window.open nor <a download> is used', opened.length === 0 && anchors.length === 0);
    ok('   desktop: the saved name is shown', toast.textContent === `Saved "chosen-${docName}.json".`, toast.textContent);

    window.pywebview.api.save_export = async () => { throw new Error('Could not save notes.json: Permission denied'); };
    exportBtn('json').click();
    await tick(5);
    ok('   desktop: a failed write is reported as an error',
        toast.className === 'error' && toast.textContent.includes('Permission denied'), toast.textContent);

    delete window.pywebview;
    globalThis.fetch = realFetch;
    window.open = realOpen;
    document.createElement = realCreate;
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

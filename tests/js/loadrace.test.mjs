// Harness for the app shell's load and rebuild ordering (U21): boots the real main.js
// against the faked browser in shellenv.mjs and races papers, rebuilds and key presses.
//
// A2   a paper opened while another is still parsing is the one that loads
// MED  a paper opened mid-build stops the old build's batches and starts at once
// LOW  a rebuild keeps the reading place as it stands when the build lands, never
//      overlaps a new paper's load, and a Subs edit during a superseded build adds no build
// A4 / A7 / A10 / A6  cursor remap, quiet per-sentence status, save on stop, Space ownership

import {
    El, byId, body, listeners, N_PAGES, makePage, scriptCalls, savedNotes, server, pdf, ownedPages,
} from './shellenv.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));
const DEADLINE_TICKS = 400;            // x5ms: every wait below gives up after 2 s
const waitFor = async (cond) => { for (let i = 0; i < DEADLINE_TICKS && !cond(); i++) await tick(5); };

await import('../../static/js/main.js');
await tick(5);
const { state } = globalThis.window.kokoro;
const player = globalThis.window.kokoro.player;
const fileInput = byId.get('file-input');
const notesColumn = byId.get('notes-column');
const bar = byId.get('status-bar');

const openFile = (name, tag) => {
    fileInput.files = [{ name, type: 'application/pdf', _bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, tag]) }];
    fileInput.dispatch('change', { target: fileInput });
};
const isOpen = (name) => state.get().docName === name && !state.get().loading
    && state.get().sentences.length > 0 && notesColumn.querySelector('.ne-doc').hidden === false;
/** Hold the next build POST until `release()`; `held` turns 1 once it is waiting. */
const holdBuilds = () => {
    const gate = { held: 0, release: null };
    const opened = new Promise((r) => { gate.release = r; });
    server.beforeBuild = () => { server.beforeBuild = null; gate.held += 1; return opened; };
    return gate;
};
const statusLog = [];
const realAppend = bar.appendChild.bind(bar);
bar.appendChild = (n) => { statusLog.push(n.textContent ?? ''); return realAppend(n); };
const toastLog = [];
const toastEl = byId.get('toast');
Object.defineProperty(toastEl, 'textContent', {
    get() { return this._text; },
    set(v) { toastLog.push(String(v)); this._text = String(v); this.children = []; },
});

openFile('first.pdf', 0x31);
await waitFor(() => isOpen('first.pdf'));
ok('(setup) a first paper is open', isOpen('first.pdf'), state.get().docName);

// ── A2 ────────────────────────────────────────────────────────────────────────
console.log('\n1. A2 — a paper opened while another is still parsing is the one that loads');
const realGetDocument = pdfjsLib.getDocument;
let releaseSlow = null;
pdfjsLib.getDocument = () => {
    pdfjsLib.getDocument = realGetDocument;   // only this paper parses slowly
    const slowDoc = { numPages: 3, getPage: async () => makePage(), destroy: async () => {} };
    return { promise: new Promise((resolve) => { releaseSlow = () => resolve(slowDoc); }) };
};
openFile('slow.pdf', 0x33);
await waitFor(() => releaseSlow);
openFile('fast.pdf', 0x34);
await tick(100);                       // time for the second paper to finish, were it not held
releaseSlow?.();
await waitFor(() => isOpen('fast.pdf'));
await tick(50);
ok('   the second paper is the one open, with its own pages',
    state.get().docName === 'fast.pdf' && state.get().numPages === N_PAGES && state.get().sentences.length === N_PAGES,
    `${state.get().docName} ${state.get().numPages}p ${state.get().sentences.length}s`);
ok('   the first paper\'s script build never reached the server', scriptCalls.every((c) => c.stats.num_pages !== 3));
ok('   the superseded load failed quietly', !statusLog.some((t) => t.startsWith('Failed to load')));
const noteText = 'a note for the paper that won';
const textEl = () => notesColumn.querySelector('.ne-text');
textEl().textContent = noteText;
textEl().dispatchEvent({ type: 'input', inputType: 'insertText', data: 'n' });
await waitFor(() => savedNotes.some((n) => n.blocks?.some((b) => b.text === noteText)));
ok('   notes are bound to the open paper, so an edit is saved under its id',
    savedNotes.some((n) => n.doc_id === state.get().docId && n.blocks?.some((b) => b.text === noteText)));

// ── MED: a superseded build is cancelled ─────────────────────────────────────
console.log('\n2. a paper opened mid-build stops the old build and starts at once');
const oldBuild = holdBuilds();
openFile('long.pdf', 0x35);
await waitFor(() => oldBuild.held > 0);
const longId = scriptCalls.at(-1)?.doc_id;
const callsAtSwitch = scriptCalls.length;
const toastsAtSwitch = toastLog.length;
openFile('next.pdf', 0x36);
await waitFor(() => isOpen('next.pdf'));
ok('   (control) the old paper\'s first batch is still unanswered', oldBuild.held === 1, `${oldBuild.held} held`);
ok('   the new paper opened without waiting for it', isOpen('next.pdf') && state.get().sentences.length === N_PAGES,
    `${state.get().docName} loading=${state.get().loading}`);
oldBuild.release();
await tick(50);
const oldPosts = () => scriptCalls.slice(callsAtSwitch).filter((c) => c.doc_id === longId).length;
ok('   the old build posted no batch after the switch, even once its batch answered', oldPosts() === 0, `${oldPosts()} posts`);
ok('   ... and raised no stale "Script build failed" toast',
    !toastLog.slice(toastsAtSwitch).some((t) => t.startsWith('Script build failed')));
ok('   the status bar shows the new paper as ready', bar.textContent.startsWith('Ready'), bar.textContent);

// ── A4 + LOW 1: the rebuild keeps the place the reader is at when it lands ────
console.log('\n3. A4 — a rebuild that renumbers the script keeps the reading place');
const rebuildOnce = async (duringBuild = () => {}) => {
    const gate = holdBuilds();
    const from = scriptCalls.length;
    byId.get('rebuildBtn').dispatch('click');
    await waitFor(() => gate.held > 0);
    duringBuild();
    gate.release();
    await waitFor(() => scriptCalls.slice(from).reduce((n, c) => n + ownedPages(c).length, 0) >= N_PAGES);
    await tick(20);
};
player.setIndex(9);                    // page 10
server.skipPage = 2;
await rebuildOnce();
const at = () => `index ${state.get().index} → page ${state.get().sentences[state.get().index]?.page}`;
ok('   the script lost a sentence before the cursor', state.get().sentences.length === N_PAGES - 1);
ok('   ... and the cursor followed its sentence to the new index',
    state.get().index === 8 && state.get().sentences[8].page === 10, at());
server.skipPage = 0;
await rebuildOnce(() => player.setIndex(29));   // the reader moves on while it builds: page 31
ok('   a move made during the rebuild is kept, not snapped back to where it began',
    state.get().sentences[state.get().index]?.page === 31, at());

// ── LOW 2 + 3: a rebuild never overlaps a new paper's load ────────────────────
console.log('\n4. opening a paper mid-rebuild waits for the rebuild to leave pdf.js');
let releaseText = null;
pdf.beforeText = () => new Promise((r) => { releaseText = r; });
let parses = 0;
pdfjsLib.getDocument = (...args) => { parses += 1; return realGetDocument(...args); };
const nextId = state.get().docId;
const callsAtRebuild = scriptCalls.length;
byId.get('rebuildBtn').dispatch('click');
await waitFor(() => releaseText);
openFile('after.pdf', 0x37);
await tick(50);
ok('   the new paper is not parsed while the rebuild is still reading the old one', parses === 0, `${parses} parses`);
const subsPanel = byId.get('tab-subs');
const [addFind, addSay] = subsPanel.querySelectorAll('.sub-add')[0].querySelectorAll('.sub-input');
const typeInto = (input, text) => { input.value = text; input.dispatch('input'); };
typeInto(addFind, 'GR00T');
typeInto(addSay, 'groot');
subsPanel.querySelectorAll('.sub-add')[0].dispatch('submit');
await tick(500);                       // past the Subs debounce, with the rebuild still parked
let staleReads = 0;                    // pages the superseded rebuild reads before the new paper parses
pdf.beforeText = () => { if (parses === 0) staleReads += 1; };
releaseText();
await waitFor(() => isOpen('after.pdf'));
pdf.beforeText = null;
await tick(700);
const afterCalls = scriptCalls.slice(callsAtRebuild);
ok('   then it opens', isOpen('after.pdf') && parses === 1, `${state.get().docName} ${parses} parses`);
ok('   the superseded rebuild stopped reading pages once its parked one answered', staleReads === 0,
    `${staleReads} more pages read`);
ok('   the superseded rebuild posted nothing', afterCalls.every((c) => c.doc_id !== nextId), `${afterCalls.length} calls`);
ok('   the Subs edit made during it costs no extra build: one build, with the edit',
    afterCalls.reduce((n, c) => n + ownedPages(c).length, 0) === N_PAGES
    && afterCalls.every((c) => c.options.substitutions?.[0]?.find === 'GR00T'),
    `${afterCalls.length} calls, ${afterCalls.reduce((n, c) => n + ownedPages(c).length, 0)} pages`);
pdfjsLib.getDocument = realGetDocument;

// ── A10 / A7 ──────────────────────────────────────────────────────────────────
console.log('\n5. A10/A7 — a stop saves the position; per-sentence lines stay quiet');
await tick(700);                       // let earlier saves go out first
player.setIndex(12);                   // not a multiple of the periodic save
await tick(700);
ok('   (control) moving the cursor alone does not save it', !savedNotes.some((n) => n.last_index === 12));
player.stop();
await waitFor(() => savedNotes.some((n) => n.last_index === 12));
ok('   stopping saves the position it stopped at', savedNotes.some((n) => n.last_index === 12));
ok('   ... and "Stopped" is announced', bar.attrs['aria-live'] === 'polite', bar.attrs['aria-live']);
player.play(3);                        // emits the per-sentence "Loading sentence…" line at once
ok('   "Loading sentence…" is shown but not announced',
    bar.textContent.startsWith('Loading sentence') && bar.attrs['aria-live'] === 'off',
    `${bar.textContent} / ${bar.attrs['aria-live']}`);
player.stop();

// ── A6 ────────────────────────────────────────────────────────────────────────
console.log('\n6. A6 — Space belongs to the control that has focus');
const toggles = [];
player.toggle = () => toggles.push('toggle');
const key = (target, mods = {}) => {
    const ev = { type: 'keydown', code: 'Space', key: ' ', target, preventDefault() { ev.defaultPrevented = true; }, defaultPrevented: false, ...mods };
    (listeners.get('keydown') || []).forEach((fn) => fn(ev));
};
key(body);
ok('   (control) Space on the page toggles playback', toggles.length === 1);
const inButton = new El('span');
new El('button').appendChild(inButton);
const roleButton = new El('div');
roleButton.setAttribute('role', 'button');
[new El('button'), inButton, roleButton, new El('summary')].forEach((t) => key(t));
ok('   Space on a button, inside one, on a [role=button] or a summary does not', toggles.length === 1, `${toggles.length}`);
key(body, { defaultPrevented: true });
ok('   Space a handler already claimed does not', toggles.length === 1, `${toggles.length}`);
byId.get('drop-zone').dispatchEvent({ type: 'keydown', code: 'Space', key: ' ', bubbles: true });
ok('   Space on the drop zone opens a file and does not play', toggles.length === 1, `${toggles.length}`);

// ── LOW: a rebuild queued behind a load re-asks whether it is still needed ────
console.log('\n7. a Subs edit made while a paper opens costs that paper one build');
{
    const realFetch = globalThis.fetch;
    let releasePut = null;
    globalThis.fetch = (url, init = {}) => (init.method === 'PUT' && !releasePut
        ? new Promise((r) => { releasePut = r; }).then(() => realFetch(url, init))
        : realFetch(url, init));
    textEl().textContent = 'an edit still unsaved when the next paper opens';
    textEl().dispatchEvent({ type: 'input', inputType: 'insertText', data: 'e' });
    const from = scriptCalls.length;
    openFile('queued.pdf', 0x38);
    await waitFor(() => releasePut);       // the load waits on the outgoing paper's save
    const [find, say] = subsPanel.querySelectorAll('.sub-add')[0].querySelectorAll('.sub-input');
    typeInto(find, 'NVDA');
    typeInto(say, 'nvidia');
    subsPanel.querySelectorAll('.sub-add')[0].dispatch('submit');
    await tick(500);                       // past the Subs debounce: its rebuild queues behind the load
    globalThis.fetch = realFetch;
    releasePut?.();
    await waitFor(() => isOpen('queued.pdf'));
    await tick(700);
    const calls = scriptCalls.slice(from);
    const pages = calls.reduce((n, c) => n + ownedPages(c).length, 0);
    ok('   (control) the save held the load, and the load built with the edit', Boolean(releasePut)
        && calls.length > 0 && calls.every((c) => c.options.substitutions?.some((s) => s.find === 'NVDA')));
    ok('   the queued rebuild finds the edit built and is dropped: one build, not two', pages === N_PAGES,
        `${calls.length} calls, ${pages} pages`);
}

// ── LOW: the paper picked last wins, however long an earlier pick takes to read ─
console.log('\n8. a slow read of an earlier pick does not open over a later one');
const SLOW_READ_MS = 100;
const settled = async (name) => {
    await waitFor(() => isOpen(name));
    await tick(SLOW_READ_MS * 2);          // past the slow read: a late open would have begun
    await waitFor(() => !state.get().loading);
};
fileInput.files = [{ name: 'slowread.pdf', type: 'application/pdf', _readMs: SLOW_READ_MS,
    _bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x39]) }];
fileInput.dispatch('change', { target: fileInput });
openFile('picked.pdf', 0x3a);
await settled('picked.pdf');
ok('   a file read: the paper picked last is the one open', isOpen('picked.pdf'), state.get().docName);
{
    const realFetch = globalThis.fetch;
    globalThis.window.pywebview = { api: { select_pdf: async () => 'bridged.pdf' } };
    globalThis.fetch = (url, init) => (String(url) === '/api/pdf'
        ? tick(SLOW_READ_MS).then(() => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x3b]).buffer }))
        : realFetch(url, init));
    byId.get('drop-zone').dispatch('click');   // the native dialog answers at once; its bytes arrive slowly
    await tick(5);
    openFile('dropped.pdf', 0x3c);
    await settled('dropped.pdf');
    globalThis.fetch = realFetch;
    delete globalThis.window.pywebview;
    ok('   a native-dialog pick: the paper picked last is the one open', isOpen('dropped.pdf'), state.get().docName);
}

console.log('\n9. a pick whose read fails leaves the paper in flight to finish');
{
    const gate = holdBuilds();
    openFile('inflight.pdf', 0x3d);
    await waitFor(() => gate.held === 1);
    fileInput.files = [{ name: 'unreadable.pdf', type: 'application/pdf', _readError: true }];
    fileInput.dispatch('change', { target: fileInput });
    await tick(20);                        // the read fails while the build is held
    gate.release();
    await waitFor(() => isOpen('inflight.pdf'));
    ok('   the paper in flight opens and its load ends', isOpen('inflight.pdf'),
        `${state.get().docName} loading=${state.get().loading}`);
    ok('   the failed read says so', statusLog.some((t) => t.includes('"unreadable.pdf"')));
}

console.log('\n10. a superseded pick that fails leaves the later pick\'s status alone');
{
    const from = statusLog.length;
    fileInput.files = [{ name: 'slowbad.pdf', type: 'application/pdf', _readMs: SLOW_READ_MS, _readError: true }];
    fileInput.dispatch('change', { target: fileInput });
    openFile('good.pdf', 0x3e);
    await settled('good.pdf');
    const realFetch = globalThis.fetch;
    globalThis.window.pywebview = { api: { select_pdf: async () => 'lost.pdf' } };
    globalThis.fetch = (url, init) => (String(url) === '/api/pdf'
        ? tick(SLOW_READ_MS).then(() => { throw new Error('the bridge went away'); })
        : realFetch(url, init));
    byId.get('drop-zone').dispatch('click');
    await tick(5);
    openFile('kept.pdf', 0x3f);
    await settled('kept.pdf');
    globalThis.fetch = realFetch;
    delete globalThis.window.pywebview;
    const errors = statusLog.slice(from).filter((t) => /Could not (read|open)/.test(t));
    ok('   neither the failed read nor the failed bridge fetch shows an error', errors.length === 0, JSON.stringify(errors));
    ok('   the paper picked last is open', isOpen('kept.pdf'), state.get().docName);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

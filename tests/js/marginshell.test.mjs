// Harness for the margin layout's wiring in main.js (U30): boots the real shell against the
// faked browser in shellenv.mjs. Every render of the notes places them before it returns, in
// the view the editor is drawing — so a click or a key in the same frame as a render (the
// notes_editor paste flake, the "/" menu after Enter) meets each note beside its anchor.
import { El, byId } from './shellenv.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));
const DEADLINE_TICKS = 400;            // x5ms: every wait below gives up after 2 s
const waitFor = async (cond) => { for (let i = 0; i < DEADLINE_TICKS && !cond(); i++) await tick(5); };

const BLOCKS = [{ id: 'b1', type: 'p', text: 'a note on page 2', anchor: { page: 2, y: 0.5 } }];
const serverFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (/\/api\/notes\//.test(String(url)) && !init.method) {
    const body = { doc_id: 'x', title: '', highlights: [], blocks: BLOCKS, last_index: 0, options: {} };
    return { ok: true, status: 200, json: async () => body };
  }
  return serverFetch(url, init);
};

// Every page wrap sits at 2000..3100; the column at the fake default top of 0.
const PAGE_TOP = 2000, PAGE_HEIGHT = 1100, NOTE_HEIGHT = 40;
const baseRect = El.prototype.getBoundingClientRect;
El.prototype.getBoundingClientRect = function () {
  if (!this._cls.has('pdf-page-wrap')) return baseRect.call(this);
  return { top: PAGE_TOP, bottom: PAGE_TOP + PAGE_HEIGHT, left: 0, right: 600, width: 600, height: PAGE_HEIGHT };
};
Object.defineProperty(El.prototype, 'offsetHeight', { get: () => NOTE_HEIGHT, configurable: true });
const WANTED_TOP = `${PAGE_TOP + 0.5 * PAGE_HEIGHT}px`;

await import('../../static/js/main.js');
await tick(5);
const { state } = globalThis.window.kokoro;
const fileInput = byId.get('file-input');
fileInput.files = [{ name: 'notes.pdf', type: 'application/pdf', _bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]) }];
fileInput.dispatch('change', { target: fileInput });
await waitFor(() => state.get().docName === 'notes.pdf' && !state.get().loading);
await tick(20);

const note = () => byId.get('notes-column').querySelector('.ne-note');
const option = (view) => byId.get('notes-column').querySelectorAll('.ne-switch-opt')
  .find((el) => el.dataset.view === view);

console.log('\n1. the saved note is drawn beside its anchor');
ok('   the note was rendered', Boolean(note()));
ok('   ... at its anchor', note()?.style.top === WANTED_TOP, note()?.style.top);

console.log('\n2. a render places the notes before it returns, in the view it draws');
option('sections').click();
ok('   the section view lets the notes flow at once', note()?.style.top === '', note()?.style.top);
option('margin').click();
ok('   back in the margin, the note is beside its anchor before any frame runs',
  note()?.style.top === WANTED_TOP, note()?.style.top);
ok('   ... and the switch was reported', state.get().notesView === 'margin', state.get().notesView);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

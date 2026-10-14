// Harness for R3: the Highlights list is a collapsible section at the top of the notes column,
// and its open/closed state is a preference. Boots the real shell (shellenv.mjs) with a saved
// profile that left the list collapsed, and a paper that has two highlights.
import { El, byId } from './shellenv.mjs';
import { createNotesPanel } from '../../static/js/notes.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));
const DEADLINE_TICKS = 400;            // x5ms: every wait below gives up after 2 s
const waitFor = async (cond) => { for (let i = 0; i < DEADLINE_TICKS && !cond(); i++) await tick(5); };

const PREF_KEY = 'kokoro.prefs.v2';
const saved = [];
globalThis.localStorage = {
  getItem: (key) => (key === PREF_KEY ? JSON.stringify({ highlightsCollapsed: true }) : null),
  setItem: (key, value) => { if (key === PREF_KEY) saved.push(JSON.parse(value)); },
  removeItem: () => {},
};
const lastSaved = () => saved[saved.length - 1] || {};

const rects = [{ x: 0.1, y: 0.1, w: 0.3, h: 0.02 }];
const HIGHLIGHTS = [
  { id: 'h1', page: 2, color: 'yellow', text: 'first', note: '', rects, created_at: '2026-10-01' },
  { id: 'h2', page: 3, color: 'blue', text: 'second', note: 'why', rects, created_at: '2026-10-02' },
];
const serverFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (/\/api\/notes\//.test(String(url)) && !init.method) {
    const body = { doc_id: 'x', title: '', highlights: HIGHLIGHTS, blocks: [], last_index: 0, options: {} };
    return { ok: true, status: 200, json: async () => body };
  }
  return serverFetch(url, init);
};

await import('../../static/js/main.js');
await tick(5);
const { state } = globalThis.window.kokoro;
const fileInput = byId.get('file-input');
fileInput.files = [{ name: 'hl.pdf', type: 'application/pdf', _bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]) }];
fileInput.dispatch('change', { target: fileInput });
await waitFor(() => state.get().docName === 'hl.pdf' && !state.get().loading && state.get().highlights.length === 2);
await tick(20);

const column = byId.get('notes-column');
const panel = byId.get('notes-panel');
const toggle = () => panel.querySelector('.nt-disclosure');
const content = () => panel.querySelector('.nt-content');

console.log('\n1. the list heads the notes column');
ok('   #notes-panel is in #notes-column, before the margin notes',
  column.children.indexOf(panel) >= 0 && column.children.indexOf(panel) < column.children.findIndex((c) => c._cls?.has('ne-panel')),
  column.children.map((c) => c.id || c.className).join(','));
ok('   its heading is a disclosure button that names what it opens',
  toggle()?.tagName === 'BUTTON' && toggle().attrs['aria-controls'] === content()?.id && Boolean(content()?.id));
ok('   the heading reads "Highlights" with the count', /Highlights/.test(toggle()?.textContent) && /2/.test(toggle()?.textContent),
  toggle()?.textContent);

console.log('\n2. the saved state comes back');
ok('   a profile that collapsed it starts collapsed', toggle()?.attrs['aria-expanded'] === 'false' && content()?.hidden === true
  && state.get().highlightsCollapsed === true, `${toggle()?.attrs['aria-expanded']} ${content()?.hidden}`);
ok('   ... with the export buttons still in reach in the heading',
  panel.querySelectorAll('[data-export]').length === 2 && !content().contains(panel.querySelector('[data-export]')));

console.log('\n3. the heading toggles it, and the choice is saved');
toggle().click();
ok('   one click opens it', toggle().attrs['aria-expanded'] === 'true' && content().hidden === false);
ok('   ... and saves it open', state.get().highlightsCollapsed === false && lastSaved().highlightsCollapsed === false,
  JSON.stringify(lastSaved()));
ok('   the rows are there to click', content().querySelectorAll('.nt-row').length === 2);
toggle().click();
ok('   another click closes it, and saves that', content().hidden === true && lastSaved().highlightsCollapsed === true);

console.log('\n4. a fresh panel starts open and reports each toggle');
{
  const reports = [];
  const box = new El('div');
  createNotesPanel({ root: box, onToggle: (collapsed) => reports.push(collapsed) });
  ok('   no saved state: open', box.querySelector('.nt-disclosure')?.attrs['aria-expanded'] === 'true'
    && box.querySelector('.nt-content')?.hidden === false);
  box.querySelector('.nt-disclosure').click();
  box.querySelector('.nt-disclosure').click();
  ok('   onToggle hears collapsed, then open', JSON.stringify(reports) === '[true,false]', JSON.stringify(reports));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

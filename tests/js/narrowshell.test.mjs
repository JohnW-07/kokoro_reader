// Harness for the narrow-window wiring in main.js (N13): boots the real shell against the faked
// browser in shellenv.mjs, then resizes it across the narrow breakpoint the way a drag to half
// the screen does. Both panels fold without touching the saved layout; B, N, the rail and the
// notes handle act on what is on screen; widening puts the saved layout back.
import { El, body, byId, resizeAcross } from './shellenv.mjs';
import { NARROW_QUERY } from '../../static/js/layout.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));

const saves = [];
globalThis.localStorage.setItem = (_k, v) => saves.push(JSON.parse(v));

await import('../../static/js/main.js');
await tick(5);
const { state } = globalThis.window.kokoro;
const folded = (cls) => body._cls.has(cls);
const key = (code, target = body) => globalThis.document.dispatch('keydown', { code, target });

console.log('\n1. a half-screen window folds both panels, and only on screen');
ok('   (control) a wide window shows the saved layout: both open', !folded('sidebar-collapsed') && !folded('notes-collapsed'));
resizeAcross(NARROW_QUERY, true);
ok('   narrowed: the sidebar is on its rail and the notes are away',
    folded('sidebar-collapsed') && folded('notes-collapsed') && byId.get('sidebar').inert && !byId.get('rail').inert);
ok('   ... the prefs still say open, and nothing was saved',
    !state.get().sidebarCollapsed && !state.get().notesCollapsed && saves.length === 0, `${saves.length} saves`);

console.log('\n2. while narrow, the toggles act on what is on screen and save nothing');
key('KeyB');
ok('   B opens the folded sidebar', !folded('sidebar-collapsed'));
byId.get('collapseBtn').dispatch('click');
ok('   its collapse button folds it again', folded('sidebar-collapsed'));
byId.get('expandBtn').click();
ok('   the rail\'s expand button opens it', !folded('sidebar-collapsed'));
key('KeyN');
ok('   N opens the folded notes', !folded('notes-collapsed'));
byId.get('notesToggleBtn').dispatch('click');
ok('   the notes handle folds them again', folded('notes-collapsed'));
ok('   none of it reached the saved prefs', saves.every((p) => !p.sidebarCollapsed && !p.notesCollapsed)
    && !state.get().sidebarCollapsed && !state.get().notesCollapsed, JSON.stringify(saves.at(-1)));
key('KeyB', new El('input'));
ok('   B typed into a field is just a letter', !folded('sidebar-collapsed'));

console.log('\n3. widening puts the saved layout back; toggles are saved again');
resizeAcross(NARROW_QUERY, false);
ok('   both panels are back as saved', !folded('sidebar-collapsed') && !folded('notes-collapsed') && byId.get('rail').inert);
key('KeyB');
ok('   B folds the sidebar and saves it', folded('sidebar-collapsed') && saves.at(-1)?.sidebarCollapsed === true);
resizeAcross(NARROW_QUERY, true);
resizeAcross(NARROW_QUERY, false);
ok('   a saved fold survives a narrow spell', folded('sidebar-collapsed') && !folded('notes-collapsed'));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

// Pure helpers behind the collapsible sidebar, the rail and fit-to-width pages.
import { fitScale, nextSpeed, formatSpeed, isTypingTarget, applyNotesCollapsed, SPEED_PRESETS,
    SIDEBAR_SHORTCUT, NOTES_SHORTCUT, createPanels, NARROW_QUERY, NARROW_MAX_WIDTH_PX } from '../../static/js/layout.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

const LETTER_PT = 612;
const VIEW_MAX_SCALE = 1.4;

console.log('\n1. fitScale');
ok('   a wide column is capped at the view scale', fitScale(2000, LETTER_PT, VIEW_MAX_SCALE) === VIEW_MAX_SCALE);
const s = fitScale(700, LETTER_PT, VIEW_MAX_SCALE);
ok('   a narrow column fits, never wider than the column', s < VIEW_MAX_SCALE && LETTER_PT * s <= 700, String(s));
ok('   ... and is floored to two decimals', s === 1.14, String(s));
ok('   a tiny column stops at the readable minimum', fitScale(50, LETTER_PT, VIEW_MAX_SCALE) === 0.6);
ok('   unknown widths give null, not NaN',
    fitScale(0, LETTER_PT, VIEW_MAX_SCALE) === null && fitScale(700, 0, VIEW_MAX_SCALE) === null
    && fitScale(NaN, LETTER_PT, VIEW_MAX_SCALE) === null);

console.log('\n2. nextSpeed / formatSpeed');
ok('   steps to the next preset', nextSpeed(1) === 1.25 && nextSpeed(1.25) === 1.5);
ok('   an off-preset speed goes to the next preset above it', nextSpeed(1.1) === 1.25);
ok('   wraps from the fastest', nextSpeed(2) === SPEED_PRESETS[0]);
ok('   formats like the slider readout', formatSpeed(1) === '1×' && formatSpeed(1.25) === '1.25×' && formatSpeed(1.5) === '1.5×');

console.log('\n3. shortcut guard');
ok('   the sidebar shortcut is B, the notes shortcut is N',
    SIDEBAR_SHORTCUT === 'KeyB' && NOTES_SHORTCUT === 'KeyN');
ok('   the two do not collide', SIDEBAR_SHORTCUT !== NOTES_SHORTCUT);
ok('   inputs, selects, textareas and contenteditable are typing targets',
    ['INPUT', 'SELECT', 'TEXTAREA'].every((tagName) => isTypingTarget({ tagName }))
    && isTypingTarget({ tagName: 'DIV', isContentEditable: true }));
ok('   the page body and buttons are not', !isTypingTarget({ tagName: 'BODY' }) && !isTypingTarget({ tagName: 'BUTTON' }) && !isTypingTarget(null));

console.log('\n4. applyNotesCollapsed');
// A DOM stand-in: only the nodes the function touches.
const fakeDoc = () => {
    const classes = new Set();
    const nodes = {
        'notes-column': { inert: false },
        notesToggleBtn: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    };
    return {
        classes,
        nodes,
        body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
        getElementById: (id) => nodes[id] ?? null,
    };
};

const doc = fakeDoc();
applyNotesCollapsed(true, doc);
ok('   collapsing marks the body and makes the hidden column inert',
    doc.classes.has('notes-collapsed') && doc.nodes['notes-column'].inert === true);
ok('   the handle flips to "show", and its title names the shortcut',
    doc.nodes.notesToggleBtn.attrs['aria-expanded'] === 'false'
    && doc.nodes.notesToggleBtn.attrs['aria-label'] === 'Show notes'
    && doc.nodes.notesToggleBtn.attrs.title === 'Show notes (N)',
    JSON.stringify(doc.nodes.notesToggleBtn.attrs));

applyNotesCollapsed(false, doc);
ok('   expanding clears both, and the handle flips back',
    !doc.classes.has('notes-collapsed') && doc.nodes['notes-column'].inert === false
    && doc.nodes.notesToggleBtn.attrs['aria-expanded'] === 'true'
    && doc.nodes.notesToggleBtn.attrs['aria-label'] === 'Hide notes');

const bare = fakeDoc();
bare.getElementById = () => null;
applyNotesCollapsed(true, bare);
ok('   a page without the column or the handle is marked, not crashed',
    bare.classes.has('notes-collapsed'));

console.log('\n5. createPanels: a narrow window folds both panels without touching the saved layout (N13)');
// A half-screen snap on a 1512 pt display is 756 wide: well inside the narrow range.
const HALF_SCREEN_PX = 756;
ok(`   the breakpoint is a max-width query at ${NARROW_MAX_WIDTH_PX}px, above half a 1512 pt screen`,
    NARROW_QUERY === `(max-width: ${NARROW_MAX_WIDTH_PX}px)` && NARROW_MAX_WIDTH_PX > HALF_SCREEN_PX, NARROW_QUERY);
/** A media query list the test resizes across, a state store that counts saves, the DOM nodes the panels touch. */
const panelsEnv = ({ narrow = false, prefs = {} } = {}) => {
    const media = { matches: narrow, fns: [], addEventListener(t, fn) { if (t === 'change') this.fns.push(fn); } };
    const resize = (on) => { media.matches = on; media.fns.forEach((fn) => fn({ matches: on })); };
    let s = Object.freeze({ sidebarCollapsed: false, notesCollapsed: false, ...prefs });
    const saved = [];
    const state = { get: () => s, set: (patch) => { s = Object.freeze({ ...s, ...patch }); }, savePrefs: () => saved.push(s) };
    const classes = new Set();
    const node = () => ({ inert: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, contains: () => false, focus() {} });
    const nodes = Object.fromEntries(['sidebar', 'rail', 'collapseBtn', 'expandBtn', 'notes-column', 'notesToggleBtn'].map((id) => [id, node()]));
    const doc = {
        body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) } },
        getElementById: (id) => nodes[id] ?? null,
        activeElement: null,
    };
    doc.activeElement = doc.body;
    const panels = createPanels({ state, media, doc });
    return { panels, state, saved, classes, nodes, resize };
};
{
    const t = panelsEnv();
    ok('   (control) wide, a fresh profile shows both', !t.classes.has('sidebar-collapsed') && !t.classes.has('notes-collapsed'));
    t.resize(true);
    ok('   narrowed: the sidebar folds to its rail and the notes fold away',
        t.classes.has('sidebar-collapsed') && t.classes.has('notes-collapsed')
        && t.nodes.sidebar.inert && !t.nodes.rail.inert && t.nodes['notes-column'].inert);
    ok('   ... and none of that is saved as the reader\'s layout',
        t.saved.length === 0 && !t.state.get().sidebarCollapsed && !t.state.get().notesCollapsed);
    t.panels.toggleSidebar();
    ok('   B while narrow opens the sidebar that is folded (not the one the prefs say)', !t.classes.has('sidebar-collapsed'));
    t.panels.toggleSidebar();
    t.panels.toggleNotes();
    ok('   ... and a fold or unfold made there is for now only', t.saved.length === 0 && t.classes.has('sidebar-collapsed')
        && !t.classes.has('notes-collapsed') && !t.state.get().sidebarCollapsed, `${t.saved.length} saves`);
    t.resize(false);
    ok('   widened: the saved layout comes back', !t.classes.has('sidebar-collapsed') && !t.classes.has('notes-collapsed')
        && !t.nodes.sidebar.inert && t.nodes.rail.inert);
    t.panels.toggleSidebar();
    ok('   wide, a toggle is the reader\'s choice and is saved', t.classes.has('sidebar-collapsed')
        && t.state.get().sidebarCollapsed === true && t.saved.length === 1);
}
{
    const t = panelsEnv({ prefs: { sidebarCollapsed: true } });
    ok('   a saved fold is shown at start', t.classes.has('sidebar-collapsed') && !t.classes.has('notes-collapsed'));
    t.resize(true);
    t.resize(false);
    ok('   ... and is still there after a narrow spell', t.classes.has('sidebar-collapsed') && !t.classes.has('notes-collapsed'));
}
{
    const t = panelsEnv({ narrow: true });
    ok('   a window that opens narrow starts folded, prefs untouched',
        t.classes.has('sidebar-collapsed') && t.classes.has('notes-collapsed') && t.saved.length === 0);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

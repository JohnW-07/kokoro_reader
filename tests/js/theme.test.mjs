// Harness for the colour themes (docs/19): themeboot.js, the classic <head> script that sets
// <html data-theme> before the first paint, and themeswitch.js, the Settings select. The boot
// script runs in a vm context per scenario, against a fake document, storage and appearance.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { initThemeSwitch } from '../../static/js/themeswitch.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

const BOOT = readFileSync(new URL('../../static/js/themeboot.js', import.meta.url), 'utf8');
const PREF_KEY = 'kokoro.prefs.v2';

/** Run themeboot.js once. `prefs` is what localStorage holds (a string, an object, or a throw). */
function boot({ prefs, systemDark = false } = {}) {
    const store = new Map(prefs === undefined ? [] : [[PREF_KEY, typeof prefs === 'string' ? prefs : JSON.stringify(prefs)]]);
    const listeners = { storage: [], change: [] };
    const query = { matches: systemDark, addEventListener: (_t, fn) => listeners.change.push(fn) };
    const ctx = {
        document: { documentElement: { dataset: {} } },
        localStorage: prefs === 'THROW'
            ? { getItem() { throw new Error('denied'); } }
            : { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
        matchMedia: () => query,
        addEventListener: (t, fn) => listeners[t]?.push(fn),
    };
    ctx.globalThis = ctx;
    runInNewContext(BOOT, ctx);
    const theme = () => ctx.document.documentElement.dataset.theme;
    return { ctx, theme, store, query, listeners };
}

console.log('\n1. themeboot.js — the saved theme is drawn before anything else runs');
ok('   no saved prefs: Light', boot().theme() === 'light');
ok('   prefs from before themes (no theme field): Light', boot({ prefs: { voice: 'af_aoede' } }).theme() === 'light');
for (const id of ['light', 'dark', 'dark-warm', 'sepia']) {
    ok(`   saved "${id}" is drawn as "${id}"`, boot({ prefs: { theme: id } }).theme() === id);
}
ok('   an unknown id draws Light', boot({ prefs: { theme: 'neon' } }).theme() === 'light');
ok('   corrupt prefs draw Light and do not throw', boot({ prefs: '{not json' }).theme() === 'light');
ok('   storage that throws draws Light and does not throw', boot({ prefs: 'THROW' }).theme() === 'light');

console.log('\n2. Match system follows the appearance, live');
ok('   system + light appearance: Light', boot({ prefs: { theme: 'system' } }).theme() === 'light');
const sys = boot({ prefs: { theme: 'system' }, systemDark: true });
ok('   system + dark appearance: Dark', sys.theme() === 'dark');
sys.query.matches = false;
sys.listeners.change.forEach((fn) => fn());
ok('   the appearance turning light redraws Light', sys.theme() === 'light');
const fixed = boot({ prefs: { theme: 'dark-warm' } });
fixed.query.matches = true;
fixed.listeners.change.forEach((fn) => fn());
ok('   ... but a chosen theme ignores the appearance', fixed.theme() === 'dark-warm');

console.log('\n3. another window saving a theme (the reader, the stats page) redraws this one');
const other = boot({ prefs: { theme: 'light' } });
other.store.set(PREF_KEY, JSON.stringify({ theme: 'sepia' }));
other.listeners.storage.forEach((fn) => fn({ key: 'unrelated' }));
ok('   an unrelated key changes nothing', other.theme() === 'light');
other.listeners.storage.forEach((fn) => fn({ key: PREF_KEY }));
ok('   the prefs key redraws with the saved theme', other.theme() === 'sepia');

console.log('\n4. kokoroTheme.apply — what the Settings select calls');
const live = boot();
live.ctx.kokoroTheme.apply('dark-warm');
ok('   apply(id) draws it at once', live.theme() === 'dark-warm');
ok('   resolve: system is Dark on a dark appearance', live.ctx.kokoroTheme.resolve('system', true) === 'dark');

console.log('\n5. themeswitch.js — the Settings select shows, saves and applies the theme');
function fakeSelect(values) {
    const handlers = {};
    let value = values[0];
    return {
        get value() { return value; },
        set value(v) { value = values.includes(v) ? v : ''; },   // a <select> takes only its options' values
        addEventListener: (t, fn) => { handlers[t] = fn; },
        fire: (t) => handlers[t](),
    };
}
function harness(savedTheme) {
    let s = { theme: savedTheme };
    const saved = [];
    const applied = [];
    const select = fakeSelect(['light', 'sepia', 'dark', 'dark-warm', 'system']);
    initThemeSwitch({
        state: { get: () => s, set: (patch) => { s = { ...s, ...patch }; }, savePrefs: () => saved.push(s.theme) },
        ui: { el: (id) => (id === 'themeSelect' ? select : null) },
        theme: { apply: (pref) => applied.push(pref) },
    });
    return { select, saved, applied, state: () => s };
}
const h = harness('dark-warm');
ok('   the saved theme is selected', h.select.value === 'dark-warm');
h.select.value = 'system';
h.select.fire('change');
ok('   a change is put in state and saved', h.state().theme === 'system' && h.saved.join() === 'system');
ok('   ... and applied at once', h.applied.join() === 'system');
ok('   an id this build does not offer shows Light', harness('neon').select.value === 'light');
ok('   no select in the page: nothing to bind, no throw',
    (() => { try { initThemeSwitch({ state: { get: () => ({}) }, ui: { el: () => null } }); return true; } catch { return false; } })());

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

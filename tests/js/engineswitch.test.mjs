// The Siri voice as an option of the voice dropdown (R5): which voice is requested, what
// picking it does, and how the dropdown shows the saved engine (N2).
import { SIRI_VOICE, SIRI_LABEL, SIRI_GROUP_LABEL, ttsVoice, initEngineSwitch, reflectEngine } from '../../static/js/engineswitch.js';
import { createSettings } from '../../static/js/settings.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

// A select whose `options` reach into optgroups, as the DOM's does.
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.value = ''; this.textContent = ''; this.label = ''; this.kids = []; this.parent = null; }
  appendChild(o) { o.parent = this; this.kids.push(o); return o; }
  remove() { this.parent?.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; }
}
globalThis.document = { createElement: (tag) => new Node(tag) };
function fakeSelect(values) {
  const select = Object.assign(new Node('select'), { disabled: false, listeners: {} });
  Object.defineProperty(select, 'options', {
    get() { return this.kids.flatMap((k) => (k.tagName === 'OPTGROUP' ? k.kids : [k])); },
  });
  select.replaceChildren = (...os) => { select.kids = []; os.forEach((o) => select.appendChild(o)); };
  select.addEventListener = (type, fn) => { select.listeners[type] = fn; };
  values.forEach((v) => select.appendChild(Object.assign(new Node('option'), { value: v, textContent: v })));
  select.value = values[0];
  return select;
}
const siriOptions = (sel) => sel.options.filter((o) => o.value === SIRI_VOICE);

function fakes(initial, values = ['af_aoede', 'bm_george']) {
  let current = { ...initial };
  const select = fakeSelect(values);
  const log = { saves: 0, switches: 0, toasts: [] };
  const state = { get: () => current, set: (p) => { current = { ...current, ...p }; }, savePrefs: () => { log.saves++; } };
  const ui = { el: (id) => (id === 'voiceSelect' ? select : null), toast: (m) => log.toasts.push(m) };
  const pick = (value) => { select.value = value; select.listeners.change({ target: select }); };
  return { state, ui, select, log, pick, onSwitch: () => { log.switches++; } };
}

console.log('\n1. the requested voice');
ok('   off: the chosen Kokoro voice', ttsVoice({ voice: 'af_aoede', siriVoice: false }) === 'af_aoede');
ok('   on: Siri, whatever Kokoro voice is chosen', ttsVoice({ voice: 'bm_george', siriVoice: true }) === SIRI_VOICE);
ok('   absent flag (older prefs) is off', ttsVoice({ voice: 'af_aoede' }) === 'af_aoede');

console.log('\n2. R5 — the dropdown offers Siri in its own macOS group');
const sel = fakeSelect(['af_aoede', 'bm_george']);
reflectEngine(sel, { voice: 'bm_george', siriVoice: false });
const group = siriOptions(sel)[0]?.parent;
ok('   one Siri option, labelled as the macOS voice', siriOptions(sel).length === 1 && siriOptions(sel)[0].textContent === SIRI_LABEL);
ok('   ... inside an optgroup named macOS', group?.tagName === 'OPTGROUP' && group.label === SIRI_GROUP_LABEL && SIRI_GROUP_LABEL === 'macOS');
ok('   ... after the Kokoro voices', sel.kids.at(-1) === group);
ok('   off: the saved Kokoro voice is selected and the select enabled', sel.value === 'bm_george' && sel.disabled === false);
reflectEngine(sel, { voice: 'bm_george', siriVoice: true });
ok('   N2 on: Siri is selected, and the select stays usable', sel.value === SIRI_VOICE && sel.disabled === false);
reflectEngine(sel, { voice: 'bm_george', siriVoice: true });
ok('   repeated: still one Siri option', siriOptions(sel).length === 1 && sel.options.length === 3);
let nullThrew = false;
try { reflectEngine(null, { voice: 'af_aoede', siriVoice: true }); } catch { nullThrew = true; }
ok('   no select in the markup: a no-op', !nullThrew);

console.log('\n3. R5 — picking voices flips the engine live');
const f = fakes({ voice: 'af_aoede', siriVoice: false });
initEngineSwitch(f);
ok('   the Siri option is there from the start', siriOptions(f.select).length === 1 && f.select.value === 'af_aoede');
f.pick(SIRI_VOICE);
ok('   picking Siri: requests go to Siri, saved, audio dropped',
    ttsVoice(f.state.get()) === SIRI_VOICE && f.log.saves === 1 && f.log.switches === 1);
ok('   ... the Kokoro voice choice is kept', f.state.get().voice === 'af_aoede');
ok('   ... and it says so', /Siri/.test(f.log.toasts.at(-1)), f.log.toasts.at(-1));
f.pick('bm_george');
ok('   picking a Kokoro voice: Siri off, that voice chosen, audio dropped',
    f.state.get().siriVoice === false && f.state.get().voice === 'bm_george' && f.log.saves === 2 && f.log.switches === 2);
ok('   ... and it says Kokoro is back', /Kokoro/.test(f.log.toasts.at(-1)), f.log.toasts.at(-1));
f.pick('af_aoede');
ok('   Kokoro to Kokoro: the voice changes, audio dropped',
    f.state.get().voice === 'af_aoede' && f.state.get().siriVoice === false && f.log.switches === 3);
ok('   ... with the plain voice-changed toast', /voice changed/i.test(f.log.toasts.at(-1)), f.log.toasts.at(-1));

console.log('\n4. R5 — the old Siri switch pref migrates');
const m = fakes({ voice: 'bm_george', siriVoice: true });
initEngineSwitch(m);
ok('   siriVoice=true from the old switch: the dropdown shows Siri', m.select.value === SIRI_VOICE);
ok('   ... and requests still go to Siri', ttsVoice(m.state.get()) === SIRI_VOICE && m.state.get().voice === 'bm_george');
const bare = fakes({ voice: 'af_aoede' });
bare.ui.el = () => null;
let threw = false;
try { initEngineSwitch(bare); } catch { threw = true; }
ok('   markup without the dropdown: a no-op, not a crash', !threw);

console.log('\n5. settings.js — saved prefs and the async voice list keep Siri');
const h = fakes({ voice: 'bm_george', siriVoice: true, speed: 1, options: {} });
Object.assign(h.ui, { setSpeedLabel: () => {}, bindOptions: () => {} });
const baseEl = h.ui.el;
const slider = { value: '', addEventListener: () => {} };
h.ui.el = (id) => (id === 'speedSlider' ? slider : baseEl(id));
const settings = createSettings({ api: { voices: async () => ({ voices: ['af_aoede', 'af_heart', 'bm_george'] }) },
    state: { ...h.state, clampSpeed: Number }, ui: h.ui, clearAudio: h.onSwitch });
settings.bind();
settings.applyPrefs();
ok('   applyPrefs shows Siri for a saved siriVoice', h.select.value === SIRI_VOICE);
await settings.loadVoices();
ok('   after loadVoices the Siri option is back and selected', h.select.value === SIRI_VOICE && siriOptions(h.select).length === 1);
ok('   the server list is there too', h.select.options.length === 4);
ok('   state.voice keeps the Kokoro voice', h.state.get().voice === 'bm_george');
h.pick('af_heart');
ok('   one change handler: one save, one audio drop, one toast',
    h.log.saves === 1 && h.log.switches === 1 && h.log.toasts.length === 1, JSON.stringify(h.log));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

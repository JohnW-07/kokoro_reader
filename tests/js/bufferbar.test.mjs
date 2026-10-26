// N1: the buffer meter. ttsclient reports how much audio is ready after the cursor
// (`readyAhead`) and when that may have changed (`onChange`); bufferbar.js draws it,
// plus a "Loading voice model…" state while /api/health says the model is not loaded.
import { createTtsClient } from '../../static/js/ttsclient.js';
import { createBufferBar, bufferView, LOADING_TEXT, FETCHING_TEXT } from '../../static/js/bufferbar.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

// ── fakes: a fetch the test answers by hand, blob urls, a tiny DOM ─────────────
const pending = [];
globalThis.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
  const text = new URL(`http://x${url}`).searchParams.get('text');
  opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  pending.push({ text, answer: () => resolve({ ok: true, status: 200, blob: async () => ({ text }) }) });
});
const answerAll = async () => { pending.splice(0).forEach((p) => p.answer()); await flush(); };
globalThis.URL.createObjectURL = (b) => `blob:${b.text}`;
globalThis.URL.revokeObjectURL = () => {};

class El {
  constructor() { this.children = []; this.attrs = {}; this.style = { setProperty(k, v) { this[k] = String(v); } }; this.textContent = ''; this.cls = new Set(); }
  get classList() { return { toggle: (c, on) => (on ? this.cls.add(c) : this.cls.delete(c)), contains: (c) => this.cls.has(c) }; }
  set className(v) { this.cls = new Set(v.split(' ')); }
  append(...n) { this.children.push(...n); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
}
globalThis.document = { createElement: () => new El() };

const V = 'af_aoede', SP = 1;
const entries = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ key: from + i, text: `s${from + i}`, voice: V, speed: SP }));

console.log('\n1. ttsclient.readyAhead counts contiguous cached sentences after the cursor');
{
  const tts = createTtsClient({ maxInflight: 4 });
  ok('   nothing cached: 0', tts.readyAhead(0, 3, V, SP) === 0);
  tts.prefetch([entries(1, 1)[0], entries(3, 3)[0]]);
  await answerAll();
  ok('   1 ready, 2 missing, 3 ready: only the run counts', tts.readyAhead(0, 3, V, SP) === 1);
  tts.prefetch(entries(2, 2));
  await answerAll();
  ok('   1..3 ready: 3', tts.readyAhead(0, 3, V, SP) === 3);
  ok('   n caps the count', tts.readyAhead(0, 2, V, SP) === 2);
  ok('   the cursor itself is not counted', tts.readyAhead(1, 3, V, SP) === 2);
  ok('   another voice is not ready', tts.readyAhead(0, 3, 'bm_george', SP) === 0);
  ok('   another speed is not ready', tts.readyAhead(0, 3, V, 1.5) === 0);
  ok('   isPending: nothing in flight', !tts.isPending(4, V, SP));
  tts.prefetch(entries(4, 4));
  ok('   isPending: queued or in flight', tts.isPending(4, V, SP) && !tts.isPending(4, V, 1.5) && !tts.isPending(5, V, SP));
  await answerAll();
  ok('   isPending: stored is no longer pending', !tts.isPending(4, V, SP));
  ok('   isCached: stored, for that voice and speed only', tts.isCached(4, V, SP) && !tts.isCached(4, V, 1.5) && !tts.isCached(5, V, SP));
  tts.clear();
  ok('   isCached: not after clear()', !tts.isCached(4, V, SP));
  const before = tts.stats().hits;
  tts.readyAhead(0, 3, V, SP);
  ok('   a read-only probe: no hit counted', tts.stats().hits === before);
}

console.log('\n2. ttsclient.onChange fires on what changes the buffer');
{
  const tts = createTtsClient({ maxInflight: 1 });
  const kinds = [];
  const off = tts.onChange((k) => kinds.push(k));
  tts.prefetch(entries(1, 2));
  ok('   queueing work', kinds.includes('queue'));
  await answerAll(); await answerAll();
  ok('   each stored sentence', kinds.filter((k) => k === 'store').length === 2);
  tts.setCurrent(1);
  ok('   the cursor moving', kinds.includes('current'));
  tts.drop(1);
  ok('   drop', kinds.includes('drop'));
  tts.clear();
  ok('   clear', kinds.includes('clear'));
  tts.prefetch(entries(5, 5));
  tts.setWindow(50);
  ok('   cancel', kinds.includes('cancel'));
  const n = kinds.length;
  off();
  tts.clear();
  ok('   unsubscribe stops it', kinds.length === n);
  const noisy = createTtsClient();
  noisy.onChange(() => { throw new Error('listener bug'); });
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a);
  let threw = false;
  try { noisy.clear(); } catch { threw = true; } finally { console.warn = warn; }
  ok('   a throwing listener cannot break the client, and is reported', !threw && warned.length === 1);
  await answerAll();
}

console.log('\n3. bufferView: what the bar shows');
{
  const half = bufferView({ ready: 1, want: 2, isLoading: false });
  ok('   ready/want is the fill', half.fraction === 0.5 && !half.isLoading);
  ok('   says how many are ready', /1 of 2/.test(half.valueText));
  ok('   end of the document: nothing to want is full', bufferView({ ready: 0, want: 0, isLoading: false }).fraction === 1);
  const loading = bufferView({ ready: 0, want: 3, isLoading: true });
  ok('   loading says so', loading.isLoading && loading.valueText === LOADING_TEXT);
}

console.log('\n4. createBufferBar renders the buffer after the cursor');
function fakeState(initial) {
  let current = initial;
  const subs = new Set();
  return {
    get: () => current,
    set: (patch) => { current = { ...current, ...patch }; subs.forEach((fn) => fn(current)); },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
}
function harness({ ready = true, total = 10, index = 0, ahead = 3, siriVoice = false, ring = undefined } = {}) {
  const tts = createTtsClient({ maxInflight: 4 });
  const root = new El();
  const state = fakeState({ index, sentences: Array(total).fill({}), voice: V, speed: SP, siriVoice });
  const timers = [];
  const log = { probes: 0 };
  const health = async () => { log.probes++; return { tts_ready: typeof ready === 'function' ? ready() : ready }; };
  createBufferBar({ root, tts, health, ahead, state, voiceOf: (s) => s.voice, timer: (fn) => timers.push(fn), ring });
  const [track, label] = root.children;
  const [fill] = track?.children || [];
  return { tts, root, fill, label, state, timers, log };
}
{
  const b = harness();
  ok('   builds a track with a fill, and a label', b.fill && b.label);
  ok('   starts empty', b.fill.style.transform === 'scaleX(0)' && b.root.attrs['aria-valuenow'] === '0');
  ok('   max is the look-ahead', b.root.attrs['aria-valuemax'] === '3');
  b.tts.prefetch(entries(1, 2));
  await answerAll();
  ok('   two of three ready', b.root.attrs['aria-valuenow'] === '2' && /2 of 3/.test(b.root.attrs['aria-valuetext']));
  b.state.set({ index: 1 });
  ok('   the cursor moves (even paused, no audio event): one ahead is ready', b.root.attrs['aria-valuenow'] === '1');
  b.state.set({ speed: 1.5 });
  ok('   another speed: nothing ready for it', b.root.attrs['aria-valuenow'] === '0');
  b.state.set({ speed: SP, voice: 'bm_george' });
  ok('   another voice: nothing ready for it', b.root.attrs['aria-valuenow'] === '0');
  b.state.set({ voice: V });
  b.tts.clear();
  ok('   a voice change clears it', b.root.attrs['aria-valuenow'] === '0');
  const end = harness({ total: 3, index: 1 });
  ok('   near the end only what is left is wanted', end.root.attrs['aria-valuemax'] === '1');
  end.state.set({ sentences: Array(40).fill({}), index: 0 });
  ok('   a new document re-scales it at once', end.root.attrs['aria-valuemax'] === '3' && end.root.attrs['aria-valuenow'] === '0');
  await answerAll();
}

console.log('\n5. the model-loading state');
{
  let loaded = false;
  const b = harness({ ready: () => loaded });
  ok('   idle: no probe, no loading state', b.log.probes === 0 && !b.root.classList.contains('is-loading'));
  b.tts.prefetch(entries(1, 1));
  await flush();
  ok('   work in flight + model not ready: loading', b.root.classList.contains('is-loading') && b.label.textContent === LOADING_TEXT);
  ok('   indeterminate: no aria-valuenow', b.root.attrs['aria-valuenow'] === undefined);
  ok('   …and no inline fill width, so the stylesheet can sweep it', b.fill.style.transform === '');
  ok('   it polls again later', b.timers.length === 1);
  loaded = true;
  b.timers.shift()();
  await flush();
  ok('   model loaded: back to the meter', !b.root.classList.contains('is-loading') && b.label.textContent === '');
  b.tts.prefetch(entries(2, 2));
  await flush();
  ok('   once loaded, never probed again', b.log.probes === 2 && b.timers.length === 0);
  await answerAll();

  const c = harness({ ready: false });
  c.tts.prefetch(entries(1, 1));
  await flush();
  await answerAll();
  ok('   audio arriving ends the loading state, whatever health said', !c.root.classList.contains('is-loading'));
  const probes = c.log.probes;
  c.timers.splice(0).forEach((fn) => fn());
  c.tts.prefetch(entries(2, 2));
  await flush();
  ok('   …and stops the polling', c.log.probes === probes);
  await answerAll();

  const d = harness();
  d.tts.prefetch(entries(1, 1));
  await flush();
  ok('   model already loaded: never shows loading', !d.root.classList.contains('is-loading'));
  await answerAll();
}

console.log('\n5b. F2: the sentence being read is still loading (not only the first model load)');
{
  const b = harness({ index: 2 });
  b.tts.prefetch(entries(2, 2));
  await flush();
  ok('   model loaded, cursor sentence fetching: it sweeps', b.root.classList.contains('is-loading'));
  ok('   …and says it is preparing audio, not loading the model', b.label.textContent === FETCHING_TEXT);
  ok('   indeterminate: no aria-valuenow', b.root.attrs['aria-valuenow'] === undefined);
  await answerAll();
  ok('   the cursor sentence arrives: back to the meter', !b.root.classList.contains('is-loading') && b.label.textContent === '');
  b.tts.prefetch(entries(3, 4));
  await flush();
  ok('   cursor sentence ready, look-ahead fetching: the meter, not a sweep', !b.root.classList.contains('is-loading'));
  await answerAll();
  b.state.set({ index: 7 });
  ok('   cursor on an uncached sentence but nothing waiting: no sweep', !b.root.classList.contains('is-loading'));
  b.tts.prefetch(entries(8, 9));
  await flush();
  ok('   only the look-ahead fetching (a paused jump): the meter, not a sweep', !b.root.classList.contains('is-loading'));
  await answerAll();
  b.tts.prefetch(entries(7, 7));
  await flush();
  ok('   later sentence fetching: sweeps again', b.root.classList.contains('is-loading'));
  await answerAll();
}

console.log('\n5c. F2: a Siri voice never says "Loading voice model…" (health reports the Kokoro model only)');
{
  const b = harness({ ready: false, siriVoice: true });
  b.tts.prefetch(entries(0, 0));
  await flush();
  ok('   Siri, Kokoro model not loaded: sweeps as preparing audio', b.root.classList.contains('is-loading') && b.label.textContent === FETCHING_TEXT);
  ok('   …and never asks health', b.log.probes === 0);
  await answerAll();
  b.state.set({ siriVoice: false });
  b.tts.clear();   // as engineswitch does
  b.tts.prefetch(entries(0, 0));
  await flush();
  ok('   switching to Kokoro with its model unloaded: loading the model', b.label.textContent === LOADING_TEXT);
  await answerAll();
}

console.log('\n6. no markup, or health down');
{
  let threw = false;
  try { createBufferBar({ root: null, tts: createTtsClient(), health: async () => ({}), ahead: 3, state: fakeState({}), voiceOf: () => V }); } catch { threw = true; }
  ok('   no #bufferbar: a no-op', !threw);
  const tts = createTtsClient();
  const root = new El();
  createBufferBar({ root, tts, ahead: 3, health: async () => { throw new Error('down'); }, voiceOf: (s) => s.voice,
    state: fakeState({ index: 0, sentences: Array(9).fill({}), voice: V, speed: SP }), timer: () => {} });
  tts.prefetch(entries(1, 1));
  await flush();
  ok('   health unreachable: the plain meter, not a stuck loading state', !root.classList.contains('is-loading'));
  await answerAll();
}

console.log('\n7. no script, no meter (R4: it lives in the status field, which is always on screen)');
{
  const b = harness({ total: 0 });
  ok('   no sentences: hidden, rather than a full "all ready" line under "No document loaded"', b.root.hidden === true);
  b.state.set({ sentences: Array(5).fill({}) });
  ok('   a script arrives: shown', b.root.hidden === false);
  b.state.set({ sentences: [] });
  ok('   the script goes again: hidden again', b.root.hidden === true);
}

console.log('\n8. markup and styles');
{
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const html = read('static/index.html');
  const side = read('static/css/sidebar.css');
  const a11y = read('static/css/a11y.css');
  ok('   #bufferbar is a progressbar in the status field, right after #status-bar (R4)',
      /<div id="status-field">\s*<div id="status-bar"[^>]*>[^<]*<\/div>\s*(<!--[^>]*-->\s*)?<div id="bufferbar" role="progressbar"/.test(html));
  ok('   ... and not inside the live region, whose text setStatus rewrites',
      !/<div id="status-bar"[^>]*>[^<]*<div id="bufferbar"/.test(html));
  ok('   it is no longer under the transport', html.indexOf('id="bufferbar"') < html.indexOf('id="transport"'));
  ok('   colours come from the tokens: the solid accent (F2: was the pale ring)', /\.bufferbar-fill \{[^}]*background: var\(--accent\)/.test(side));
  ok('   F2: thick enough to see (4px)', /--buffer-h: 4px/.test(side));
  ok('   reduced motion stills the sweep',
      /prefers-reduced-motion: reduce\)[\s\S]*#bufferbar\.is-loading \.bufferbar-fill \{[^}]*animation: none/.test(a11y));
}

console.log('\n9. the rail\'s play button carries the same status as a ring (sidebar folded in)');
{
  let loaded = false;
  const ring = new El();
  const b = harness({ ready: () => loaded, ring });
  ok('   a script: the ring shows, empty', ring.classList.contains('has-ring') && ring.style['--ready'] === '0');
  b.tts.prefetch(entries(1, 1));
  await flush();
  ok('   model loading: the ring spins (is-loading), no fill', ring.classList.contains('is-loading') && ring.style['--ready'] === '0');
  loaded = true;
  b.timers.shift()();
  await flush();
  await answerAll();
  ok('   one of three ready: a third of the ring', !ring.classList.contains('is-loading')
    && Math.abs(Number(ring.style['--ready']) - 1 / 3) < 1e-9, ring.style['--ready']);
  b.tts.prefetch(entries(2, 3));
  await answerAll();
  ok('   all ready: full ring', ring.style['--ready'] === '1');
  b.state.set({ sentences: [] });
  ok('   no script: no ring', !ring.classList.contains('has-ring'));
  const fetchRing = new El();
  const fetching = harness({ ring: fetchRing });
  fetching.tts.get(0, 's0', V, SP);
  await flush();
  ok('   the sentence being read is loading: the ring spins too', fetchRing.classList.contains('is-loading'));
  await answerAll();
}
{
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const side = read('static/css/sidebar.css');
  const a11y = read('static/css/a11y.css');
  ok('   main.js hands it the rail\'s play button', /createBufferBar\(\{[^}]*ring: ui\.el\('railPpBtn'\)/.test(read('static/js/main.js')));
  ok('   the ring is a conic fill of --ready in the accent', /#railPpBtn\.has-ring::after \{[^}]*conic-gradient\(var\(--accent\) calc\(var\(--ready\) \* 1turn\)/.test(side));
  ok('   loading spins it', /#railPpBtn\.has-ring\.is-loading::after \{[^}]*animation: ring-spin/.test(side));
  ok('   reduced motion stills the spin',
      /prefers-reduced-motion: reduce\)[\s\S]*#railPpBtn\.has-ring\.is-loading::after \{[^}]*animation: none/.test(a11y));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

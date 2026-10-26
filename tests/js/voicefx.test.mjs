// V1 stage C (docs/18): Bass, Treble and Even-out, applied to the audio after it is generated.
// voicefx.js routes the player's <audio> elements through Web Audio (lowshelf → highshelf →
// compressor) only once a setting leaves neutral; until then the elements are never touched,
// so playback at neutral is exactly what it was before V1.
import {
  BASS_HZ, TREBLE_HZ, DB_MIN, DB_MAX, EVEN_MAX_RATIO, EVEN_MAX_THRESHOLD_DB,
  clampDb, clampEven, compressorFor, formatDb, formatEven, fxOf, isNeutralFx, createVoiceFx,
} from '../../static/js/voicefx.js';
import { createAudioNode } from '../../static/js/audionode.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

// ── fakes: a Web Audio context that records the graph, and <audio> elements ────
const param = (value) => ({ value });
class FakeNode {
  constructor(kind, extra = {}) { this.kind = kind; this.out = null; Object.assign(this, extra); }
  connect(node) { this.out = node; return node; }
}
class FakeContext {
  constructor() { this.state = 'suspended'; this.resumes = 0; this.sources = []; this.destination = new FakeNode('destination'); }
  resume() { this.resumes += 1; this.state = 'running'; return Promise.resolve(); }
  createBiquadFilter() { return new FakeNode('biquad', { type: 'lowpass', frequency: param(350), gain: param(0) }); }
  createDynamicsCompressor() {
    return new FakeNode('compressor', { threshold: param(-24), ratio: param(12), knee: param(30), attack: param(0.003), release: param(0.25) });
  }
  createMediaElementSource(el) {
    if (el.routed) throw new Error('InvalidStateError: already connected');   // as browsers do
    el.routed = true;
    const source = new FakeNode('source', { el });
    this.sources.push(source);
    return source;
  }
}
const contexts = [];
const createContext = () => { const c = new FakeContext(); contexts.push(c); return c; };
const element = () => {
  const on = new Map();
  return {
    isConnected: true, routed: false,
    addEventListener: (t, fn) => on.set(t, [...(on.get(t) || []), fn]),
    removeEventListener: () => {},
    fire: (t) => (on.get(t) || []).forEach((fn) => fn({ type: t })),
  };
};
const chainOf = (ctx) => {
  const kinds = [];
  for (let n = ctx.sources[0]; n; n = n.out) kinds.push(n.kind === 'biquad' ? n.type : n.kind);
  return kinds.join('→');
};

const NEUTRAL = { bass: 0, treble: 0, even: 0 };

console.log('\n1. settings: clamped, labelled, neutral is a no-op');
ok('   dB clamp ±12, junk → 0', clampDb(30) === DB_MAX && clampDb(-30) === DB_MIN && clampDb('x') === 0 && DB_MAX === 12);
ok('   even-out clamp 0–1, junk → 0', clampEven(2) === 1 && clampEven(-1) === 0 && clampEven(undefined) === 0);
ok('   labels', formatDb(3) === '+3 dB' && formatDb(-3) === '−3 dB' && formatDb(0) === '0 dB'
  && formatEven(0) === 'Off' && formatEven(0.5) === '50%', `${formatDb(-3)} ${formatEven(0)}`);
ok('   fxOf reads (and clamps) the state', JSON.stringify(fxOf({ fxBass: 40, fxTreble: -2, fxEven: 0.3 }))
  === JSON.stringify({ bass: 12, treble: -2, even: 0.3 }));
ok('   neutral is neutral', isNeutralFx(NEUTRAL) && !isNeutralFx({ ...NEUTRAL, even: 0.1 }) && !isNeutralFx({ ...NEUTRAL, treble: -1 }));
ok('   even-out 0 does not compress (ratio 1)', compressorFor(0).ratio === 1);
const steps = Array.from({ length: 11 }, (_, i) => compressorFor(i / 10).ratio);
ok('   every slider step compresses (ratio ≥ 1, never an expander) and rises', steps.every((r, i) => r >= 1 && (i === 0 || r > steps[i - 1])),
  steps.join());
ok('   even-out 1 is the strongest setting', compressorFor(1).ratio === EVEN_MAX_RATIO
  && compressorFor(1).threshold === EVEN_MAX_THRESHOLD_DB && compressorFor(0.5).ratio > 1 && compressorFor(0.5).ratio < EVEN_MAX_RATIO);

console.log('\n2. neutral: the elements are never routed, no AudioContext exists');
const fx = createVoiceFx({ createContext });
const [a, b] = [element(), element()];
fx.track(a);
fx.track(b);
fx.apply(NEUTRAL);
ok('   no context, nothing routed', contexts.length === 0 && !a.routed && !b.routed && fx.state().routed === 0);

console.log('\n3. leaving neutral builds the chain once and routes every live element');
fx.apply({ bass: 6, treble: -3, even: 0.5 });
const ctx = contexts[0];
ok('   one context', contexts.length === 1);
ok('   both elements routed', a.routed && b.routed && fx.state().routed === 2);
ok('   source → lowshelf → highshelf → compressor → speakers', chainOf(ctx) === 'source→lowshelf→highshelf→compressor→destination', chainOf(ctx));
const [low, high, comp] = [ctx.sources[0].out, ctx.sources[0].out.out, ctx.sources[0].out.out.out];
ok('   bass/treble set at their corner frequencies', low.gain.value === 6 && low.frequency.value === BASS_HZ
  && high.gain.value === -3 && high.frequency.value === TREBLE_HZ);
ok('   compressor set from even-out', comp.ratio.value === compressorFor(0.5).ratio && comp.threshold.value === compressorFor(0.5).threshold);
ok('   ... and the context is woken', ctx.resumes === 1 && fx.state().context === 'running');

console.log('\n4. later changes only move the knobs');
fx.apply({ bass: -4, treble: 2, even: 0 });
ok('   same context, same sources', contexts.length === 1 && ctx.sources.length === 2);
ok('   new values', low.gain.value === -4 && high.gain.value === 2 && comp.ratio.value === 1);
fx.apply(NEUTRAL);
ok('   back to neutral: routed elements stay routed (Web Audio cannot undo it), flat',
  low.gain.value === 0 && high.gain.value === 0 && comp.ratio.value === 1 && fx.state().routed === 2);

console.log('\n5. elements made after the chain (recovery rebuilds) join it; none is routed twice');
const c = element();
fx.track(c);
ok('   a new element is routed at once', c.routed && ctx.sources.length === 3);
let threw = false;
try { fx.track(c); fx.track(a); } catch { threw = true; }
ok('   tracking a routed element again is a no-op', !threw && ctx.sources.length === 3);

console.log('\n6. a context the system suspended is woken when audio plays');
ctx.state = 'suspended';
a.fire('play');
await flush();
ok('   play on a routed element resumes it', ctx.state === 'running' && ctx.resumes === 2, `${ctx.resumes}`);
a.fire('play');
ok('   ... and leaves a running one alone', ctx.resumes === 2);

console.log('\n7. a discarded element is never routed');
const fx2 = createVoiceFx({ createContext });
const gone = element();
const live = element();
fx2.track(gone);
fx2.track(live);
gone.isConnected = false;    // audionode.rebuild() removed it
fx2.apply({ ...NEUTRAL, bass: 3 });
ok('   only the live one', !gone.routed && live.routed && fx2.state().routed === 1);

console.log('\n8. no Web Audio: settings do nothing, playback untouched');
const fx3 = createVoiceFx({ createContext: () => { throw new Error('no AudioContext'); } });
const plain = element();
fx3.track(plain);
let threw3 = false;
try { fx3.apply({ ...NEUTRAL, bass: 6 }); } catch { threw3 = true; }
ok('   no throw, nothing routed, reported unavailable', !threw3 && !plain.routed && fx3.state().context === 'unavailable');

console.log('\n9. audionode reports every element it makes (so voicefx can route rebuilt ones)');
const made = [];
globalThis.document = {
  createElement: () => ({ ...element(), setAttribute() {}, style: {}, pause() {}, remove() {}, removeAttribute() {} }),
  body: { appendChild() {} },
};
const node = createAudioNode(() => {}, (el) => made.push(el));
ok('   both of the pair', made.length === 2);
const fresh = node.rebuild();
ok('   and the rebuilt one', made.length === 3 && made[2] === fresh);
createAudioNode(() => {});
ok('   the hook is optional', true);

console.log('\n10. state.js persists the three, clamped; old prefs load as neutral');
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
const state = await import('../../static/js/state.js');
ok('   defaults are neutral', isNeutralFx(fxOf(state.get())));
state.set({ fxBass: 4, fxTreble: -2, fxEven: 0.6 });
state.savePrefs();
state.set({ fxBass: 0, fxTreble: 0, fxEven: 0 });
state.loadPrefs();
ok('   saved and restored', state.get().fxBass === 4 && state.get().fxTreble === -2 && state.get().fxEven === 0.6);
store.set('kokoro.prefs.v2', JSON.stringify({ fxBass: 99, fxTreble: -99, fxEven: 5 }));
state.loadPrefs();
ok('   out-of-range prefs are clamped', state.get().fxBass === DB_MAX && state.get().fxTreble === DB_MIN && state.get().fxEven === 1);
store.set('kokoro.prefs.v2', JSON.stringify({ voice: 'af_aoede' }));
state.loadPrefs();
ok('   prefs written before V1 load as neutral', isNeutralFx(fxOf(state.get())));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

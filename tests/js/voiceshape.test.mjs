// V1 stage B (docs/18): the Pitch and Expressiveness sliders. voiceshape.js clamps them and
// turns them into the /api/tts query; ttsclient sends that query and keys its cache by it, so
// audio still in flight in the old shape can never be played after the slider moves.
import { createTtsClient } from '../../static/js/ttsclient.js';
import {
  PITCH_MIN, PITCH_MAX, EXPR_MIN, EXPR_MAX, clampPitch, clampExpr, shapeParams, formatPitch, formatExpr,
} from '../../static/js/voiceshape.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

// ── fakes: a fetch the test answers by hand, blob urls, localStorage ──────────
const pending = [];
globalThis.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
  const q = new URL(`http://x${url}`).searchParams;
  opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  pending.push({ q, answer: () => resolve({ ok: true, status: 200, blob: async () => ({ text: q.toString() }) }) });
});
globalThis.URL.createObjectURL = (b) => `blob:${b.text}`;
globalThis.URL.revokeObjectURL = () => {};
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };

console.log('\n1. voiceshape.js: clamps to the server\'s measured range, neutral sends nothing');
ok('   ranges match the server (0.85–1.15, 0.5–1.5)',
  PITCH_MIN === 0.85 && PITCH_MAX === 1.15 && EXPR_MIN === 0.5 && EXPR_MAX === 1.5);
ok('   clampPitch / clampExpr bound the value', clampPitch(3) === PITCH_MAX && clampPitch(0) === PITCH_MIN
  && clampExpr(9) === EXPR_MAX && clampExpr(-1) === EXPR_MIN && clampPitch(1.05) === 1.05);
ok('   junk falls back to neutral', clampPitch('x') === 1 && clampExpr(undefined) === 1);
ok('   neutral → no query params (old cache stays a hit)',
  JSON.stringify(shapeParams({ voicePitch: 1, voiceExpr: 1, siriVoice: false })) === '{}');
ok('   a shape → pitch and expr', JSON.stringify(shapeParams({ voicePitch: 1.1, voiceExpr: 1, siriVoice: false }))
  === '{"pitch":"1.1","expr":"1"}');
ok('   expressiveness alone is a shape too', JSON.stringify(shapeParams({ voicePitch: 1, voiceExpr: 1.3, siriVoice: false }))
  === '{"pitch":"1","expr":"1.3"}');
ok('   Siri → nothing (the server cannot shape it)',
  JSON.stringify(shapeParams({ voicePitch: 1.1, voiceExpr: 1.3, siriVoice: true })) === '{}');
ok('   labels: pitch as a signed percent, expressiveness as a percent',
  formatPitch(1.1) === '+10%' && formatPitch(0.85) === '−15%' && formatPitch(1) === '0%' && formatExpr(1.5) === '150%',
  `${formatPitch(1.1)} ${formatPitch(0.85)} ${formatPitch(1)} ${formatExpr(1.5)}`);

console.log('\n2. ttsclient sends the shape and keys its cache by it');
let shape = {};
const tts = createTtsClient({ maxInflight: 4, shapeOf: () => shape });
const first = tts.get(0, 'One.', 'af_aoede', 1);
await flush();
ok('   neutral: no pitch/expr in the URL', pending[0] && !pending[0].q.has('pitch') && !pending[0].q.has('expr'));
pending.splice(0).forEach((p) => p.answer());
await first;
await flush();
ok('   ... and it is cached', tts.isCached(0, 'af_aoede', 1));

shape = { pitch: '1.1', expr: '1.3' };
ok('   a new shape misses the neutral audio', !tts.isCached(0, 'af_aoede', 1));
const second = tts.get(0, 'One.', 'af_aoede', 1);
await flush();
ok('   the request carries pitch and expr', pending[0]?.q.get('pitch') === '1.1' && pending[0]?.q.get('expr') === '1.3',
  pending[0]?.q.toString());
ok('   it is pending under the new shape', tts.isPending(0, 'af_aoede', 1));

shape = { pitch: '0.9', expr: '1' };   // the slider moves while that render is in flight
pending.splice(0).forEach((p) => p.answer());
await second;
await flush();
ok('   audio rendered in the old shape is not served for the new one', !tts.isCached(0, 'af_aoede', 1));
shape = { pitch: '1.1', expr: '1.3' };
ok('   ... it is kept under its own shape', tts.isCached(0, 'af_aoede', 1));

console.log('\n3. state.js persists both, clamped; old prefs load as neutral');
const state = await import('../../static/js/state.js');
ok('   defaults are neutral', state.get().voicePitch === 1 && state.get().voiceExpr === 1);
state.set({ voicePitch: 1.1, voiceExpr: 0.7 });
state.savePrefs();
const saved = JSON.parse(store.get('kokoro.prefs.v2'));
ok('   saved', saved.voicePitch === 1.1 && saved.voiceExpr === 0.7, JSON.stringify(saved));
state.set({ voicePitch: 1, voiceExpr: 1 });
state.loadPrefs();
ok('   restored', state.get().voicePitch === 1.1 && state.get().voiceExpr === 0.7);
store.set('kokoro.prefs.v2', JSON.stringify({ voice: 'af_aoede', voicePitch: 7, voiceExpr: -2 }));
state.loadPrefs();
ok('   out-of-range prefs are clamped', state.get().voicePitch === PITCH_MAX && state.get().voiceExpr === EXPR_MIN);
store.set('kokoro.prefs.v2', JSON.stringify({ voice: 'af_aoede', speed: 1 }));
state.loadPrefs();
ok('   prefs written before V1 load as neutral', state.get().voicePitch === 1 && state.get().voiceExpr === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

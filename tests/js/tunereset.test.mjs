// "Personalise voice" Reset: every slider back to neutral, saved, shown, and the cached audio
// dropped only when a rendered knob (pitch, expressiveness) actually changes.
import { createSettings } from '../../static/js/settings.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

const TUNE_IDS = ['pitchSlider', 'pitchVal', 'exprSlider', 'exprVal', 'bassSlider', 'bassVal',
  'trebleSlider', 'trebleVal', 'evenSlider', 'evenVal'];

function harness(initial) {
  let current = { ...initial };
  const log = { saves: 0, clears: 0, fx: 0 };
  const nodes = Object.fromEntries(TUNE_IDS.map((id) => [id, { value: '', textContent: '', addEventListener() {} }]));
  const handlers = {};
  nodes.tuneResetBtn = { addEventListener: (type, fn) => { handlers[type] = fn; } };
  const state = { get: () => current, set: (p) => { current = { ...current, ...p }; }, savePrefs: () => { log.saves++; } };
  const ui = { el: (id) => nodes[id] ?? null, toast() {} };
  const settings = createSettings({ api: {}, state, ui, clearAudio: () => { log.clears++; }, applyFx: () => { log.fx++; } });
  settings.bindTuneReset();
  return { state, nodes, log, click: () => handlers.click() };
}

console.log('\n1. Reset puts every knob back to neutral');
{
  const h = harness({ voicePitch: 0.85, voiceExpr: 1.5, fxBass: 6, fxTreble: -3, fxEven: 0.5 });
  h.click();
  const s = h.state.get();
  ok('   state is neutral', s.voicePitch === 1 && s.voiceExpr === 1 && s.fxBass === 0 && s.fxTreble === 0 && s.fxEven === 0,
    JSON.stringify(s));
  ok('   sliders show it', h.nodes.pitchSlider.value === '1' && h.nodes.bassSlider.value === '0' && h.nodes.evenSlider.value === '0');
  ok('   labels show it', h.nodes.pitchVal.textContent === '0%' && h.nodes.exprVal.textContent === '100%'
    && h.nodes.bassVal.textContent === '0 dB', `${h.nodes.pitchVal.textContent} ${h.nodes.exprVal.textContent}`);
  ok('   saved once, live effects re-applied', h.log.saves === 1 && h.log.fx === 1, JSON.stringify(h.log));
  ok('   a rendered knob changed → cached audio dropped', h.log.clears === 1);
}

console.log('\n2. Only live effects changed: the audio is kept');
{
  const h = harness({ voicePitch: 1, voiceExpr: 1, fxBass: 6, fxTreble: 0, fxEven: 0 });
  h.click();
  ok('   no audio drop', h.log.clears === 0 && h.state.get().fxBass === 0, JSON.stringify(h.log));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

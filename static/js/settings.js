// ── Settings panel ───────────────────────────────────────────────────────────
// Voice (Siri among them), speed and the read options: restores the saved choices
// into the controls, saves each change, and asks the server which voices and which
// local model it has. Changing what is spoken drops the cached audio (`clearAudio`).

import { formatSpeed } from './layout.js';
import { initEngineSwitch, reflectEngine } from './engineswitch.js';
import { initThemeSwitch } from './themeswitch.js';
import { clampPitch, clampExpr, formatPitch, formatExpr } from './voiceshape.js';
import { clampDb, clampEven, formatDb, formatEven } from './voicefx.js';

/**
 * V1: the "Personalise voice" sliders — state field, clamp, label. Pitch and Expressiveness are
 * rendered by Kokoro (a change drops cached audio); `isLive` ones are effects applied to the
 * audio as it plays (voicefx.js), so they change what is heard while dragging. `neutral` is
 * what Reset restores.
 */
const TUNE_SLIDERS = [
  { id: 'pitchSlider', label: 'pitchVal', field: 'voicePitch', clamp: clampPitch, format: formatPitch, neutral: 1 },
  { id: 'exprSlider', label: 'exprVal', field: 'voiceExpr', clamp: clampExpr, format: formatExpr, neutral: 1 },
  { id: 'bassSlider', label: 'bassVal', field: 'fxBass', clamp: clampDb, format: formatDb, neutral: 0, isLive: true },
  { id: 'trebleSlider', label: 'trebleVal', field: 'fxTreble', clamp: clampDb, format: formatDb, neutral: 0, isLive: true },
  { id: 'evenSlider', label: 'evenVal', field: 'fxEven', clamp: clampEven, format: formatEven, neutral: 0, isLive: true },
];
const NEUTRAL_TUNE = Object.fromEntries(TUNE_SLIDERS.map((t) => [t.field, t.neutral]));

const ACCENTS = { a: 'US', b: 'UK', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Chinese' };
const GENDERS = { f: 'Female', m: 'Male' };

function describeVoice(id) {
  const accent = ACCENTS[id[0]] || '';
  const gender = GENDERS[id[1]] || '';
  return [gender, accent].filter(Boolean).join(' · ') || 'voice';
}

/** @param {{ api: object, state: object, ui: object, clearAudio: () => void, applyFx?: () => void }} deps */
export function createSettings({ api, state, ui, clearAudio, applyFx = () => {} }) {
  /** Put the saved preferences into the controls and save read-option edits. */
  function applyPrefs() {
    const s = state.get();
    reflectEngine(ui.el('voiceSelect'), s);
    ui.el('speedSlider').value = String(s.speed);
    ui.setSpeedLabel(formatSpeed(s.speed));
    reflectTune(s);
    applyFx();
    ui.bindOptions(s.options, (patch) => {
      state.set({ options: { ...state.get().options, ...patch } });
      state.savePrefs();
      const btn = ui.el('rebuildBtn');
      if (btn && state.get().docId) btn.disabled = false;
    });
  }

  /** Show `s`'s "Personalise voice" values in its sliders and labels. */
  function reflectTune(s) {
    for (const t of TUNE_SLIDERS) {
      const slider = ui.el(t.id);
      if (slider) slider.value = String(s[t.field]);
      const label = ui.el(t.label);
      if (label) label.textContent = t.format(s[t.field]);
    }
  }

  /** Reset: every slider back to neutral; cached audio is dropped only if a rendered knob moved. */
  function bindTuneReset() {
    const btn = ui.el('tuneResetBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const before = state.get();
      const isReshaped = TUNE_SLIDERS.some((t) => !t.isLive && before[t.field] !== t.neutral);
      state.set(NEUTRAL_TUNE);
      state.savePrefs();
      reflectTune(state.get());
      applyFx();
      if (isReshaped) clearAudio();
    });
  }

  function bind() {
    initEngineSwitch({ state, ui, onSwitch: clearAudio });
    initThemeSwitch({ state, ui });

    const slider = ui.el('speedSlider');
    slider.addEventListener('input', (e) => {
      const speed = state.clampSpeed(e.target.value);
      state.set({ speed });
      ui.setSpeedLabel(formatSpeed(speed));
    });
    slider.addEventListener('change', () => {
      state.savePrefs();
      clearAudio();
    });
    TUNE_SLIDERS.forEach(bindTune);
    bindTuneReset();
  }

  /** Like speed: the label (and a live effect) follows the drag; letting go saves, and drops
   *  audio rendered in the old shape. */
  function bindTune({ id, label, field, clamp, format, isLive = false }) {
    const slider = ui.el(id);
    if (!slider) return;
    slider.addEventListener('input', (e) => {
      const value = clamp(e.target.value);
      state.set({ [field]: value });
      const node = ui.el(label);
      if (node) node.textContent = format(value);
      if (isLive) applyFx();
    });
    slider.addEventListener('change', () => {
      state.savePrefs();
      if (!isLive) clearAudio();
    });
  }

  async function probeLlm() {
    try {
      const h = await api.health();
      state.set({ llmAvailable: Boolean(h.llm_available), llmModel: h.llm_model || '' });
      ui.setLlmAvailability({ available: h.llm_available, model: h.llm_model });
    } catch {
      ui.setLlmAvailability({ available: false, model: '' });
    }
  }

  /**
   * The bundled Kokoro weights ship more voices than the markup lists, so ask the
   * server rather than hardcoding. The static <option>s stay as the fallback.
   */
  async function loadVoices() {
    try {
      const { voices } = await api.voices();
      if (!Array.isArray(voices) || voices.length < 2) return;
      const select = ui.el('voiceSelect');
      const wanted = state.get().voice;
      const labels = new Map([...select.options].map((o) => [o.value, o.textContent]));
      select.replaceChildren(...voices.map((v) => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = labels.get(v) || `${v} — ${describeVoice(v)}`;
        return opt;
      }));
      select.value = voices.includes(wanted) ? wanted : voices[0];
      state.set({ voice: select.value });
      reflectEngine(select, state.get());   // N2: the rebuilt list lost the Siri option (R5)
    } catch (err) {
      console.warn('could not list voices; using the built-in list', err);
    }
  }

  return { applyPrefs, bind, bindTuneReset, probeLlm, loadVoices };
}

// ── Settings panel ───────────────────────────────────────────────────────────
// Voice (Siri among them), speed and the read options: restores the saved choices
// into the controls, saves each change, and asks the server which voices and which
// local model it has. Changing what is spoken drops the cached audio (`clearAudio`).

import { formatSpeed } from './layout.js';
import { initEngineSwitch, reflectEngine } from './engineswitch.js';

const ACCENTS = { a: 'US', b: 'UK', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Chinese' };
const GENDERS = { f: 'Female', m: 'Male' };

function describeVoice(id) {
  const accent = ACCENTS[id[0]] || '';
  const gender = GENDERS[id[1]] || '';
  return [gender, accent].filter(Boolean).join(' · ') || 'voice';
}

/** @param {{ api: object, state: object, ui: object, clearAudio: () => void }} deps */
export function createSettings({ api, state, ui, clearAudio }) {
  /** Put the saved preferences into the controls and save read-option edits. */
  function applyPrefs() {
    const s = state.get();
    reflectEngine(ui.el('voiceSelect'), s);
    ui.el('speedSlider').value = String(s.speed);
    ui.setSpeedLabel(formatSpeed(s.speed));
    ui.bindOptions(s.options, (patch) => {
      state.set({ options: { ...state.get().options, ...patch } });
      state.savePrefs();
      const btn = ui.el('rebuildBtn');
      if (btn && state.get().docId) btn.disabled = false;
    });
  }

  function bind() {
    initEngineSwitch({ state, ui, onSwitch: clearAudio });

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

  return { applyPrefs, bind, probeLlm, loadVoices };
}

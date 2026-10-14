// ── ETA readout (N11) ────────────────────────────────────────────────────────
// "≈3 min left on page · 1 h 12 m in paper" beside the page pill. It redraws when the
// cursor, the script, the voice, the speed or the learnt rate change, and is hidden with
// no paper open. Not a live region: a screen reader would announce it every sentence.
// The rate learns from playback.js listen events, handed in through `listen`.

import { createEtaTracker, currentEta, etaText } from './eta.js';

/**
 * @param {{ root: HTMLElement|null, state: object }} deps  #eta-pill and state.js
 * @returns {{ listen: (ev: object) => void }}
 */
export function createEtaStatus({ root, state }) {
  const tracker = createEtaTracker({
    getSpeed: () => state.get().speed,
    getRates: () => state.get().etaRates,
    setRates: (etaRates) => { state.set({ etaRates }); state.savePrefs(); },
  });
  if (!root) return tracker;

  let inputs = [];
  function render(s) {
    const next = [s.docId, s.sentences, s.index, s.etaRates, s.voice, s.siriVoice, s.speed];
    if (next.every((v, i) => v === inputs[i])) return;   // state changes far more often than these
    inputs = next;
    const view = currentEta(s);
    root.hidden = !view;
    root.textContent = view ? etaText(view) : '';
  }

  state.subscribe(render);
  render(state.get());
  return tracker;
}

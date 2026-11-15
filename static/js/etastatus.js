// ── ETA readout (N11) ────────────────────────────────────────────────────────
// "≈3 min left on page · 1 h 12 m in paper" beside the page pill. The pill opens a dropdown
// (etamenu.js) to pick what it counts down to (page, section, chapter, whole paper) and to
// add the learnt rate in wpm and the TTS time this session. It redraws when the cursor, the
// script, the contents, the voice, the speed or the learnt rate change, and is hidden with
// no paper open. Not a live region: a screen reader would announce it every sentence.
// The rate learns from playback.js listen events, handed in through `listen`.

import { ttsVoice } from './engineswitch.js';
import { createEtaTracker, secondsPerChar, scopeSeconds, scopeText, wordsPerChar, statsText } from './eta.js';
import { createEtaMenu } from './etamenu.js';

/**
 * @param {{ root: HTMLElement|null, menu?: HTMLElement|null, state: object,
 *           getComputeMs?: () => number }} deps  #eta-pill, #eta-menu, state.js, TTS fetch ms
 * @returns {{ listen: (ev: object) => void }}
 */
export function createEtaStatus({ root, menu = null, state, getComputeMs = () => 0 }) {
  const tracker = createEtaTracker({
    getSpeed: () => state.get().speed,
    getRates: () => state.get().etaRates,
    setRates: (etaRates) => { state.set({ etaRates }); state.savePrefs(); },
  });
  if (!root) return tracker;

  let inputs = [];
  let left = null;
  let wpc = { sentences: null, value: 0 };   // once per paper, not per sentence
  const save = (patch) => { state.set(patch); state.savePrefs(); };
  const dropdown = menu ? createEtaMenu({
    pill: root,
    menu,
    getLeft: () => left,
    getState: () => state.get(),
    onScope: (etaScope) => save({ etaScope }),
    onStats: (etaStats) => save({ etaStats }),
  }) : null;

  function render(s) {
    const next = [s.docId, s.sentences, s.index, s.etaRates, s.voice, s.siriVoice, s.speed,
      s.tocEntries, s.etaScope, s.etaStats];
    if (next.every((v, i) => v === inputs[i])) return;   // state changes far more often than these
    inputs = next;
    const perChar = secondsPerChar(s.etaRates, ttsVoice(s), s.speed);
    left = s.docId ? scopeSeconds({ sentences: s.sentences, index: s.index, entries: s.tocEntries, perChar }) : null;
    root.hidden = !left;
    dropdown?.[left ? 'refresh' : 'close']();
    if (!left) { root.textContent = ''; return; }
    const text = scopeText(left, s.etaScope);
    if (!s.etaStats) { root.textContent = text; return; }
    if (wpc.sentences !== s.sentences) wpc = { sentences: s.sentences, value: wordsPerChar(s.sentences) };
    root.textContent = `${text} · ${statsText({ wordsPerChar: wpc.value, perChar, computeMs: getComputeMs() })}`;
  }

  state.subscribe(render);
  render(state.get());
  return tracker;
}

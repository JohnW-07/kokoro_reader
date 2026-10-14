// ── Engine switch ────────────────────────────────────────────────────────────
// R5: the Siri voice (kokoro_reader/apple_engine.py) is an option of the voice dropdown, in
// its own macOS group. Picking it flips synthesis live without touching the remembered
// Kokoro voice: only what is sent as `voice` changes. Siri is macOS-only and reachable
// through a door Apple can close, so the Kokoro choice is kept for the way back.

export const SIRI_VOICE = 'siri_nora';
export const SIRI_LABEL = 'Siri · Nora (macOS)';
export const SIRI_GROUP_LABEL = 'macOS';
export const SIRI_GONE_MESSAGE =
  'The Siri voice is not available on this Mac (a macOS update may have removed it) — reading with Kokoro instead.';

/** The voice to request: Siri while it is picked, else the chosen Kokoro voice. */
export function ttsVoice(s) {
  return s.siriVoice ? SIRI_VOICE : s.voice;
}

/** Append the Siri option in its own group, once (a rebuilt list drops it). */
function addSiriOption(select) {
  if ([...select.options].some((o) => o.value === SIRI_VOICE)) return;
  const group = document.createElement('optgroup');
  group.label = SIRI_GROUP_LABEL;
  const opt = document.createElement('option');
  opt.value = SIRI_VOICE;
  opt.textContent = SIRI_LABEL;
  group.appendChild(opt);
  select.appendChild(group);
}

/**
 * N2: make the voice dropdown say which engine speaks: Siri while `siriVoice` is on (the
 * old switch's pref carries over), else the saved Kokoro voice. Display only: `s.voice` is
 * never written. Safe to repeat (after `loadVoices()`).
 * @param {HTMLSelectElement|null} select
 * @param {{ voice: string, siriVoice?: boolean }} s
 */
export function reflectEngine(select, s) {
  if (!select) return;
  addSiriOption(select);
  select.value = s.siriVoice === true ? SIRI_VOICE : s.voice;
}

function changeToast(wasSiri, isSiri) {
  if (isSiri && !wasSiri) return 'Siri voice on — cached audio cleared.';
  if (wasSiri && !isSiri) return 'Kokoro voice on — cached audio cleared.';
  return 'Voice changed — cached audio cleared.';
}

/**
 * Bind the voice dropdown. Siri sets `siriVoice`; a Kokoro voice clears it and becomes
 * `voice`. `onSwitch` runs after every change; the caller drops cached audio there.
 * @param {{ state: object, ui: object, onSwitch: () => void }} deps
 */
export function initEngineSwitch({ state, ui, onSwitch }) {
  const select = ui.el('voiceSelect');
  if (!select) return;
  reflectEngine(select, state.get());
  select.addEventListener('change', () => {
    const wasSiri = state.get().siriVoice === true;
    const isSiri = select.value === SIRI_VOICE;
    state.set(isSiri ? { siriVoice: true } : { siriVoice: false, voice: select.value });
    state.savePrefs();
    onSwitch();
    ui.toast(changeToast(wasSiri, isSiri));
  });
}

/**
 * R6: the server says the Siri voice is gone. Pick the Kokoro voice again and save that, so
 * every request after this one goes to it, and say why. No-op when Siri is not picked.
 * @param {{ state: object, ui: object, onSwitch: () => void }} deps
 */
export function fallBackToKokoro({ state, ui, onSwitch }) {
  if (state.get().siriVoice !== true) return;
  state.set({ siriVoice: false });
  state.savePrefs();
  reflectEngine(ui.el('voiceSelect'), state.get());
  onSwitch();
  ui.toast(SIRI_GONE_MESSAGE, 'warn');
}

// ── Theme switch ─────────────────────────────────────────────────────────────
// The Settings "Appearance" select (docs/19). It shows the saved theme, and a change is
// saved with the other prefs and drawn at once by themeboot.js's `kokoroTheme.apply`.

const FALLBACK = 'light';

/**
 * @param {{ state: object, ui: object, theme?: { apply: (pref: string) => void } }} deps
 *   `theme` is themeboot.js's global; absent (as in the Node harness), nothing is drawn.
 */
export function initThemeSwitch({ state, ui, theme = globalThis.kokoroTheme }) {
  const select = ui.el('themeSelect');
  if (!select) return;
  select.value = state.get().theme;
  if (select.value !== state.get().theme) select.value = FALLBACK;   // an id this build does not know
  select.addEventListener('change', () => {
    state.set({ theme: select.value });
    state.savePrefs();
    theme?.apply(select.value);
  });
}

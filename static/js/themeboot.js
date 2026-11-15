// ── Theme boot (docs/19) ─────────────────────────────────────────────────────
// A classic, blocking <script> in <head> (index.html and stats.html), not a module:
// modules run after the first paint, which would flash Light under a dark theme.
// It reads the theme from the saved prefs (state.js owns that key), resolves
// "system" against prefers-color-scheme, and sets <html data-theme>. It re-applies
// when the system appearance changes, and when another window (the stats page,
// the reader) saves a new choice. themeswitch.js (Settings) calls `kokoroTheme.apply` on a change.
(function () {
  const PREF_KEY = 'kokoro.prefs.v2';
  /** Every theme themes.css styles; 'light' is app.css's :root. */
  const THEMES = ['light', 'dark', 'dark-warm', 'sepia'];
  const SYSTEM = 'system';
  const DEFAULT = 'light';
  const SYSTEM_DARK = 'dark';
  const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

  function saved() {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY) || '{}').theme;
    } catch {
      return undefined;   // unreadable storage must never block the page
    }
  }

  /** The theme to draw: a known theme as-is, "system" by appearance, anything else Light. */
  function resolve(pref, isSystemDark) {
    if (pref === SYSTEM) return isSystemDark ? SYSTEM_DARK : DEFAULT;
    return THEMES.includes(pref) ? pref : DEFAULT;
  }

  function apply(pref = saved()) {
    document.documentElement.dataset.theme = resolve(pref, Boolean(darkQuery && darkQuery.matches));
  }

  apply();
  if (darkQuery) darkQuery.addEventListener('change', () => apply());
  addEventListener('storage', (e) => { if (e.key === PREF_KEY) apply(); });
  globalThis.kokoroTheme = { THEMES, SYSTEM, DEFAULT, resolve, apply };
})();

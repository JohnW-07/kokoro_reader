// ── Follow switch ────────────────────────────────────────────────────────────
// Whether the view scrolls along with the voice at all, and whether those scrolls glide
// (N12). Both are saved preferences that follow.js reads at each scroll. The switch has a
// twin on the rail; F (or S) presses it, and each press is announced in the toast (an alert).
// R1: it also does Snap's old job. Switching it on scrolls to the sentence being read at once,
// and while the reader's scroll holds it off (the switch is lit) a press resumes following.

export const FOLLOW_SHORTCUT = 'KeyF';
const SWITCH_IDS = ['followBtn', 'railFollowBtn'];

/** @param {{ state: object, ui: object, follower: { toggled: () => void, snap: () => void, isActive: () => boolean } }} deps */
export function createFollowSwitch({ state, ui, follower }) {
  function reflect() {
    const on = String(state.get().followEnabled);
    SWITCH_IDS.forEach((id) => ui.el(id)?.setAttribute('aria-checked', on));
  }

  function toggle() {
    if (state.get().followEnabled && !follower.isActive()) {
      follower.snap();
      ui.toast('Following the voice again.');
      return;
    }
    const on = !state.get().followEnabled;
    state.set({ followEnabled: on });
    state.savePrefs();
    reflect();
    if (on) follower.snap();
    else follower.toggled();
    ui.toast(on ? 'Following the voice — the page scrolls along.' : 'Not following — the page stays where you put it.');
  }

  ui.el('followBtn')?.addEventListener('click', toggle);   // the rail twin forwards here (bindRail)
  const smooth = ui.el('smoothScrollBox');
  if (smooth) {
    smooth.checked = state.get().smoothScroll;
    smooth.addEventListener('change', () => {
      state.set({ smoothScroll: smooth.checked });
      state.savePrefs();
    });
  }
  reflect();

  return { toggle };
}

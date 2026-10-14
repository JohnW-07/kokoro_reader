// ── Transport ────────────────────────────────────────────────────────────────
// Play, pause, step, jump and "read from here", plus the buttons and keyboard
// shortcuts that drive them. Every move the reader makes resumes following.

import { resolveReadFrom } from './readfrom.js';
import { isTypingTarget, NOTES_SHORTCUT, SIDEBAR_SHORTCUT } from './layout.js';
import { ownsSpace } from './transportrules.js';
import { FOLLOW_SHORTCUT } from './followswitch.js';

/**
 * @param {{ player: object, follower: object, state: object, ui: object,
 *   onRebuild: () => void, toggleSidebar: () => void, toggleNotes: () => void,
 *   toggleFollow: () => void, hasActiveHighlight: () => boolean }} deps
 */
export function createTransport({
  player, follower, state, ui, onRebuild, toggleSidebar, toggleNotes, toggleFollow, hasActiveHighlight,
}) {
  function jumpTo(idx) {
    player.play(idx);
    follower.resume();   // a jump is the reader choosing where to be: follow from there
  }

  /** Play or pause; starting to play resumes following, pausing leaves the view alone. */
  function togglePlay() {
    const starting = !player.state().isRunning;   // a pause mid-load is not a start
    player.toggle();
    if (starting) follower.resume();
  }

  const step = (move) => () => { move(); follower.resume(); };

  /** N6: the hardware media keys (mediakeys.js). Play and pause are explicit, never a toggle. */
  const mediaActions = {
    play: () => { player.resume(); follower.resume(); },
    pause: () => player.pause(),
    nexttrack: step(() => player.next()),
    previoustrack: step(() => player.prev()),
  };

  /** "Read from here": start at the sentence a click on the PDF resolves to. */
  function readFrom(target) {
    const s = state.get();
    if (s.loading || !s.sentences.length) {
      ui.toast('The script is still being built — try again once it is ready.', 'warn');
      return;
    }
    const { index } = resolveReadFrom(s.sentences, target);
    if (index < 0) {
      ui.toast('Nothing is read aloud after this point.', 'warn');
      return;
    }
    jumpTo(index);
  }

  function bindButtons() {
    ui.el('prevBtn').addEventListener('click', step(() => player.prev()));
    ui.el('nextBtn').addEventListener('click', step(() => player.next()));
    ui.el('ppBtn').addEventListener('click', togglePlay);
    ui.el('recoverBtn').addEventListener('click', () => player.recover());
    ui.el('rebuildBtn').addEventListener('click', () => onRebuild());
  }

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' && ownsSpace(e.target)) return;   // the focused control's own key

      const actions = {
        Space: togglePlay,
        ArrowLeft: step(() => player.prev()),
        ArrowRight: step(() => player.next()),
        KeyS: toggleFollow,   // R1: S was Snap; Snap is now part of Follow
        [FOLLOW_SHORTCUT]: toggleFollow,
        KeyR: () => player.recover(),
        [SIDEBAR_SHORTCUT]: toggleSidebar,
        // An active highlight owns N for its own note (highlights.js `onKeyDown`); both
        // handlers are on `document`, so the column only takes the key when no highlight
        // claims it. Asking beats ordering the two listeners, which nothing here enforces.
        [NOTES_SHORTCUT]: () => {
          if (!hasActiveHighlight()) toggleNotes();
        },
      };
      const run = actions[e.code];
      if (!run) return;
      e.preventDefault();
      run();
    });
  }

  return { jumpTo, readFrom, bindButtons, bindKeys, mediaActions };
}

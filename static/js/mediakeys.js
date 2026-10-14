// ── mediakeys.js ─────────────────────────────────────────
// N6: the hardware media keys (a MacBook's F8 ⏯, F9 ⏭, F7 ⏮) via navigator.mediaSession.
// Without action handlers the OS pauses the <audio> element behind the app's back; with
// them each key runs the same transport action as the matching button. playbackState and
// the metadata (document, place in it) follow the player's status so ⏯ knows which way to go.

const ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack'];
const PLAYING_PHASES = new Set(['playing', 'loading', 'recovering']);
const APP_NAME = 'Kokoro Reader';

/** The mediaSession playbackState for a player status phase. */
export const sessionState = (phase) => (PLAYING_PHASES.has(phase) ? 'playing' : 'paused');

/**
 * @param {object} options
 * @param {Object<string, Function>} options.actions handlers keyed by mediaSession action name
 * @param {{get: () => {docName: string, index: number, sentences: Array}}} options.state
 * @param {object} [options.session]  navigator.mediaSession (injected for tests)
 * @param {Function} [options.Metadata] the MediaMetadata constructor (injected for tests)
 * @returns {{isSupported: boolean, sync: (phase: string) => void}}
 */
export function createMediaKeys({
  actions,
  state,
  session = globalThis.navigator?.mediaSession,
  Metadata = globalThis.MediaMetadata,
}) {
  if (!session) return { isSupported: false, sync: () => {} };

  for (const name of ACTIONS) {
    if (typeof actions[name] !== 'function') continue;
    try {
      session.setActionHandler(name, () => actions[name]());
    } catch {
      // This browser does not know the action; the others still work.
    }
  }

  function describe() {
    const { docName, index, sentences } = state.get();
    const total = sentences.length;
    return {
      title: docName || APP_NAME,
      artist: total ? `Sentence ${index + 1} of ${total}` : '',
      album: APP_NAME,
    };
  }

  /** @param {string} phase the player status phase just emitted */
  function sync(phase) {
    session.playbackState = sessionState(phase);
    if (typeof Metadata === 'function') session.metadata = new Metadata(describe());
  }

  return { isSupported: true, sync };
}

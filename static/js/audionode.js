// ── audionode.js ─────────────────────────────────────────
// The <audio> elements' lifecycle, extracted from playback.js: creation,
// listener binding, and the rebuild that clears a WKWebView media-pipeline
// wedge (level 2 of the recovery ladder). Knows nothing about sentences,
// epochs or recovery policy — it only owns the DOM nodes.
//
// J5: there are *two* nodes, ping-ponged. A single element had to load and
// decode the next sentence's blob at every boundary, and `play()` does not
// resolve until it has — measured at 120 ms per transition in the modelled
// harness (tests/js/player.test.mjs T16), on top of the WAV's own padding.
// The spare is src-ed and load()ed while the current sentence is still
// speaking, so the boundary costs a swap instead of a load. Only pair[0] is
// ever played, and only pair[0]'s events reach the caller, so playback.js
// keeps its single-element mental model.
//
// C1b: at an early hand-over the outgoing element *drains* — it keeps playing to its
// own `ended` (silently, as the spare) while the next sentence starts up, then is
// quieted. A preload aimed at it meanwhile waits for that.

const MEDIA_EVENTS = ['ended', 'error', 'stalled', 'suspend', 'waiting', 'emptied',
                      'timeupdate', 'play', 'pause'];

/** Events that end a drain: the outgoing element has nothing more to play. */
const DRAIN_END_EVENTS = new Set(['ended', 'error']);

/** Speed is applied at synthesis time, never by the element (H3). */
export const NATIVE_PLAYBACK_RATE = 1;

/**
 * Create and own a ping-pong pair of hidden <audio> elements.
 *
 * @param {(name: string, ev: object) => void} onEvent Media event sink. Only the
 *        live element's events are forwarded.
 * @returns {{element: HTMLAudioElement, preload: Function, activate: Function,
 *            drain: Function, cutDrain: Function, rebuild: Function, silence: Function,
 *            destroy: Function}}
 *          `activate()`, `rebuild()` and `destroy()` all return the live element
 *          (or null), so the caller can keep a plain reference to it.
 */
export function createAudioNode(onEvent) {
  const bound = new Map();   // element → Map(event name → handler), rebound on rebuild
  let pair = [];             // [live, spare]; nothing but pair[0] is ever heard
  let armed = '';            // the url sitting on the spare, tracked rather than read
                             // back from .src, which browsers rewrite to absolute form
  let draining = null;       // the outgoing element playing out its tail (C1b)
  let deferred = '';         // a preload waiting for `draining` to finish

  function bind() {
    const node = document.createElement('audio');
    node.setAttribute('hidden', '');
    node.style.display = 'none';
    node.preload = 'auto';   // the spare must decode before it is swapped in
    document.body.appendChild(node);
    const handlers = new Map();
    for (const name of MEDIA_EVENTS) {
      // Only the live element may drive the player. The spare's own pause and
      // emptied events, fired as it is armed or retired, would otherwise read
      // to playback.js as "the sentence being read has ended".
      const handler = (ev) => {
        if (node === draining && DRAIN_END_EVENTS.has(name)) endDrain();
        if (node === pair[0]) onEvent(name, ev);
      };
      handlers.set(name, handler);
      node.addEventListener(name, handler);
    }
    bound.set(node, handlers);
    return node;
  }

  function discard(node) {
    if (!node) return;
    for (const [name, handler] of bound.get(node) || []) node.removeEventListener(name, handler);
    bound.delete(node);
    try { node.pause(); } catch { /* element already dead */ }
    if (node.remove) node.remove();
  }

  /** Take an element out of the audible path: paused, src-less, holding no blob. */
  function quiet(node) {
    if (!node) return;
    try { node.pause(); } catch { /* element already dead */ }
    node.removeAttribute('src');
  }

  /**
   * Arm the spare with the next sentence's audio, paying its load+decode now,
   * while the current sentence is still speaking. Idempotent per url.
   * @param {string} url
   */
  function preload(url) {
    const spare = pair[1];
    if (!url || !spare || armed === url) return;
    if (spare === draining) { deferred = url; return; }   // armed once it has played out
    spare.src = url;
    spare.playbackRate = NATIVE_PLAYBACK_RATE;
    if (spare.load) spare.load();
    armed = url;
  }

  /**
   * Make `url` the live element and return it. When the spare already holds it
   * the handover is a swap; otherwise the live element is re-src-ed exactly as a
   * single element always was, so an un-armed transition is never worse than before.
   * @param {string} url
   * @returns {HTMLAudioElement}
   */
  function activate(url) {
    const [current, spare] = pair;
    if (spare && (armed === url || current === draining)) {
      pair = [spare, current];
      if (armed !== url) spare.src = url;   // un-armed, but the live one is still draining
      armed = '';
      if (current !== draining) quiet(current);   // after the swap: its events are filtered
    } else if (current) {
      current.src = url;
      if (armed) { quiet(spare); armed = ''; }   // the arming is stale now
    }
    const listener = pair[0];
    if (listener) listener.playbackRate = NATIVE_PLAYBACK_RATE;   // H3: speed went to the synth
    return listener;
  }

  /**
   * C1b: let the live element play out to `ended` instead of being cut when the next
   * sentence is activated. Only one element drains at a time.
   */
  function drain() {
    cutDrain();
    draining = pair[0] || null;
  }

  /** The drain is over: quiet the element and arm whatever preload waited for it. */
  function endDrain() {
    const done = draining;
    const url = deferred;
    draining = null;
    deferred = '';
    quiet(done);
    if (url) preload(url);
  }

  /** Stop a drain now (a jump, a pause, a rebuild): the tail being left is not wanted. */
  function cutDrain() {
    if (!draining) return;
    quiet(draining);
    draining = null;
    deferred = '';
  }

  /** Level 2 recovery: a brand new live element clears WKWebView pipeline wedges. */
  function rebuild() {
    cutDrain();
    const [current, spare] = pair;
    const src = current ? current.src : '';
    const at = current ? current.currentTime : 0;
    discard(current);
    const fresh = bind();
    pair = [fresh, spare];
    if (src) fresh.src = src;
    fresh.playbackRate = NATIVE_PLAYBACK_RATE;
    try { fresh.currentTime = at; } catch { /* not seekable yet */ }
    return fresh;
  }

  /** Stop and strip *both* elements. After this nothing plays and no blob is held. */
  function silence() {
    cutDrain();
    for (const node of pair) quiet(node);
    armed = '';
    return pair[0] || null;
  }

  /** Unbind every listener on both elements and drop the nodes. No leaks. */
  function destroy() {
    cutDrain();
    for (const node of pair) discard(node);
    pair = [];
    armed = '';
    return null;
  }

  pair = [bind(), bind()];
  return { element: pair[0], preload, activate, drain, cutDrain, rebuild, silence, destroy };
}

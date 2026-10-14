// ── playback.js ──────────────────────────────────────────
// Epoch-guarded sentence player with a stall watchdog.
// Fixes D1 (isLoading deadlock), D4 (re-entrancy), D5 (dead media element).
// Owns its own <audio> node (see audionode.js); everything else arrives via options.
import { createAudioNode } from './audionode.js';
import { VOICE_UNAVAILABLE_STATUS } from './ttsclient.js';
import {
  pauseAfter, handoffDelayMs, isAtHandoff, nextLead, HANDOFF_LEAD_MS, MAX_HANDOFF_LEAD_MS,
} from './cadence.js';

// ── Constants ────────────────────────────────────────────
const TICK_MS            = 2000;   // watchdog cadence
const WEDGE_MS           = 12000;  // isLoading longer than this == wedged
const HAVE_FUTURE_DATA   = 3;      // HTMLMediaElement.readyState threshold
const HAVE_ENOUGH_DATA   = 4;      // a warm element: its start-up is latency, not loading
const MS_PER_S           = 1000;
const MAX_SYNTH_FAILURES = 2;      // then skip the sentence and carry on
const MAX_CONSECUTIVE_SKIPS = 5;   // then stop: the document or the server is broken (H5)
const MAX_LISTEN_STEP_S  = 1.5;    // a bigger currentTime jump is a new source, not listening
const LEVEL_NONE = 0, LEVEL_SOFT = 1, LEVEL_HARD = 2, LEVEL_FULL = 3;
export const PRELOAD_AHEAD = 3;     // sentences prefetched after the cursor; the N1 buffer meter's scale

const nowMs = () => Date.now();

/**
 * Create the playback controller.
 *
 * @param {object}   options
 * @param {object}   options.tts            createTtsClient() instance.
 * @param {Function} options.getSentences   () => [{text, raw, page, kind, items}]
 * @param {Function} options.getVoice       () => string
 * @param {Function} options.getSpeed       () => number
 * @param {Function} [options.onIndex]      (idx, sentence) => void
 * @param {Function} [options.onStatus]     ({state, message, level}) => void
 * @param {Function} [options.onEnded]      () => void
 * @param {Function} [options.onListen]     stats only: {type:'time', seconds, voice} for audio
 *                                           actually heard, {type:'heard', index, total,
 *                                           sentence, voice} when the cursor's sentence ends
 * @param {Function} [options.onVoiceUnavailable] (err) => void: the server no longer has the
 *                                           voice (R6); switch `getVoice` to one it has
 * @param {number}   [options.preloadAhead=3]
 * @param {number}   [options.stallSeconds=6]
 * @returns {{play: Function, toggle: Function, pause: Function, resume: Function,
 *            next: Function, prev: Function, seekRelative: Function, stop: Function,
 *            recover: Function, setIndex: Function, destroy: Function, state: Function}}
 */
export function createPlayer(options = {}) {
  const {
    tts,
    getSentences = () => [],
    getVoice = () => 'af',
    getSpeed = () => 1,
    onIndex = null,
    onStatus = null,
    onEnded = null,
    onListen = null,
    onVoiceUnavailable = null,
    preloadAhead = PRELOAD_AHEAD,
    stallSeconds = 6,
  } = options;

  let epoch = 0;
  let index = 0;
  let isPlaying = false;
  let isLoading = false;
  let pauseRequested = false;   // N6: a pause that arrived mid-load, honoured when it lands
  let loadingSince = 0;
  let recoveries = 0;
  let skipped = 0;
  let consecutiveSkips = 0;
  let lastError = null;
  let destroyed = false;
  let voiced = 0;               // epoch whose sentence the live element carries (A3)

  let stallLevel = LEVEL_NONE;
  let lastTime = 0;
  let lastProgressAt = nowMs();
  let listenMark = 0;           // the live element's currentTime already credited as heard

  const failures = new Map();   // sentence index → consecutive synth failures
  let node = null;              // audionode.js instance: owns the <audio> element
  let audio = null;             // …its live element, re-pointed by every rebuild
  let ticker = null;
  let handoffTimer = null;      // C1: the early hand-over pending near this sentence's end
  let lead = HANDOFF_LEAD_MS;   // C1b: learnt hand-over lead, ms
  let gapSamples = 0;           // boundary gaps folded into it
  let warmStart = false;        // the live sentence started from a preloaded element
  let clockStart = null;        // when its media clock started (Date.now ms), if seen
  let prevEnd = null;           // when the sentence before it ended, by that one's clock
  let drainOnLeave = false;     // set only across an early hand-over's advance()

  // ── Untrusted callbacks (D1: a UI bug must not wedge the player) ──
  function safe(fn, ...args) {
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      lastError = `callback: ${err && err.message}`;
    }
  }

  const emit = (state, message, level = 'info') =>
    safe(onStatus, { state, message, level });

  const sentences = () => getSentences() || [];
  const textOf = (s) => (s && (s.text || s.raw)) || '';

  /**
   * The cursor, re-anchored when the sentence list shrank under it — a Rebuild
   * with different options replaces the script while `index` still points into
   * the old one. Without this every transport call targets a dead index (H2).
   * @returns {number} a playable index, or -1 when there is nothing to read.
   */
  function cursor() {
    const len = sentences().length;
    if (!len) return -1;
    return index < len ? index : len - 1;
  }

  // Level 2 recovery: a brand new element clears WKWebView pipeline wedges.
  const rebuildAudioElement = () => { audio = node.rebuild(); };

  // ── Epoch guard (D4) ───────────────────────────────────
  const stale = (mine) => mine !== epoch || destroyed;

  const bumpEpoch = () => (epoch += 1);

  function setLoading(on) {
    isLoading = on;
    loadingSince = on ? nowMs() : 0;
  }

  /** True when the element actually advanced; only then does the ladder reset. */
  function noteTime() {
    const t = audio ? audio.currentTime : 0;
    if (t === lastTime) return false;
    lastTime = t;
    lastProgressAt = nowMs();
    stallLevel = LEVEL_NONE;
    return true;
  }

  /** Credit audio heard up to media time `t`; a backwards or large jump only re-anchors. */
  function creditListening(t) {
    const step = t - listenMark;
    listenMark = t;
    if (step > 0 && step <= MAX_LISTEN_STEP_S) {
      safe(onListen, { type: 'time', seconds: step, voice: getVoice() });
    }
  }

  /** Restart the stall clock without forgiving the escalation level. */
  function resetStallTimer() {
    lastTime = audio ? audio.currentTime : 0;
    lastProgressAt = nowMs();
  }

  // ── Playing ────────────────────────────────────────────
  /**
   * Play one sentence. Bumps the epoch, so any earlier in-flight play()
   * abandons its continuation instead of fighting for the element.
   * @param {number} idx
   * @returns {Promise<void>}
   */
  async function play(idx) {
    const list = sentences();
    if (!list.length) return emit('idle', 'Nothing to read — build the script first', 'warn');
    if (idx < 0 || idx >= list.length) return;   // prev() at the start / next() at the end
    const mine = bumpEpoch();
    index = idx;
    setLoading(true);
    silenceLive();
    const sentence = list[idx];
    safe(onIndex, idx, sentence);
    emit('loading', `Loading sentence ${idx + 1} / ${list.length}…`);
    try {
      tts.setCurrent(idx);
      tts.setWindow(idx);
      const url = await tts.get(idx, textOf(sentence), getVoice(), getSpeed(), pauseAfter(list, idx));
      if (stale(mine)) return;
      await startElement(url, mine, idx, list.length, sentence);
      // Prefetch stays *after* the start, deliberately. Measured against the real
      // server (12 cold sentences, af_heart): synthesis is 828 ms mean against
      // 11.6 s of audio, so a prefetch queued when this sentence begins is ready
      // long before it ends — moving it earlier bought nothing and cost 24 requests
      // instead of 10 on a document the server cannot synthesise at all (H5, T14).
      if (stale(mine)) return;
      queuePrefetch(idx);
      armNextBuffer(idx, mine);
    } catch (err) {
      if (stale(mine)) return;
      handlePlayError(err, idx);
    } finally {
      if (mine === epoch) setLoading(false);   // D1: unconditional for the owner
    }
  }

  /**
   * A3: the sentence being left must not keep speaking while the target
   * synthesises — nor, by ending first, advance the cursor past the target.
   * Only the live element: an armed spare may be the very sentence asked for.
   */
  function silenceLive() {
    clearHandoff();                 // C1: a hand-over armed for the sentence being left is void
    isPlaying = false;
    forgetClock();
    if (drainOnLeave) {             // C1b: an early hand-over — let it play out its tail
      drainOnLeave = false;
      node.drain();
      return;
    }
    node.cutDrain();
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');   // toggle() must not resume the abandoned sentence
  }

  async function startElement(url, mine, idx, total, sentence) {
    audio = node.activate(url);   // an armed spare swaps in; anything else re-src-es
    voiced = mine;
    listenMark = 0;
    resetStallTimer();
    stallLevel = LEVEL_NONE;
    if (holdForPause()) return;
    warmStart = audio.readyState >= HAVE_ENOUGH_DATA;
    await audio.play();
    if (stale(mine) || holdForPause()) return;
    isPlaying = true;
    failures.delete(idx);
    consecutiveSkips = 0;                        // audio came out: the document is fine
    emit('playing', `Sentence ${idx + 1} / ${total}  ·  Page ${sentence.page ?? '?'}`);
  }

  /** N6: a pause asked for while loading wins — the sentence stays loaded, unplayed. */
  function holdForPause() {
    if (!pauseRequested) return false;
    pauseRequested = false;
    isPlaying = false;
    forgetClock();
    audio.pause();
    return true;
  }

  function handlePlayError(err, idx) {
    if (err && (err.kind === 'abort' || err.name === 'AbortError')) return;  // normal skip
    isPlaying = false;
    lastError = (err && err.message) || String(err);
    if (err && err.name === 'NotAllowedError') {
      emit('paused', 'Autoplay blocked — press Play or Space to start', 'warn');
      return;
    }
    if (fellBack(err)) {
      play(idx);   // the same sentence, in a voice the server has
      return;
    }
    const count = (failures.get(idx) || 0) + 1;
    failures.set(idx, count);
    if (count < MAX_SYNTH_FAILURES) {
      emit('error', `Sentence ${idx + 1} failed (${lastError}) — retrying`, 'warn');
      play(idx);
      return;
    }
    skipped += 1;
    consecutiveSkips += 1;
    emit('error', `Skipped sentence ${idx + 1}: ${lastError}`, 'warn');
    if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
      tripBreaker();
      return;
    }
    advance(idx);
  }

  /**
   * R6: a voice the server no longer has cannot be retried into existence. True when
   * `onVoiceUnavailable` switched to another voice; otherwise it is an ordinary failure.
   */
  function fellBack(err) {
    if (!err || err.status !== VOICE_UNAVAILABLE_STATUS) return false;
    const before = getVoice();
    safe(onVoiceUnavailable, err);
    return getVoice() !== before;
  }

  /**
   * H5: stop the skip cascade. Without this a document the server cannot
   * synthesise walks every sentence, two requests and a toast apiece.
   * Cleared by a sentence that actually plays, or by recover().
   */
  function tripBreaker() {
    bumpEpoch();        // abandon the continuation that would prefetch ahead
    setLoading(false);  // …which also owns the isLoading reset once the epoch moved
    isPlaying = false;
    tts.abortAll();
    emit('error',
         `Stopped after ${consecutiveSkips} sentences failed in a row (${lastError}). `
         + 'Press Recover to try again.', 'error');
  }

  function advance(from) {
    const list = sentences();
    if (from + 1 < list.length) {
      play(from + 1);
      return;
    }
    isPlaying = false;
    emit('idle', 'Finished reading the document ✓');
    safe(onEnded);
  }

  function queuePrefetch(from) {
    const list = sentences();
    const voice = getVoice();
    const speed = getSpeed();
    const entries = [];
    for (let n = 1; n <= preloadAhead; n += 1) {
      const at = from + n;
      if (at >= list.length) break;
      entries.push({ key: at, text: textOf(list[at]), voice, speed, pause: pauseAfter(list, at) });
    }
    if (entries.length) tts.prefetch(entries);
  }

  /**
   * Put sentence `from + 1` on the spare element while this one is still speaking,
   * so the handover costs a swap instead of a load+decode (J5).
   *
   * Best effort in both directions. `peek` does not promote the request, so a user
   * who jumps away still has it cancelled by `setWindow` (D2); and a prefetch that
   * fails leaves the sentence playing now untouched and never reaches `failures`
   * or the H5 skip cascade — only the foreground path counts a sentence as broken.
   */
  function armNextBuffer(from, mine) {
    const list = sentences();
    const at = from + 1;
    if (at >= list.length) return;
    Promise.resolve(tts.peek(at, textOf(list[at]), getVoice(), getSpeed(), pauseAfter(list, at)))
      .then((url) => { if (!stale(mine)) node.preload(url); }, ignore);
  }

  // ── Transport ──────────────────────────────────────────
  /** True while playing, or loading a sentence that will play when it lands. */
  const isRunning = () => isPlaying || (isLoading && !pauseRequested);

  /** Play/pause. A pause during a load is kept (N6), not dropped. */
  function toggle() {
    if (isRunning()) pause();
    else resume();
  }

  /** Pause. Mid-load it is recorded and honoured when the load lands (N6). */
  function pause() {
    if (isLoading) {
      if (pauseRequested) return;
      pauseRequested = true;
      emit('paused', 'Paused');
      return;
    }
    if (!isPlaying) return;
    clearHandoff();      // C1: a pause near the boundary must not start the next sentence
    node.cutDrain();     // C1b: nor the sentence being left keep speaking
    forgetClock();
    isPlaying = false;   // first: the element's own `pause` event must read as ours
    audio.pause();
    emit('paused', 'Paused');
  }

  /** Resume (or start). A stuck load is treated as a wedge and recovered, not ignored. */
  function resume() {
    if (isLoading) {
      if (nowMs() - loadingSince > WEDGE_MS) {
        emit('recovering', 'Load appears wedged — recovering', 'warn');
        recover();
        return;
      }
      if (!pauseRequested) return;
      pauseRequested = false;
      emit('loading', `Loading sentence ${index + 1} / ${sentences().length}…`);
      return;
    }
    if (isPlaying) return;
    if (audio.src && !audio.ended && cursor() === index) {
      resumeElement();
      return;
    }
    play(cursor());   // H2: never resume a sentence the current script no longer has
  }

  function resumeElement() {
    const mine = epoch;
    resetStallTimer();
    isPlaying = true;    // first: the element's own `play` event must read as ours
    Promise.resolve(audio.play()).then(
      () => {
        if (stale(mine) || !isPlaying) return;   // paused again before it started
        emit('playing', `Sentence ${index + 1} / ${sentences().length}`);
      },
      (err) => {
        if (stale(mine) || (err && err.name === 'AbortError')) return;
        isPlaying = false;
        noopErr(err);
        emit('error', `Playback failed: ${lastError}`, 'warn');
      },
    );
  }

  /** An explicit move by the reader plays, whatever pause was pending. */
  function playAt(idx) {
    pauseRequested = false;
    return play(idx);
  }

  const seekRelative = (n) => playAt(cursor() + n);
  const next = () => seekRelative(1);
  const prev = () => seekRelative(-1);

  /** Stop playback and abandon every in-flight continuation. */
  function stop() {
    bumpEpoch();
    setLoading(false);
    pauseRequested = false;
    isPlaying = false;
    // Both buffers: a spare left armed is a second element still holding a decoder
    // — and, on a browser that honours autoplay, a second thing that could speak.
    node.silence();
    tts.abortAll();
    emit('idle', 'Stopped');
  }

  /** Move the cursor without playing. */
  function setIndex(idx) {
    const list = sentences();
    if (idx < 0 || idx >= list.length) return;
    index = idx;
    safe(onIndex, idx, list[idx]);
  }

  // ── Watchdog ───────────────────────────────────────────
  function isStalled() {
    if (!isPlaying || !audio || audio.paused) return false;
    if (noteTime()) return false;
    if (audio.readyState >= HAVE_FUTURE_DATA) return false;
    return nowMs() - lastProgressAt >= stallSeconds * 1000;
  }

  function tick() {
    if (destroyed) return;
    if (!isStalled()) return;
    escalate(stallLevel + 1);
  }

  function escalate(level) {
    if (level <= stallLevel || level > LEVEL_FULL) return;  // one attempt per level
    stallLevel = level;
    recoveries += 1;
    resetStallTimer();
    if (level === LEVEL_SOFT) return softRecover();
    if (level === LEVEL_HARD) return hardRecover();
    return fullRecover();
  }

  const softRecover = () => retryElement(false, 'Audio stalled — reloading stream');
  const hardRecover = () => retryElement(true, 'Audio stalled — rebuilding the player');

  function retryElement(rebuild, message) {
    emit('recovering', message, 'warn');
    const mine = epoch;
    if (rebuild) rebuildAudioElement();
    audio.load();
    Promise.resolve(audio.play()).then(() => { if (!stale(mine)) resetStallTimer(); }, noopErr);
  }

  function fullRecover() {
    const at = cursor();                 // H2: the script may have shrunk under us
    tts.abortAll();
    rebuildAudioElement();
    if (at < 0) return emit('idle', 'Nothing to read — build the script first', 'warn');
    emit('recovering', `Re-synthesising sentence ${at + 1}`, 'warn');
    tts.drop(at);
    failures.delete(at);
    play(at);
  }

  const noopErr = (err) => { lastError = (err && err.message) || String(err); };
  /** An arming that fails is not this sentence's problem: it must not become lastError. */
  const ignore = () => {};

  /** Manual escape hatch (Recover button / R key): straight to level 3. */
  function recover() {
    bumpEpoch();
    setLoading(false);
    pauseRequested = false;
    isPlaying = false;
    stallLevel = LEVEL_FULL;
    recoveries += 1;
    consecutiveSkips = 0;   // H5: an explicit retry re-arms the breaker
    fullRecover();
  }

  // ── Media events ───────────────────────────────────────
  function onMediaEvent(name, ev) {
    if (destroyed) return;
    if (name === 'timeupdate') {
      noteTime();
      if (voiced === epoch) {
        creditListening(audio.currentTime);
        noteClock();
        armHandoff();
      }
      return;
    }
    if (name === 'play') return onExternalPlay();
    if (name === 'pause') return onExternalPause();
    if (name === 'ended') {
      if (voiced !== epoch) return;   // A3: a sentence already left behind, not the cursor's
      finishSentence();
      return;
    }
    if (name === 'error') {
      lastError = mediaErrorMessage(ev);
      emit('recovering', `Media error — rebuilding the player (${lastError})`, 'warn');
      escalate(Math.max(stallLevel + 1, LEVEL_HARD));
      return;
    }
    // stalled / suspend / waiting / emptied: nudge the same ladder, but only
    // once the stall predicate actually holds — these fire during normal buffering.
    if (isStalled()) escalate(stallLevel + 1);
  }

  /** The cursor's sentence is done (`ended`, or the early hand-over): count it, move on. */
  function finishSentence() {
    clearHandoff();
    isPlaying = false;
    settleGap();         // a sentence too short to arm still measures its boundary
    const duration = audio.duration;
    const end = clockStart !== null && Number.isFinite(duration) ? clockStart + duration * MS_PER_S : null;
    if (Number.isFinite(duration)) creditListening(duration);
    const list = sentences();
    safe(onListen, { type: 'heard', index, total: list.length, sentence: list[index],
                     voice: getVoice() });
    advance(index);
    prevEnd = end;   // after advance(): its play() forgets the old clock synchronously
  }

  /**
   * C1: hand over to the armed spare HANDOFF_LEAD_MS before the end, inside the WAV's silent
   * tail, instead of paying the element's start-up latency after `ended`. `ended` stays the
   * backstop (a throttled timer simply loses to it). At fire time the epoch, the voice, the
   * play state and the position are all re-checked: a jump, a pause or a stall since arming
   * leaves the sentence alone, and the next `timeupdate` re-arms.
   */
  function armHandoff() {
    if (handoffTimer !== null || !isPlaying || audio.paused) return;
    if (handoffDelayMs(audio.currentTime, audio.duration, MAX_HANDOFF_LEAD_MS) === null) return;
    settleGap();         // before any lead could arm: the boundary in sets the one out
    const wait = handoffDelayMs(audio.currentTime, audio.duration, lead);
    if (wait === null) return;
    const mine = epoch;
    const armedLead = lead;
    handoffTimer = setTimeout(() => {
      handoffTimer = null;
      if (stale(mine) || voiced !== mine || !isPlaying || audio.paused || audio.ended) return;
      if (!isAtHandoff(audio.currentTime, audio.duration, armedLead)) return;
      drainOnLeave = true;   // C1b: the old element plays on to `ended`, unheard past its tail
      finishSentence();
      drainOnLeave = false;  // the last sentence: nothing was started, nothing drains
    }, wait);
  }

  /**
   * C1b: date the live sentence's media clock. Every reading gives now − currentTime; a
   * stale currentTime (Chromium steps it ~64 ms) or a stall only makes that later, so the
   * earliest reading is the start.
   */
  function noteClock() {
    const at = audio.currentTime;
    if (!isPlaying || !(at > 0)) return;
    const start = nowMs() - at * MS_PER_S;
    clockStart = clockStart === null ? start : Math.min(clockStart, start);
  }

  /**
   * The boundary into the live sentence: its clock start − the previous one's clock end
   * corrects the lead, absorbing whatever this browser's start-up and timer lateness are.
   * A cold element's gap is its loading, not latency: not a sample. Once per sentence.
   */
  function settleGap() {
    if (prevEnd !== null && clockStart !== null && warmStart) {
      lead = nextLead(lead, clockStart - prevEnd, gapSamples);
      gapSamples += 1;
    }
    prevEnd = null;
  }

  /** A pause or a jump: the live sentence's clock no longer dates anything. */
  function forgetClock() {
    clockStart = null;
    prevEnd = null;
  }

  function clearHandoff() {
    if (handoffTimer !== null) clearTimeout(handoffTimer);
    handoffTimer = null;
  }

  /**
   * N6: the element paused by something other than this player — the OS media key, the
   * system Now Playing widget. App pauses clear isPlaying first; the pause a browser fires
   * just before a natural `ended` comes with `ended` already true.
   */
  function onExternalPause() {
    if (!isPlaying || voiced !== epoch || audio.ended) return;
    clearHandoff();
    node.cutDrain();
    forgetClock();
    isPlaying = false;
    creditListening(audio.currentTime);
    emit('paused', 'Paused');
  }

  /** N6: the element resumed from outside. App plays set isPlaying (or isLoading) first. */
  function onExternalPlay() {
    if (isPlaying || isLoading || voiced !== epoch || !audio.src) return;
    isPlaying = true;
    resetStallTimer();
    emit('playing', `Sentence ${index + 1} / ${sentences().length}`);
  }

  const mediaErrorMessage = (ev) =>
    `MEDIA_ELEMENT_ERROR code ${audio?.error?.code ?? ev?.target?.error?.code ?? 'unknown'}`;

  // ── Lifecycle ──────────────────────────────────────────
  /** Remove listeners, stop the ticker, abort everything. No leaks. */
  function destroy() {
    destroyed = true;
    bumpEpoch();
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
    clearHandoff();
    audio = node.destroy();
    tts.abortAll();
  }

  /** @returns {{index, isPlaying, isLoading, isRunning, epoch, recoveries, skipped, lastError}} */
  function state() {
    return { index, isPlaying, isLoading, isRunning: isRunning(), epoch, recoveries, skipped, lastError };
  }

  node = createAudioNode(onMediaEvent);
  audio = node.element;
  ticker = setInterval(tick, TICK_MS);

  return { play: playAt, toggle, pause, resume, next, prev, seekRelative, stop, recover, setIndex,
           destroy, state };
}

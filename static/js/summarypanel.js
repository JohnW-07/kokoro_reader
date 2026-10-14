/**
 * summarypanel.js — the Summary tab (N9): summarise the page (or section) being read, show
 * the summary as text, and read it aloud in the current voice.
 *
 * The summary has its own player and its own TTS client: the main client caches audio by
 * sentence index, so sharing it would hand the summary the paper's audio. The two players
 * never speak together: Play here pauses the main reader first, and main.js pauses this
 * panel whenever the main reader starts.
 */

import { createPlayer } from './playback.js';
import { createTtsClient } from './ttsclient.js';
import * as rules from './summary.js';

const NOTE = 'Summary may omit details.';
const TTS_ENDPOINT = '/api/tts';
const LABEL_PLAY = 'Play summary';
const LABEL_PAUSE = 'Pause summary';

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'hidden' || key === 'type' || key === 'disabled') node[key] = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}

/** The real summary player: a second createPlayer on a TTS client of its own. */
function defaultMakePlayer(options) {
  const tts = createTtsClient({ endpoint: TTS_ENDPOINT });
  const player = createPlayer({ tts, ...options });
  return Object.freeze({ ...player, reset() { player.stop(); tts.clear(); } });
}

/**
 * @param {object}   o
 * @param {Element}  o.root        the #tab-summary panel; without it the panel is inert
 * @param {object}   o.state       state.js (get, subscribe)
 * @param {Function} o.post        api.summarize: (payload) => Promise<{summary, backend, cached}>
 * @param {object}   o.mainPlayer  the reader's player (state, pause)
 * @param {Function} [o.makePlayer] (createPlayer options) => player with reset(); for tests
 * @param {Function} o.voiceOf     (state) => the voice id the TTS engine should use
 * @param {Function} [o.onVoiceUnavailable] playback.js option: the server lost the voice (R6)
 * @returns {{pause: Function}}
 */
export function createSummaryPanel({ root, state, post, mainPlayer, makePlayer = defaultMakePlayer, voiceOf, onVoiceUnavailable }) {
  if (!root) return Object.freeze({ pause() {} });

  let generation = 0;          // a newer request (or another document) supersedes an older reply
  let sentences = Object.freeze([]);
  let player = null;           // made on first Play: a second <audio> only when it is used
  let isFresh = true;          // the next Play starts at the first sentence

  const pageBtn = h('button', { type: 'button', className: 'summary-btn ghost-btn', text: 'Summarise this page' });
  const sectionBtn = h('button', { type: 'button', className: 'summary-btn ghost-btn', text: 'Summarise this section', hidden: true });
  const status = h('p', { className: 'summary-status', role: 'status', 'aria-live': 'polite' });
  const heading = h('p', { className: 'summary-heading' });
  const body = h('p', { className: 'summary-text' });
  const playBtn = h('button', { type: 'button', className: 'summary-play ghost-btn', text: LABEL_PLAY });
  const result = h('div', { className: 'summary-result', hidden: true },
    [heading, body, h('p', { className: 'summary-note', text: NOTE }), playBtn]);
  root.replaceChildren(h('div', { className: 'summary-actions' }, [pageBtn, sectionBtn]), status, result);

  const setStatus = (message, level = 'info') => {
    status.textContent = message;
    status.setAttribute('data-level', level);
  };
  const setPlaying = (isOn) => { playBtn.textContent = isOn ? LABEL_PAUSE : LABEL_PLAY; };
  const mark = (idx) => [...body.children].forEach((span, i) => span.classList.toggle('current', i === idx));

  function ensurePlayer() {
    player ??= makePlayer({
      getSentences: () => sentences,
      getVoice: () => voiceOf(state.get()),
      getSpeed: () => state.get().speed,
      onIndex: (idx) => mark(idx),
      onStatus: ({ state: phase }) => setPlaying(phase === 'playing' || phase === 'loading'),
      onEnded: () => { isFresh = true; setPlaying(false); mark(-1); },
      onVoiceUnavailable,
    });
    return player;
  }

  function clearResult() {
    player?.reset();
    isFresh = true;
    sentences = Object.freeze([]);
    result.hidden = true;
    body.replaceChildren();
    setPlaying(false);
  }

  function show(reply, scope) {
    sentences = rules.summarySentences(reply.summary, scope.page);
    const source = rules.BACKEND_NAMES[reply.backend] || reply.backend;
    heading.textContent = `Summary of ${scope.label} · ${source}${reply.cached ? ' · saved' : ''}`;
    body.replaceChildren(...sentences.map((s) => h('span', { className: 'summary-sentence', text: `${s.text} ` })));
    result.hidden = false;
    setStatus(scope.clipped ? 'Long text: only its first part was summarised.' : '');
  }

  async function summarise(scope) {
    const mine = ++generation;
    clearResult();
    if (!scope) return setStatus('Nothing to summarise here yet: open a document and build its script.', 'warn');
    setStatus(`Summarising ${scope.label}…`, 'loading');
    try {
      const s = state.get();
      const reply = await rules.requestSummary({ post, scope, docId: s.docId, backends: rules.backendsFor(s.options) });
      if (mine === generation) show(reply, scope);
    } catch (err) {
      if (mine === generation) setStatus(rules.errorMessage(err), 'warn');
    }
  }

  function onPlay() {
    if (!sentences.length) return;
    const p = ensurePlayer();
    if (p.state().isRunning) return p.pause();
    if (mainPlayer?.state().isRunning) mainPlayer.pause();
    if (isFresh) {
      isFresh = false;
      p.play(0);
    } else p.resume();
  }

  pageBtn.addEventListener('click', () => {
    const s = state.get();
    summarise(rules.pageScope(s.sentences, rules.cursorPage(s)));
  });
  sectionBtn.addEventListener('click', () => {
    const s = state.get();
    summarise(rules.sectionScope(s.sections, s.sentences, s.index));
  });
  playBtn.addEventListener('click', onPlay);

  let was = state.get();
  state.subscribe((s) => {
    if (s.docId !== was.docId) {
      generation += 1;
      clearResult();
      setStatus('');
    }
    if (s.sections !== was.sections || s.index !== was.index) {
      sectionBtn.hidden = !(s.sections || []).some((x) => x.index <= s.index);
    }
    was = s;
  });

  return Object.freeze({
    /** The main reader started: the summary must not speak over it. */
    pause() { if (player?.state().isRunning) player.pause(); },
  });
}

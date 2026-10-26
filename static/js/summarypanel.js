/**
 * summarypanel.js — the Summary tab (N9): summarise the page on screen (or the section being
 * read), show the summary as notes — a title, a context line, key points (docs/17) — and read
 * it aloud in the current voice.
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
  const tts = createTtsClient({ endpoint: TTS_ENDPOINT, shapeOf: options.shapeOf });
  const player = createPlayer({ tts, ...options });
  return Object.freeze({ ...player, reset() { player.stop(); tts.clear(); } });
}

const ROLE_TAGS = Object.freeze({ heading: ['h3', 'summary-title'], context: ['p', 'summary-context'] });

/** Title and context as their own lines, points as one list; prose as one paragraph of spans. */
function renderNotes(sentences) {
  const line = (s, tag, cls) => h(tag, { className: `${cls} summary-sentence`, text: s.text });
  const points = sentences.filter((s) => s.role === 'point').map((s) => line(s, 'li', 'summary-point'));
  const prose = sentences.filter((s) => s.role === 'text').map((s) => h('span', { className: 'summary-sentence', text: `${s.text} ` }));
  return [
    ...sentences.filter((s) => ROLE_TAGS[s.role]).map((s) => line(s, ...ROLE_TAGS[s.role])),
    ...(points.length ? [h('ul', { className: 'summary-points' }, points)] : []),
    ...(prose.length ? [h('p', { className: 'summary-text' }, prose)] : []),
  ];
}

/**
 * @param {object}   o
 * @param {Element}  o.root        the #tab-summary panel; without it the panel is inert
 * @param {object}   o.state       state.js (get, subscribe)
 * @param {Function} o.post        api.summarize: (payload) => Promise<{heading, context, points, summary, backend, cached}>
 * @param {object}   o.mainPlayer  the reader's player (state, pause)
 * @param {Function} [o.makePlayer] (createPlayer options) => player with reset(); for tests
 * @param {Function} o.voiceOf     (state) => the voice id the TTS engine should use
 * @param {Function} [o.onVoiceUnavailable] playback.js option: the server lost the voice (R6)
 * @param {Function} [o.viewedPage] () => the page on screen (pdfview.js currentPage)
 * @param {{shapeOf?: Function, onAudioElement?: Function}} [o.personal] V1: the reader's voice
 *        shape (ttsclient) and effects hook (playback), so a summary sounds like the paper
 * @returns {{pause: Function}}
 */
export function createSummaryPanel({ root, state, post, mainPlayer, makePlayer = defaultMakePlayer, voiceOf, onVoiceUnavailable, viewedPage = () => 0, personal = {} }) {
  if (!root) return Object.freeze({ pause() {} });

  let generation = 0;          // a newer request (or another document) supersedes an older reply
  let sentences = Object.freeze([]);
  let player = null;           // made on first Play: a second <audio> only when it is used
  let isFresh = true;          // the next Play starts at the first sentence

  const pageBtn = h('button', { type: 'button', className: 'summary-btn ghost-btn', text: 'Summarise this page' });
  const sectionBtn = h('button', { type: 'button', className: 'summary-btn ghost-btn', text: 'Summarise this section', hidden: true });
  const status = h('p', { className: 'summary-status', role: 'status', 'aria-live': 'polite' });
  const meta = h('p', { className: 'summary-heading' });
  const body = h('div', { className: 'summary-body' });
  const playBtn = h('button', { type: 'button', className: 'summary-play ghost-btn', text: LABEL_PLAY });
  const result = h('div', { className: 'summary-result', hidden: true },
    [meta, body, h('p', { className: 'summary-note', text: NOTE }), playBtn]);
  root.replaceChildren(h('div', { className: 'summary-actions' }, [pageBtn, sectionBtn]), status, result);

  const setStatus = (message, level = 'info') => {
    status.textContent = message;
    status.setAttribute('data-level', level);
  };
  const setPlaying = (isOn) => { playBtn.textContent = isOn ? LABEL_PAUSE : LABEL_PLAY; };
  const mark = (idx) => body.querySelectorAll('.summary-sentence').forEach((node, i) => node.classList.toggle('current', i === idx));

  function ensurePlayer() {
    player ??= makePlayer({
      getSentences: () => sentences,
      getVoice: () => voiceOf(state.get()),
      getSpeed: () => state.get().speed,
      onIndex: (idx) => mark(idx),
      onStatus: ({ state: phase }) => setPlaying(phase === 'playing' || phase === 'loading'),
      onEnded: () => { isFresh = true; setPlaying(false); mark(-1); },
      onVoiceUnavailable,
      ...personal,
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
    sentences = rules.notesSentences(reply, scope.page);
    const source = rules.BACKEND_NAMES[reply.backend] || reply.backend;
    meta.textContent = `Summary of ${scope.label} · ${source}${reply.cached ? ' · saved' : ''}`;
    body.replaceChildren(...renderNotes(sentences));
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
    summarise(rules.pageScope(s.sentences, rules.summaryPage(viewedPage(), s)));
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

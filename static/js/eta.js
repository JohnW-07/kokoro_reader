// ── Reading ETA (N11) ────────────────────────────────────────────────────────
// How long the voice will take to finish this page and the paper. The rate is learnt
// from what was actually heard (playback.js `onListen`): each sentence played straight
// after the one before it is a sample of audio seconds per spoken character, kept per
// voice and speed as a character-weighted EWMA. Until a voice has a sample the default
// below stands in. Pure: no DOM, no state.js; etastatus.js binds it to the app.

import { ttsVoice } from './engineswitch.js';

/** ~150 words/min × ~6 chars/word (with the space). Not measured against Kokoro audio. */
export const DEFAULT_CHARS_PER_S = 15;
/** Weight of the newest sample; ~1/α sentences of memory. */
export const EWMA_ALPHA = 0.2;
/** Samples outside these bounds are a seek, a stall or a clock glitch, not speech. */
export const MIN_S_PER_CHAR = 1 / 80;
export const MAX_S_PER_CHAR = 1 / 2;
/** Voice × speed pairs remembered in prefs; the least recently updated go first. */
export const MAX_RATE_KEYS = 24;

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SHARE_DECIMALS = 3;
const DOC_ID_RE = /^[0-9a-f]{8,64}$/;   // notes_store.DOC_ID_RE

const positive = (n) => Number.isFinite(n) && n > 0;

/** Characters the voice will say for a sentence; `raw` stands in as playback.js does. */
export function spokenChars(sentence) {
  return ((sentence && (sentence.text || sentence.raw)) || '').length;
}

export function rateKey(voice, speed) {
  return `${voice}@${Number(speed).toFixed(2)}`;
}

/** Seconds per spoken character for this voice and speed. */
export function secondsPerChar(rates, voice, speed) {
  const r = rates?.[rateKey(voice, speed)];
  return r ? r.s / r.c : 1 / (DEFAULT_CHARS_PER_S * speed);
}

/**
 * The rates with one more sample folded in; the same object back when the sample is junk.
 * @param {object} rates  {[rateKey]: {s, c}}: decayed sums of seconds and characters
 * @param {{seconds: number, chars: number}} sample
 */
export function withSample(rates, voice, speed, { seconds, chars }) {
  if (!positive(seconds) || !positive(chars)) return rates;
  const perChar = seconds / chars;
  if (perChar < MIN_S_PER_CHAR || perChar > MAX_S_PER_CHAR) return rates;
  const key = rateKey(voice, speed);
  const { [key]: prior, ...rest } = rates || {};
  const keep = 1 - EWMA_ALPHA;
  const next = prior ? { s: prior.s * keep + seconds, c: prior.c * keep + chars } : { s: seconds, c: chars };
  const kept = Object.entries(rest).slice(-(MAX_RATE_KEYS - 1));
  return { ...Object.fromEntries(kept), [key]: next };
}

/** Saved rates as prefs hand them back: anything malformed is dropped. */
export function cleanRates(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const ok = Object.entries(raw).filter(([, r]) => positive(r?.s) && positive(r?.c));
  return Object.fromEntries(ok.slice(-MAX_RATE_KEYS).map(([k, r]) => [k, { s: r.s, c: r.c }]));
}

/** Characters from sentence `index` (included) to the end of its page and of the paper. */
export function remaining(sentences, index) {
  if (!sentences?.length) return null;
  const from = Math.min(Math.max(0, index | 0), sentences.length - 1);
  const { page } = sentences[from];
  let pageChars = 0;
  let docChars = 0;
  for (let i = from; i < sentences.length; i += 1) {
    const n = spokenChars(sentences[i]);
    docChars += n;
    if (sentences[i].page === page) pageChars += n;
  }
  return { page, pageChars, docChars, sentencesLeft: sentences.length - from };
}

/** Everything the status bar and the stats page show, or null with no script. */
export function etaView({ sentences, index, rates, voice, speed }) {
  const left = remaining(sentences, index);
  if (!left) return null;
  const perChar = secondsPerChar(rates, voice, speed);
  return {
    page: left.page,
    pageSeconds: left.pageChars * perChar,
    docSeconds: left.docChars * perChar,
    sentencesLeft: left.sentencesLeft,
    heardShare: (sentences.length - left.sentencesLeft) / sentences.length,
  };
}

/** The ETA for an app state snapshot (state.js), at the voice actually requested. */
export function currentEta(s) {
  if (!s.docId) return null;
  return etaView({ sentences: s.sentences, index: s.index, rates: s.etaRates, voice: ttsVoice(s), speed: s.speed });
}

/** 20 → "<1 min", 190 → "3 min", 4320 → "1 h 12 m", 7200 → "2 h". */
export function formatEta(seconds) {
  if (!(seconds >= SECONDS_PER_MINUTE)) return '<1 min';
  const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  if (!hours) return `${minutes} min`;
  return rest ? `${hours} h ${rest} m` : `${hours} h`;
}

export function etaText({ pageSeconds, docSeconds }) {
  return `≈${formatEta(pageSeconds)} left on page · ${formatEta(docSeconds)} in paper`;
}

/**
 * Turns listen events into rate samples. A sentence's audio time is only trusted when
 * it was heard straight after the sentence before it: after Play or a jump, the time
 * since the last `heard` may belong to a sentence that was cut short.
 * @param {{getSpeed: () => number, getRates: () => object, setRates: (r: object) => void}} deps
 */
export function createEtaTracker({ getSpeed, getRates, setRates }) {
  let lastHeard = null;
  let seconds = 0;

  function listen(ev) {
    if (ev?.type === 'time') {
      const step = Number(ev.seconds);
      if (step > 0) seconds += step;
      return;
    }
    if (ev?.type !== 'heard' || !Number.isInteger(ev.index)) return;
    const isNext = lastHeard !== null && ev.index === lastHeard + 1;
    const sample = { seconds, chars: spokenChars(ev.sentence) };
    lastHeard = ev.index;
    seconds = 0;
    if (!isNext) return;
    const rates = getRates() || {};
    const next = withSample(rates, ev.voice, getSpeed(), sample);
    if (next !== rates) setRates(next);
  }

  return { listen };
}

// ── "This paper" on the stats page: the numbers ride in the frame's URL ─────
/** The stats frame's query for this paper, or '' with no paper or no script. */
export function paperQuery(docId, view) {
  if (!docId || !view) return '';
  return new URLSearchParams({
    doc: docId,
    page_s: String(Math.round(view.pageSeconds)),
    doc_s: String(Math.round(view.docSeconds)),
    left: String(view.sentencesLeft),
    heard: view.heardShare.toFixed(SHARE_DECIMALS),
  }).toString();
}

/** The paper numbers in a stats page URL, or null when absent or malformed. */
export function readPaperQuery(search) {
  const q = new URLSearchParams(search);
  const docId = q.get('doc') || '';
  const nums = ['page_s', 'doc_s', 'left', 'heard'].map((k) => (q.has(k) ? Number(q.get(k)) : NaN));
  if (!DOC_ID_RE.test(docId) || nums.some((n) => !Number.isFinite(n) || n < 0) || nums[3] > 1) return null;
  const [pageSeconds, docSeconds, sentencesLeft, heardShare] = nums;
  return { docId, pageSeconds, docSeconds, sentencesLeft, heardShare };
}

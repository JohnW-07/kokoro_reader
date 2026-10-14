// ── Listening log ────────────────────────────────────────────────────────────
// Batches what the reader actually heard (playback.js `onListen`) and posts it
// to /api/stats/listen for the Wrapped page. Stats are a passenger: every send
// failure is swallowed, nothing here can slow or stop playback, and a pending
// batch goes out on pagehide via sendBeacon.

import * as state from './state.js';

export const LISTEN_URL = '/api/stats/listen';
export const LISTEN_FLUSH_MS = 15000;
const MAX_TITLE_CHARS = 200;
const VOICE_OK = /^[A-Za-z0-9_]{0,64}$/;

/** Words in a sentence object or string, as the summary counts them. Pure. */
export function wordCount(sentence) {
  const text = typeof sentence === 'string' ? sentence : (sentence?.text || sentence?.raw || '');
  return text.split(/\s+/).filter(Boolean).length;
}

function emptyBatch(doc, voice) {
  return {
    doc_id: doc.docId || '',
    title: (doc.title || '').slice(0, MAX_TITLE_CHARS),
    voice: VOICE_OK.test(voice || '') ? voice || '' : '',
    seconds: 0, sentences: 0, words: 0, pages: 0, progress: 0,
  };
}

function withTime(batch, seconds) {
  return seconds > 0 ? { ...batch, seconds: batch.seconds + seconds } : batch;
}

function withHeard(batch, ev, turnedPage) {
  const share = ev.total > 0 ? Math.min(1, (ev.index + 1) / ev.total) : 0;
  return {
    ...batch,
    sentences: batch.sentences + 1,
    words: batch.words + wordCount(ev.sentence),
    pages: batch.pages + (turnedPage ? 1 : 0),
    progress: Math.max(batch.progress, share),
  };
}

/**
 * A batching log, one batch per (paper, voice). Pure apart from the injected
 * `send` and timer functions.
 * @param {object} o
 * @param {(batch: object, opts: {beacon: boolean}) => any} o.send
 * @param {() => {docId: string|null, title: string}} o.getDoc
 * @param {Function} [o.setTimer] @param {Function} [o.clearTimer] @param {number} [o.flushMs]
 */
export function createListenLog({
  send, getDoc, setTimer = setTimeout, clearTimer = clearTimeout, flushMs = LISTEN_FLUSH_MS,
}) {
  let batch = null;
  let timer = null;
  let lastPage = { docId: null, page: null };

  function schedule() {
    if (timer !== null) return;
    timer = setTimer(() => { timer = null; flush(); }, flushMs);
    timer?.unref?.();   // never hold a node test process open
  }

  /** Send the pending batch now. Resolves true when one was sent and accepted. */
  function flush({ beacon = false } = {}) {
    if (timer !== null) { clearTimer(timer); timer = null; }
    const out = batch;
    batch = null;
    if (!out || (out.seconds <= 0 && out.sentences === 0)) return Promise.resolve(false);
    try {
      return Promise.resolve(send(out, { beacon })).then(() => true, () => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  function pageTurned(docId, page) {
    const turned = page != null && lastPage.docId === docId
      && lastPage.page != null && page !== lastPage.page;
    if (page != null) lastPage = { docId, page };
    return turned;
  }

  /** Take one playback.js listen event. */
  function add(ev) {
    if (!ev || (ev.type !== 'time' && ev.type !== 'heard')) return;
    const doc = getDoc() || {};
    const fresh = emptyBatch(doc, ev.voice);
    if (batch && (batch.doc_id !== fresh.doc_id || batch.voice !== fresh.voice)) flush();
    const base = batch || fresh;
    batch = ev.type === 'time'
      ? withTime(base, Number(ev.seconds) || 0)
      : withHeard(base, ev, pageTurned(fresh.doc_id, ev.sentence?.page ?? null));
    schedule();
  }

  return { add, flush, pending: () => batch };
}

function postBatch(batch, { beacon = false } = {}) {
  const body = JSON.stringify(batch);
  if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(LISTEN_URL, new Blob([body], { type: 'application/json' }));
    return Promise.resolve();
  }
  return fetch(LISTEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
  }).then((res) => { if (!res.ok) throw new Error(`stats: ${res.status}`); });
}

function bindUnload(log) {
  const beacon = () => log.flush({ beacon: true });
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', beacon);
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') beacon();
    });
  }
}

let shared = null;

/** The app's one listening log, bound to state.js and flushed on pagehide. */
export function listenLog() {
  if (!shared) {
    shared = createListenLog({
      send: postBatch,
      getDoc: () => ({ docId: state.get().docId, title: state.get().docName }),
    });
    bindUnload(shared);
  }
  return shared;
}

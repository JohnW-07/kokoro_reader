// Shared fakes for the player harnesses (player.test.mjs, jump.test.mjs):
// fake clock, fake fetch, fake <audio>, and the PASS/FAIL tally. Importing installs them.

const ROOT = new URL('../../static/js/', import.meta.url);
const imp = (f) => import(new URL(f, ROOT).href);

// ── Fake clock / timers ──────────────────────────────────
let now = 0, seq = 0;
let timers = new Map();
globalThis.setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: now + ms, iv: null }); return id; };
globalThis.setInterval = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms, iv: ms }); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.clearInterval = (id) => timers.delete(id);
Date.now = () => now;

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

async function advance(ms) {
  const target = now + ms;
  for (;;) {
    let pick = null;
    for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick.t.at)) pick = { id, t };
    if (!pick) break;
    now = pick.t.at;
    if (pick.t.iv) pick.t.at = now + pick.t.iv; else timers.delete(pick.id);
    try { pick.t.fn(); } catch (e) { console.log('timer threw', e); }
    await flush();
  }
  now = target;
  await flush();
}

// ── Fake blob URLs ───────────────────────────────────────
let blobSeq = 0;
const revoked = [];
globalThis.URL.createObjectURL = (b) => `blob:${b.tag}#${++blobSeq}`;
globalThis.URL.revokeObjectURL = (u) => revoked.push(u);

// ── Fake fetch ───────────────────────────────────────────
const net = { inflight: 0, peak: 0, calls: [], mode: 'ok', latency: 100, status: 200,
              failText: new Set(),     // per-sentence failure, for a prefetch that dies alone
              replies: new Map(),      // text → statuses its next calls get, then `status` (A12)
              retryAfter: null };      // Retry-After header value on every 503
const abortErr = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };

globalThis.fetch = (url, opts = {}) => {
  net.inflight += 1;
  net.peak = Math.max(net.peak, net.inflight);
  const text = new URL('http://x' + url).searchParams.get('text');
  const rec = { url, text, done: false, aborted: false };
  net.calls.push(rec);
  return new Promise((resolve, reject) => {
    const done = (fn) => (v) => { if (rec.done) return; rec.done = true; net.inflight -= 1; fn(v); };
    rec.resolve = done(resolve);
    rec.reject = done(reject);
    if (opts.signal) {
      if (opts.signal.aborted) return rec.reject(abortErr());
      opts.signal.addEventListener('abort', () => { rec.aborted = true; rec.reject(abortErr()); });
    }
    if (net.mode === 'hang') return;
    setTimeout(() => {
      if (net.mode === 'error' || net.failText.has(rec.text)) return rec.reject(new Error('offline'));
      const script = net.replies.get(rec.text) || [];
      const status = script.length ? script[0] : net.status;
      net.replies.set(rec.text, script.slice(1));
      rec.resolve({
        ok: status < 400, status,
        headers: { get: (n) => (status === 503 && /^retry-after$/i.test(n) ? net.retryAfter : null) },
        blob: async () => ({ tag: rec.text }),
      });
    }, net.latency);
  });
};

// ── Fake <audio> + document ──────────────────────────────
// `loadMs` models the one thing the old fake got wrong: a real element does NOT
// become playable the instant `src` is assigned — it loads and decodes first, and
// `play()` does not resolve until it has. With loadMs = 0 the element behaves exactly
// as it did before, so T1–T15 are untouched; the J5 tests set it and measure.
const audios = [];
const audible = [];                                   // {el, at, src} per play() resolution
const audioDefaults = { readyState: 4, loadMs: 0 };
class FakeAudio {
  constructor() {
    this.listeners = new Map(); this._src = ''; this.srcHistory = [];
    this.playbackRate = 1; this.currentTime = 0; this.paused = true; this.ended = false;
    this.readyState = audioDefaults.readyState; this.style = {}; this.error = null;
    this.playCalls = 0; this.loadCalls = 0; this.removed = false; this.playRejects = null;
    this._ready = []; this._loadTimer = null;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.srcHistory.push(v); this._beginLoad(); }
  /** No-op unless load latency is modelled; then readyState climbs on a timer. */
  _beginLoad() {
    if (!audioDefaults.loadMs) return;
    this.readyState = 0;
    if (this._loadTimer !== null) clearTimeout(this._loadTimer);
    this._loadTimer = setTimeout(() => {
      this._loadTimer = null;
      this.readyState = audioDefaults.readyState;
      for (const fn of this._ready.splice(0)) fn();
    }, audioDefaults.loadMs);
  }
  setAttribute() {}
  removeAttribute(n) { if (n === 'src') this._src = ''; }
  addEventListener(n, h) { if (!this.listeners.has(n)) this.listeners.set(n, []); this.listeners.get(n).push(h); }
  removeEventListener(n, h) {
    const l = this.listeners.get(n) || [];
    const i = l.indexOf(h); if (i !== -1) l.splice(i, 1);
  }
  dispatch(n, ev = {}) { for (const h of [...(this.listeners.get(n) || [])]) h({ type: n, target: this, ...ev }); }
  play() {
    this.playCalls += 1; this.paused = false; this.ended = false;
    if (this.playRejects) return Promise.reject(this.playRejects);
    const heard = () => { audible.push({ el: this, at: now, src: this._src }); };
    if (!audioDefaults.loadMs || this.readyState >= 3) { heard(); return Promise.resolve(); }
    return new Promise((resolve) => this._ready.push(() => { heard(); resolve(); }));
  }
  pause() { this.paused = true; }
  load() { this.loadCalls += 1; this._beginLoad(); }
  remove() { this.removed = true; }
}
globalThis.document = {
  createElement: (tag) => { const a = new FakeAudio(); a.tag = tag; audios.push(a); return a; },
  body: { appendChild() {} },
};

// ── Assertions ───────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}  ${extra}`); }
};
const eq = (a, b, label) => ok(Object.is(a, b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const reset = (mode = 'ok', latency = 100, status = 200) => {
  net.inflight = 0; net.peak = 0; net.calls.length = 0; net.mode = mode; net.latency = latency; net.status = status;
  revoked.length = 0; audios.length = 0; audible.length = 0;
  audioDefaults.readyState = 4; audioDefaults.loadMs = 0;
  net.failText = new Set(); net.replies = new Map(); net.retryAfter = null; timers = new Map(); now = 0;
};
process.on('unhandledRejection', (e) => { fail += 1; console.log('  FAIL  unhandled rejection:', e && e.message); });

const { createTtsClient } = await imp('ttsclient.js');
const { createPlayer } = await imp('playback.js');

// audionode.js builds a ping-pong PAIR of elements up front (J5), so element
// counts below are "the pair, plus whatever recovery built", not "one, plus".
const PAIR = 2;

const mkSentences = (n) => Array.from({ length: n }, (_, i) => ({ text: `s${i}`, raw: `s${i}`, page: 1, kind: 'body', items: [] }));

// The element actually heard last, and the elements not yet torn down.
const live = () => audible[audible.length - 1].el;
const alive = () => audios.filter((a) => !a.removed);

/** Print the tally and exit non-zero on any failure. */
const finish = () => {
  console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'}  —  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

export {
  now, timers, flush, advance, revoked, net, audios, audible, audioDefaults, ok, eq, reset,
  createTtsClient, createPlayer, PAIR, mkSentences, live, alive, finish,
};

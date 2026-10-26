// ── ttsclient.js ─────────────────────────────────────────
// Bounded, cancellable TTS fetching with an LRU blob cache.
// Fixes D2 (unbounded uncancellable prefetch exhausts the WKWebView
// connection pool), D6 (blob leak) and D7 (cache key ignored voice/speed).
// Dependency-free on purpose: everything arrives through the factory options.

// ── Constants ────────────────────────────────────────────
const WINDOW_BEHIND        = 2;    // keep prefetches this far behind the centre
const WINDOW_AHEAD_EXTRA   = 4;    // …and maxInflight + this far ahead
const RETRY_BACKOFF_MS     = 300;
const RETRY_STATUS_MIN     = 500;  // retry 5xx only
const BUSY_STATUS          = 503;  // the engine refused: nothing failed, try again later
const BUSY_DEFAULT_WAIT_MS = 1000; // when Retry-After is missing or unparseable
const BUSY_WAIT_MAX_MS     = 5000; // cap on one Retry-After, whatever the header says
const BUSY_BUDGET_MS       = 10000; // total busy waiting per request, then it is a failure
const PRIORITY_FOREGROUND  = 0;
const PRIORITY_PREFETCH    = 1;
const SPEED_PRECISION      = 2;
const DEFAULT_MAX_QUEUED   = 8;    // pending tasks; beyond this the far ones are dropped
/** R6: the voice is not on the server's machine (macOS removed Siri's). Never retried. */
export const VOICE_UNAVAILABLE_STATUS = 424;

/**
 * Build an Error carrying the `.kind` discriminator callers switch on.
 * @param {string} message
 * @param {'abort'|'timeout'|'http'|'network'} kind
 * @param {number} [status] HTTP status, when kind === 'http'.
 * @returns {Error & {kind: string, status?: number}}
 */
function ttsError(message, kind, status) {
  const err = new Error(message);
  err.kind = kind;
  if (status !== undefined) err.status = status;
  return err;
}

/**
 * Retry-After in ms, clamped to [RETRY_BACKOFF_MS, BUSY_WAIT_MAX_MS]. Delta-seconds
 * only — the server never sends an HTTP-date, so one falls back to the default.
 * @param {Response} res
 * @returns {number}
 */
function retryAfterMs(res) {
  const secs = Number.parseFloat(res.headers?.get?.('Retry-After'));
  const ms = Number.isFinite(secs) ? secs * 1000 : BUSY_DEFAULT_WAIT_MS;
  return Math.min(Math.max(ms, RETRY_BACKOFF_MS), BUSY_WAIT_MAX_MS);
}

/** @param {Response} res a non-ok reply @returns {Error} kind 'http', + retryAfterMs on a 503 */
function httpError(res) {
  const err = ttsError(`TTS request failed (${res.status})`, 'http', res.status);
  if (res.status === BUSY_STATUS) err.retryAfterMs = retryAfterMs(res);
  return err;
}

const noop = () => {};

/**
 * Create a TTS client: a FIFO-queued, abortable fetcher in front of an LRU
 * cache of object URLs.
 *
 * @param {object}  [options]
 * @param {string}  [options.endpoint='/api/tts'] Synthesis endpoint.
 * @param {number}  [options.maxInflight=2]  Hard cap on concurrent requests,
 *                                           foreground and prefetch combined.
 * @param {number}  [options.cacheSize=24]   Max cached blob URLs.
 * @param {number}  [options.timeoutMs=30000] Per-attempt hard deadline.
 * @param {number}  [options.retries=1]      Retries on network error / 5xx.
 * @returns {{get: Function, peek: Function, prefetch: Function, setWindow: Function,
 *            setCurrent: Function, drop: Function, clear: Function,
 *            abortAll: Function, stats: Function, readyAhead: Function, isCached: Function, isPending: Function, onChange: Function}}
 */
export function createTtsClient(options = {}) {
  const {
    endpoint = '/api/tts',
    maxInflight = 2,
    cacheSize = 24,
    timeoutMs = 30000,
    retries = 1,
    maxQueued = DEFAULT_MAX_QUEUED,
    shapeOf = () => ({}),   // V1: extra /api/tts params (voiceshape.shapeParams); part of the cache key
  } = options;

  const cache   = new Map();   // cacheKey → blobUrl, insertion order == LRU order
  const tasks   = new Map();   // cacheKey → task (queued OR running)
  const queue   = [];          // tasks not yet started, FIFO within priority
  const running = new Set();   // tasks with a live request
  const counts  = { hits: 0, misses: 0, errors: 0, aborts: 0 };
  const listeners = new Set(); // onChange subscribers (N1 buffer meter)

  let currentKey = null;       // pinned sentence index — never revoked (D5)
  let lastVoice  = null;
  let lastSpeed  = null;

  /**
   * Tell subscribers what may have changed the buffer. On the hot path, so it is a
   * loop over (usually one) listener; a throwing listener must not break playback.
   * @param {'queue'|'store'|'fail'|'cancel'|'clear'|'drop'|'current'} kind
   */
  function notify(kind) {
    for (const fn of listeners) {
      try { fn(kind); } catch (err) { console.warn('ttsclient onChange listener failed', err); }
    }
  }

  // ── Cache ──────────────────────────────────────────────
  const shapeKeyOf = (shape) => Object.entries(shape).map(([k, v]) => `|${k}${v}`).join('');
  const cacheKeyOf = (key, voice, speed, shape = shapeOf()) =>
    `${key}|${voice}|${Number(speed).toFixed(SPEED_PRECISION)}${shapeKeyOf(shape)}`;

  /** A cache entry is pinned while its sentence index is the current one. */
  const isPinned = (cacheKey) =>
    currentKey !== null && cacheKey.startsWith(`${currentKey}|`);

  function touch(cacheKey) {
    const url = cache.get(cacheKey);
    cache.delete(cacheKey);
    cache.set(cacheKey, url);
    return url;
  }

  function evict() {
    for (const k of [...cache.keys()]) {
      if (cache.size <= cacheSize) return;
      if (isPinned(k)) continue;
      URL.revokeObjectURL(cache.get(k));
      cache.delete(k);
    }
  }

  function store(cacheKey, url) {
    cache.set(cacheKey, url);
    evict();
  }

  // ── Queue ──────────────────────────────────────────────
  function enqueue(task) {
    if (task.priority !== PRIORITY_FOREGROUND) {
      queue.push(task);
    } else {
      const at = queue.findIndex((t) => t.priority !== PRIORITY_FOREGROUND);
      if (at === -1) queue.push(task);
      else queue.splice(at, 0, task);
    }
    trim();
    drain();
    notify('queue');
  }

  /**
   * M13: bound the pending queue. Work furthest from the head is the least
   * likely to be listened to, so it is the first to go; foreground tasks —
   * always at the head — are never dropped.
   */
  function trim() {
    for (let at = queue.length - 1; at >= 0 && queue.length > maxQueued; at -= 1) {
      if (queue[at].priority === PRIORITY_FOREGROUND) continue;
      cancel(queue[at]);   // splices it out of the queue and rejects its promise
    }
  }

  function promote(task) {
    if (task.priority === PRIORITY_FOREGROUND) return;
    task.priority = PRIORITY_FOREGROUND;
    const at = queue.indexOf(task);
    if (at === -1) return;           // already running — nothing to reorder
    queue.splice(at, 1);
    enqueue(task);
  }

  function drain() {
    while (running.size < maxInflight && queue.length > 0) {
      run(queue.shift());
    }
  }

  // ── Requests ───────────────────────────────────────────
  function urlFor(task) {
    const q = new URLSearchParams({
      text: task.text,
      voice: String(task.voice),
      speed: String(task.speed),
      ...(task.pause ? { pause: task.pause } : {}),   // C1: the beat after it; absent → server default
      ...task.shape,                                   // V1: pitch/expr; absent → neutral
    });
    return `${endpoint}?${q.toString()}`;
  }

  function classify(err, task) {
    if (err && err.kind) return err;
    const aborted = err && (err.name === 'AbortError' || err.kind === 'abort');
    if (task.timedOut) return ttsError(`TTS timed out after ${timeoutMs}ms`, 'timeout');
    if (aborted) return ttsError('TTS request aborted', 'abort');
    return ttsError(`TTS network error: ${(err && err.message) || err}`, 'network');
  }

  async function requestOnce(task) {
    const controller = new AbortController();
    task.controller = controller;
    task.timedOut = false;
    const timer = setTimeout(() => {
      task.timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetch(urlFor(task), { signal: controller.signal });
      if (!res.ok) throw httpError(res);
      return URL.createObjectURL(await res.blob());
    } catch (err) {
      throw classify(err, task);
    } finally {
      clearTimeout(timer);
      task.controller = null;
    }
  }

  const isRetryable = (err) =>
    err.kind === 'network' || (err.kind === 'http' && err.status >= RETRY_STATUS_MIN);

  /**
   * A12: how long to wait out a busy reply, or 0 when it counts as an ordinary
   * failure — it is not for the sentence being read (a prefetch or an abandoned
   * jump must free its slot, not sit on it), or the busy budget is spent.
   */
  function busyWaitMs(err, task, waited) {
    if (err.status !== BUSY_STATUS || task.key !== currentKey) return 0;
    return waited + err.retryAfterMs <= BUSY_BUDGET_MS ? err.retryAfterMs : 0;
  }

  /**
   * A wait that still holds the task's `running` slot, so it must end the moment
   * the task stops mattering: `cancel()` wakes any wait, `setCurrent()` a busy one
   * for another sentence. Otherwise an abandoned jump starves the next (A12).
   */
  function sleep(task, ms, isBusy) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        task.wake = null;
        task.isBusyWait = false;
        resolve();
      };
      const timer = setTimeout(wake, ms);
      task.wake = wake;
      task.isBusyWait = isBusy;
    });
  }

  async function attempt(task) {
    let busyWaited = 0;
    for (let n = 0; ;) {
      try {
        return await requestOnce(task);
      } catch (err) {
        if (task.dropped) throw ttsError('TTS request aborted', 'abort');
        const busyMs = busyWaitMs(err, task, busyWaited);
        if (busyMs > 0) busyWaited += busyMs;          // not a failure: no retry used
        else if (n >= retries || !isRetryable(err)) throw err;
        else n += 1;
        await sleep(task, busyMs || RETRY_BACKOFF_MS, busyMs > 0);
        if (task.dropped) throw ttsError('TTS request aborted', 'abort');
        if (busyMs > 0 && task.key !== currentKey) throw err;   // abandoned: free the slot
      }
    }
  }

  async function run(task) {
    running.add(task);
    let stored = false;
    try {
      const url = await attempt(task);
      store(task.cacheKey, url);
      stored = true;
      task.resolve(url);
    } catch (err) {
      if (err.kind === 'abort' || err.kind === 'timeout') counts.aborts += 1;
      else counts.errors += 1;
      task.reject(err);
    } finally {
      running.delete(task);
      if (tasks.get(task.cacheKey) === task) tasks.delete(task.cacheKey);
      drain();
      notify(stored ? 'store' : 'fail');
    }
  }

  function createTask(key, text, voice, speed, priority, pause) {
    const shape = shapeOf();
    const task = {
      key, text, voice, speed, priority, pause, shape,
      cacheKey: cacheKeyOf(key, voice, speed, shape),
      controller: null, timedOut: false, dropped: false, wake: null, isBusyWait: false,
    };
    task.promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    tasks.set(task.cacheKey, task);
    return task;
  }

  function cancel(task) {
    task.dropped = true;
    // Unregister immediately: a cancelled request must never be joined by a
    // later get() (that is how a full recovery would inherit the dead socket).
    if (tasks.get(task.cacheKey) === task) tasks.delete(task.cacheKey);
    const at = queue.indexOf(task);
    if (at !== -1) {
      queue.splice(at, 1);
      counts.aborts += 1;
      task.reject(ttsError('TTS request aborted', 'abort'));
    } else {
      if (task.controller) task.controller.abort();
      if (task.wake) task.wake();
    }
    notify('cancel');
  }

  // ── Public API ─────────────────────────────────────────
  /**
   * Fetch (or join an in-flight fetch of) one sentence's audio.
   * Jumps ahead of queued prefetches. Rejects with `.kind` on failure.
   * @param {number} key Sentence index.
   * @param {string} text Text to synthesise.
   * @param {string} voice
   * @param {number} speed
   * @param {string} [pause] Beat after the sentence (cadence.js PAUSE); omitted → server default.
   * @returns {Promise<string>} object URL
   */
  function get(key, text, voice, speed, pause) {
    lastVoice = voice;
    lastSpeed = speed;
    const cacheKey = cacheKeyOf(key, voice, speed);
    if (cache.has(cacheKey)) {
      counts.hits += 1;
      return Promise.resolve(touch(cacheKey));
    }
    counts.misses += 1;
    const existing = tasks.get(cacheKey);
    if (existing) {                       // coalesce: one request, one promise
      promote(existing);
      return existing.promise;
    }
    return enqueueAnd(createTask(key, text, voice, speed, PRIORITY_FOREGROUND, pause));
  }

  function enqueueAnd(task) {
    enqueue(task);
    return task.promise;
  }

  /**
   * A promise for one sentence's audio *without* promoting it to the foreground.
   * Used to arm the player's second `<audio>` buffer (J5): the caller wants the url
   * as soon as it exists, but the request must stay prefetch-priority so a user who
   * jumps away still has it cancelled by `setWindow` rather than stranding a socket (D2).
   * @param {number} key Sentence index.
   * @param {string} text
   * @param {string} voice
   * @param {number} speed
   * @param {string} [pause] as `get()`
   * @returns {Promise<string>} object URL; rejects with `.kind` like `get()`.
   */
  function peek(key, text, voice, speed, pause) {
    const cacheKey = cacheKeyOf(key, voice, speed);
    if (cache.has(cacheKey)) return Promise.resolve(touch(cacheKey));
    const existing = tasks.get(cacheKey);
    if (existing) return existing.promise;
    return enqueueAnd(createTask(key, text, voice, speed, PRIORITY_PREFETCH, pause));
  }

  /**
   * Queue best-effort background synthesis. Never awaited, never throws.
   * Entries inherit voice/speed from the last `get()` unless they carry
   * their own; an entry with neither is skipped rather than mis-keyed (D7).
   * @param {Array<{key: number, text: string, voice?: string, speed?: number, pause?: string}>} entries
   */
  function prefetch(entries) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'number' || !entry.text) continue;
      const voice = entry.voice !== undefined ? entry.voice : lastVoice;
      const speed = entry.speed !== undefined ? entry.speed : lastSpeed;
      if (voice === null || speed === null) continue;
      const cacheKey = cacheKeyOf(entry.key, voice, speed);
      if (cache.has(cacheKey) || tasks.has(cacheKey)) continue;
      const task = createTask(entry.key, entry.text, voice, speed, PRIORITY_PREFETCH, entry.pause);
      task.promise.catch(noop);           // best effort: never an unhandled rejection
      enqueue(task);
    }
  }

  /**
   * Abort and forget prefetches whose key falls outside
   * `[center - 2, center + maxInflight + 4]`. Foreground work is untouched.
   * @param {number} centerKey
   */
  function setWindow(centerKey) {
    const lo = centerKey - WINDOW_BEHIND;
    const hi = centerKey + maxInflight + WINDOW_AHEAD_EXTRA;
    for (const task of [...tasks.values()]) {
      if (task.priority === PRIORITY_FOREGROUND) continue;
      if (task.key >= lo && task.key <= hi) continue;
      cancel(task);
    }
  }

  /**
   * Pin one sentence index: its cached blobs are never revoked by eviction,
   * so the URL assigned to a playing `<audio>` stays alive (D5).
   * `drop()` and `clear()` deliberately override the pin.
   * @param {number|null} key
   */
  function setCurrent(key) {
    currentKey = key;
    for (const task of [...running]) {
      if (task.isBusyWait && task.key !== key) task.wake();
    }
    notify('current');
  }

  /**
   * Forget one sentence entirely: revoke its blobs (pinned or not) and cancel
   * any queued/in-flight work for it. Used by the full recovery path.
   * @param {number} key
   */
  function drop(key) {
    const prefix = `${key}|`;
    for (const [cacheKey, url] of [...cache.entries()]) {
      if (!cacheKey.startsWith(prefix)) continue;
      URL.revokeObjectURL(url);
      cache.delete(cacheKey);
    }
    for (const task of [...tasks.values()]) {
      if (task.key === key) cancel(task);
    }
    notify('drop');
  }

  /** Revoke and forget every cached blob. In-flight work is left alone. */
  function clear() {
    for (const url of cache.values()) URL.revokeObjectURL(url);
    cache.clear();
    notify('clear');
  }

  /** Cancel everything in flight and everything queued. Keeps the cache. */
  function abortAll() {
    for (const task of [...queue]) cancel(task);
    queue.length = 0;
    for (const task of [...running]) cancel(task);
  }

  /**
   * @returns {{inflight: number, queued: number, cached: number, hits: number,
   *            misses: number, errors: number, aborts: number}}
   */
  function stats() {
    return {
      inflight: running.size,
      queued: queue.length,
      cached: cache.size,
      hits: counts.hits,
      misses: counts.misses,
      errors: counts.errors,
      aborts: counts.aborts,
    };
  }

  /**
   * N1: how many sentences straight after `from` are already cached for this
   * voice/speed — the run stops at the first gap. Read-only: no LRU touch, no hit.
   * @param {number} from Cursor sentence index (not counted).
   * @param {number} n    How far ahead to look.
   * @param {string} voice
   * @param {number} speed
   * @returns {number} 0..n
   */
  function readyAhead(from, n, voice, speed) {
    let ready = 0;
    while (ready < n && cache.has(cacheKeyOf(from + ready + 1, voice, speed))) ready += 1;
    return ready;
  }

  /**
   * Whether one sentence's audio is cached, so its object URL is still alive. Read-only.
   * @param {number} key
   * @param {string} voice
   * @param {number} speed
   * @returns {boolean}
   */
  function isCached(key, voice, speed) {
    return cache.has(cacheKeyOf(key, voice, speed));
  }

  /**
   * Whether one sentence's audio is queued or being synthesised (F2: the bar sweeps while
   * the sentence at the cursor is). Read-only.
   * @param {number} key
   * @param {string} voice
   * @param {number} speed
   * @returns {boolean}
   */
  function isPending(key, voice, speed) {
    return tasks.has(cacheKeyOf(key, voice, speed));
  }

  /**
   * Subscribe to buffer changes: work queued, stored or failed, cancelled, the
   * cache cleared or a sentence dropped, the cursor moved. Get the kind, not data.
   * @param {(kind: string) => void} fn
   * @returns {() => void} unsubscribe
   */
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { get, peek, prefetch, setWindow, setCurrent, drop, clear, abortAll, stats, readyAhead, isCached, isPending, onChange };
}

// Harness for U26: request() must abort on its deadline OR the caller's signal.
// Run: node tests/js/api.test.mjs
//
// The old request() spread `{...rest, signal: controller.signal}`, so a caller's
// signal was silently overwritten: cancelling left the fetch (and the server) running.
// No network: a fake fetch observes the signal it is handed, like the real one.

import * as api from '../../static/js/api.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

/** A fetch that settles only when told to, or rejects with AbortError when its signal aborts. */
function fakeFetch() {
    const calls = [];
    globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
        const call = { url, signal: init.signal, resolve };
        calls.push(call);
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (init.signal?.aborted) return abort();
        init.signal?.addEventListener('abort', abort, { once: true });
    });
    return calls;
}
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

/** Replaces setTimeout so the deadline fires only when `fire()` is called. */
function fakeTimers() {
    const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
    const pending = new Map();
    let next = 1;
    globalThis.setTimeout = (fn) => { pending.set(next, fn); return next++; };
    globalThis.clearTimeout = (id) => { pending.delete(id); };
    return {
        fire() { const fns = [...pending.values()]; pending.clear(); fns.forEach((fn) => fn()); },
        get size() { return pending.size; },
        restore() { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; },
    };
}

/** Counts listeners added to / removed from a signal. */
function countedSignal(controller) {
    const s = controller.signal;
    const counts = { added: 0, removed: 0 };
    const add = s.addEventListener.bind(s), remove = s.removeEventListener.bind(s);
    s.addEventListener = (...a) => { if (a[0] === 'abort') counts.added++; return add(...a); };
    s.removeEventListener = (...a) => { if (a[0] === 'abort') counts.removed++; return remove(...a); };
    return counts;
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }));
/** Old code never settles on a caller abort: give up after HUNG_MS rather than hang. */
const HUNG_MS = 300;
const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ e: { kind: 'hung' } }), HUNG_MS))]);

// ── 1. The caller's abort cancels the in-flight fetch ────────────────────────
{
    const calls = fakeFetch();
    const caller = new AbortController();
    const out = settle(api.buildScript({ pages: [] }, { signal: caller.signal }));
    await tick();
    ok('fetch was called once', calls.length === 1, `calls=${calls.length}`);
    caller.abort();
    const { e } = await within(out);
    ok('fetch saw its signal abort', calls[0]?.signal?.aborted === true);
    ok('caller abort rejects with kind "abort"', e?.kind === 'abort', `kind=${e?.kind}`);
    ok('caller abort keeps name AbortError (playback.js checks it)', e?.name === 'AbortError', `name=${e?.name}`);
}

// ── 2. A caller signal already aborted before the call ───────────────────────
{
    const calls = fakeFetch();
    const caller = new AbortController();
    caller.abort();
    const { e } = await within(settle(api.buildScript({ pages: [] }, { signal: caller.signal })));
    ok('pre-aborted: rejects with kind "abort"', e?.kind === 'abort', `kind=${e?.kind}`);
    ok('pre-aborted: no live request reaches the server',
        calls.every((c) => c.signal?.aborted === true), `calls=${calls.length}`);
}

// ── 3. The deadline still fires with no caller signal ────────────────────────
{
    const calls = fakeFetch();
    const timers = fakeTimers();
    try {
        const out = settle(api.health());
        await tick();
        ok('deadline armed', timers.size === 1, `timers=${timers.size}`);
        timers.fire();
        const { e } = await out;
        ok('deadline aborted the fetch', calls[0]?.signal?.aborted === true);
        ok('deadline rejects with kind "timeout"', e?.kind === 'timeout', `kind=${e?.kind}`);
        ok('timeout message names the url', /\/api\/health timed out/.test(e?.message || ''), e?.message);
    } finally {
        timers.restore();
    }
}

// ── 4. The listener is removed afterwards, so nothing leaks ──────────────────
{
    const calls = fakeFetch();
    const caller = new AbortController();
    const counts = countedSignal(caller);
    const out = settle(api.buildScript({ pages: [] }, { signal: caller.signal }));
    await tick();
    calls[0].resolve(okResponse({ sentences: [] }));
    const { v, e } = await out;
    ok('success resolves the body', Array.isArray(v?.sentences), String(e));
    ok('a listener was attached to the caller signal', counts.added === 1, `added=${counts.added}`);
    ok('and removed once the request settled', counts.removed === counts.added, `removed=${counts.removed}`);
    caller.abort();
    ok('a later caller abort does not reach the finished fetch', calls[0].signal?.aborted === false);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

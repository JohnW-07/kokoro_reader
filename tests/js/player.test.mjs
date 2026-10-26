// Throwaway verification harness for static/js/ttsclient.js + playback.js.
// Fakes live in playerfakes.mjs. Run: node player.test.mjs
import {
  now, timers, flush, advance, revoked, net, audios, audible, audioDefaults, ok, eq, reset,
  createTtsClient, createPlayer, PAIR, mkSentences, live, alive, finish,
} from './playerfakes.mjs';

// ── T1 concurrency cap ───────────────────────────────────
console.log('\nT1  concurrency never exceeds maxInflight');
{
  reset('ok', 100);
  const tts = createTtsClient({ maxInflight: 2 });
  const p = [0, 1, 2, 3, 4, 5].map((k) => tts.get(k, `s${k}`, 'af', 1));
  await flush();
  eq(net.peak, 2, 'peak concurrent fetches with 6 simultaneous get()');
  await advance(1000);
  const urls = await Promise.all(p);
  eq(urls.length, 6, 'all six resolved');
  eq(net.peak, 2, 'peak stayed at 2 across the whole drain');
  eq(tts.stats().inflight, 0, 'inflight drains to 0');
  eq(net.calls.length, 6, 'exactly six requests issued');
}

// ── T2 timeout ───────────────────────────────────────────
console.log('\nT2  timeout aborts the request and rejects with kind:timeout');
{
  reset('hang');
  const tts = createTtsClient({ maxInflight: 2, timeoutMs: 1000 });
  let err = null;
  tts.get(0, 's0', 'af', 1).catch((e) => { err = e; });
  await advance(999);
  eq(err, null, 'still pending just before the deadline');
  await advance(2);
  ok(err instanceof Error, 'rejected with an Error');
  eq(err && err.kind, 'timeout', 'error.kind');
  eq(net.calls[0].aborted, true, 'underlying fetch received abort()');
  eq(tts.stats().inflight, 0, 'no leaked in-flight slot');
  eq(tts.stats().aborts, 1, 'aborts counter');
}

// ── T3 coalescing ────────────────────────────────────────
console.log('\nT3  two simultaneous get(5) issue ONE request and share a promise');
{
  reset('ok', 100);
  const tts = createTtsClient({ maxInflight: 2 });
  const a = tts.get(5, 's5', 'af', 1);
  const b = tts.get(5, 's5', 'af', 1);
  ok(a === b, 'same promise identity returned');
  await advance(500);
  eq(net.calls.length, 1, 'exactly one network request');
  eq(await a, await b, 'both resolve to the same blob url');
}

// ── T4 LRU eviction + pinning ────────────────────────────
console.log('\nT4  LRU revokes exactly the evicted urls, never the pinned one');
{
  reset('ok', 10);
  const tts = createTtsClient({ maxInflight: 1, cacheSize: 3 });
  tts.setCurrent(0);
  const urls = {};
  for (const k of [0, 1, 2, 3, 4]) {
    const p = tts.get(k, `s${k}`, 'af', 1);
    await advance(50);
    urls[k] = await p;
  }
  eq(revoked.length, 2, 'two evictions');
  eq(revoked[0], urls[1], 'first revoked url is s1 (oldest unpinned)');
  eq(revoked[1], urls[2], 'second revoked url is s2');
  ok(!revoked.includes(urls[0]), 'pinned current blob never revoked');
  eq(tts.stats().cached, 3, 'cache capped at 3');
  const again = await tts.get(0, 's0', 'af', 1);
  eq(again, urls[0], 'pinned entry still served from cache');
  eq(tts.stats().hits, 1, 'cache hit counted');
  const other = tts.get(0, 's0', 'am', 1);   // D7: different voice != cache hit
  await advance(50);
  ok((await other) !== urls[0], 'different voice is a different cache key (D7)');
}

// ── T5 setWindow drops distant prefetches ────────────────
console.log('\nT5  setWindow aborts distant prefetches, queued and in flight');
{
  reset('hang');
  const tts = createTtsClient({ maxInflight: 2 });
  tts.prefetch([20, 21, 22, 23, 24, 25].map((k) => ({ key: k, text: `s${k}`, voice: 'af', speed: 1 })));
  await flush();
  eq(tts.stats().inflight, 2, 'two prefetches started');
  eq(tts.stats().queued, 4, 'four prefetches queued');
  tts.setWindow(0);   // window is [-2 .. 0+2+4=6]
  await flush();
  eq(tts.stats().queued, 0, 'queued prefetches outside the window dropped');
  eq(tts.stats().inflight, 0, 'in-flight prefetches outside the window aborted');
  eq(net.calls.filter((c) => c.aborted).length, 2, 'both open sockets actually abort()ed');
  eq(tts.stats().aborts, 6, 'all six counted as aborts');
  tts.prefetch([{ key: 3, text: 's3', voice: 'af', speed: 1 }]);
  await flush();
  tts.setWindow(0);
  await flush();
  eq(tts.stats().inflight, 1, 'a prefetch inside the window survives setWindow');
  tts.abortAll();
  await flush();
  eq(tts.stats().inflight, 0, 'abortAll clears everything in flight');
}

// ── T6 epoch guard ───────────────────────────────────────
console.log('\nT6  interleaved play(2) during play(1) leaves the player on index 2 only');
{
  reset('hang');
  const tts = createTtsClient({ maxInflight: 4, timeoutMs: 60000 });
  const statuses = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(6), getVoice: () => 'af', getSpeed: () => 1,
    onStatus: (s) => statuses.push(s), onIndex: () => {},
  });
  player.play(1);
  await flush();
  const call1 = net.calls.find((c) => c.text === 's1');
  player.play(2);
  await flush();
  const call2 = net.calls.find((c) => c.text === 's2');
  call2.resolve({ ok: true, status: 200, blob: async () => ({ tag: 's2' }) });
  await flush();
  eq(player.state().index, 2, 'index after interleave');
  const audio = audios[0];
  ok(audio.srcHistory.every((s) => s.startsWith('blob:s2')), `only s2 ever assigned to the element (${audio.srcHistory})`);
  // now let the stale request finish late — it must not touch the element
  call1.resolve({ ok: true, status: 200, blob: async () => ({ tag: 's1' }) });
  await flush();
  eq(player.state().index, 2, 'late s1 response ignored');
  ok(audio.srcHistory.every((s) => s.startsWith('blob:s2')), 'stale continuation never drove the element');
  eq(player.state().isLoading, false, 'isLoading cleared');
  eq(statuses.filter((s) => s.state === 'error').length, 0, 'no AbortError surfaced to the user');
  player.destroy();
}

// ── T7 stall ladder ──────────────────────────────────────
console.log('\nT7  stall escalates soft -> hard -> full and playback resumes');
{
  reset('ok', 50);
  const tts = createTtsClient({ maxInflight: 2 });
  const statuses = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(6), getVoice: () => 'af', getSpeed: () => 1,
    onStatus: (s) => statuses.push(s), stallSeconds: 6,
  });
  player.play(0);
  await advance(200);
  eq(player.state().isPlaying, true, 'playing after load');
  const a0 = audios[0];
  a0.readyState = 2; audioDefaults.readyState = 2;   // wedged pipeline, rebuilds inherit it
  a0.currentTime = 1; a0.paused = false;
  await advance(8000);
  eq(a0.loadCalls, 1, 'soft: audio.load() called');
  eq(player.state().recoveries, 1, 'one recovery so far');
  eq(audios.length, PAIR, 'soft did not rebuild the element');
  await advance(8000);
  eq(audios.length, PAIR + 1, 'hard: a fresh <audio> element was built');
  ok(audios[PAIR].src.startsWith('blob:s0'), 'hard: src restored on the new element');
  eq(player.state().recoveries, 2, 'two recoveries');
  const callsBefore = net.calls.length;
  await advance(8000);
  eq(player.state().recoveries, 3, 'three recoveries');
  ok(net.calls.length > callsBefore, 'full: sentence re-synthesised from scratch');
  eq(revoked.filter((u) => u.startsWith('blob:s0')).length >= 1, true, 'full: stale blob dropped');
  await advance(500);
  const live = audios[audios.length - 1];
  live.readyState = 4; live.currentTime = 2; live.paused = false;
  eq(player.state().isPlaying, true, 'playback resumed after full recovery');
  const levels = statuses.filter((s) => s.state === 'recovering').map((s) => s.message);
  eq(levels.length, 3, 'three recovering statuses reported to the UI');
  console.log('        ladder:', levels.map((m) => m.split('—').pop().trim()).join(' -> '));
  await advance(20000);
  eq(player.state().recoveries, 3, 'ladder does not re-fire once playback advances');
  player.destroy();
}

// ── T8 headline: wedged fetch leaves toggle() responsive ──
console.log('\nT8  HEADLINE: play() whose fetch never settles still leaves toggle() responsive');
{
  reset('hang');
  const tts = createTtsClient({ maxInflight: 2, timeoutMs: 30000 });
  const statuses = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(6), getVoice: () => 'af', getSpeed: () => 1,
    onStatus: (s) => statuses.push(s),
  });
  player.play(0);
  await flush();
  eq(player.state().isLoading, true, 'stuck in loading');
  await advance(5000);
  player.toggle();
  await flush();
  eq(player.state().recoveries, 0, 'toggle before the wedge timeout does not recover');
  await advance(8000);          // 13 s of isLoading > WEDGE_MS
  net.mode = 'ok'; net.latency = 50;
  player.toggle();              // the click that used to be dead forever
  await advance(500);
  eq(player.state().recoveries, 1, 'toggle past the wedge timeout ran recover()');
  eq(player.state().isLoading, false, 'isLoading released');
  eq(player.state().isPlaying, true, 'audio is playing again');
  eq(net.calls[0].aborted, true, 'the wedged socket was aborted');
  ok(statuses.some((s) => s.state === 'recovering'), 'recovery reported to the user');
  player.toggle();
  eq(player.state().isPlaying, false, 'toggle now pauses normally');
  player.destroy();
}

// ── T9 untrusted callbacks + skip-after-two-failures ─────
console.log('\nT9  throwing callbacks cannot wedge the player; a bad sentence is skipped');
{
  reset('error');
  const tts = createTtsClient({ maxInflight: 2, retries: 0 });
  const statuses = [];
  let firstOnly = true;
  const player = createPlayer({
    tts,
    getSentences: () => mkSentences(4),
    getVoice: () => 'af', getSpeed: () => 1,
    onIndex: () => { throw new Error('UI layer blew up'); },
    onStatus: (s) => { statuses.push(s); if (firstOnly) { firstOnly = false; throw new Error('status handler blew up'); } },
  });
  player.play(0);
  await advance(300);
  net.mode = 'ok';              // sentence 1 will synthesise fine
  await advance(500);
  eq(player.state().skipped, 1, 'sentence 0 skipped after two synth failures');
  eq(player.state().index, 1, 'moved on to sentence 1');
  eq(player.state().isPlaying, true, 'session continues');
  eq(player.state().isLoading, false, 'isLoading cleared despite throwing callbacks');
  ok(statuses.some((s) => s.level === 'warn' && /Skipped/.test(s.message)), 'skip reported at level warn');
  player.destroy();
}

// ── T10 media error -> hard path; destroy() is clean ─────
console.log('\nT10 MEDIA_ELEMENT_ERROR triggers the hard path; destroy() leaves nothing behind');
{
  reset('ok', 50);
  const tts = createTtsClient({ maxInflight: 2 });
  const statuses = [];
  const player = createPlayer({ tts, getSentences: () => mkSentences(3), getVoice: () => 'af', getSpeed: () => 1, onStatus: (s) => statuses.push(s) });
  player.play(0);
  await advance(200);
  const a0 = audios[0];
  a0.error = { code: 4 };
  a0.dispatch('error');
  await advance(100);
  eq(audios.length, PAIR + 1, 'element rebuilt (hard path)');
  ok(statuses.some((s) => s.state === 'recovering' && /MEDIA_ELEMENT_ERROR/.test(s.message)), 'media error reported');
  const timersBefore = timers.size;
  player.destroy();
  await flush();
  ok(timers.size < timersBefore, 'watchdog ticker cleared');
  eq([...audios[audios.length - 1].listeners.values()].flat().length, 0, 'all media listeners removed');
  eq(tts.stats().inflight, 0, 'no in-flight requests survive destroy()');
}

// ── T11 retry policy ─────────────────────────────────────
console.log('\nT11 one retry on 5xx/network, never on an abort');
{
  reset('ok', 50, 503);
  const tts = createTtsClient({ maxInflight: 2, retries: 1, timeoutMs: 30000 });
  const p = tts.get(0, 's0', 'af', 1);
  await advance(100);
  eq(net.calls.length, 1, 'first attempt made');
  net.status = 200;
  await advance(500);              // backoff 300ms then retry
  eq(net.calls.length, 2, 'retried once after a 503');
  ok((await p).startsWith('blob:s0'), 'retry succeeded');
  reset('ok', 50, 500);
  const tts2 = createTtsClient({ maxInflight: 2, retries: 1 });
  let e2 = null;
  tts2.get(1, 's1', 'af', 1).catch((e) => { e2 = e; });
  await advance(2000);
  eq(net.calls.length, 2, 'exactly two attempts (1 + 1 retry)');
  eq(e2 && e2.kind, 'http', 'gives up with kind:http');
  eq(e2 && e2.status, 500, 'status carried on the error');
  reset('hang');
  const tts3 = createTtsClient({ maxInflight: 2, retries: 1, timeoutMs: 500 });
  let e3 = null;
  tts3.get(2, 's2', 'af', 1).catch((e) => { e3 = e; });
  await advance(3000);
  eq(net.calls.length, 1, 'a timeout/abort is NEVER retried');
  eq(e3 && e3.kind, 'timeout', 'kind:timeout');
  console.log('        stats:', JSON.stringify(tts3.stats()));
}

// ── T12 H2: the sentence list shrinks under the cursor ───
console.log('\nT12 HEADLINE: a Rebuild that shortens the script leaves toggle() and recover() alive');
{
  reset('ok', 50);
  const tts = createTtsClient({ maxInflight: 2 });
  const statuses = [];
  let count = 10;                       // the script the user is reading…
  const player = createPlayer({
    tts, getSentences: () => mkSentences(count), getVoice: () => 'af', getSpeed: () => 1,
    onStatus: (s) => statuses.push(s),
  });
  player.play(8);
  await advance(300);
  eq(player.state().index, 8, 'playing sentence 9 of 10');
  count = 3;                            // …Rebuild with different options: 3 sentences
  const a0 = audios[0];
  a0.ended = true; a0.paused = true;
  a0.dispatch('ended');                 // advance() runs off the end of the new list
  await advance(300);
  eq(player.state().isPlaying, false, 'playback stopped past the end of the shortened list');

  const beforeToggle = net.calls.length;
  player.toggle();
  await advance(300);
  ok(net.calls.length > beforeToggle, `toggle() issued a synthesis request (${net.calls.length - beforeToggle})`);
  eq(player.state().index, 2, 'toggle() re-anchored onto the last surviving sentence');
  eq(player.state().isPlaying, true, 'toggle() produced audible progress');

  const beforeRecover = net.calls.length;
  player.recover();
  await advance(500);
  ok(net.calls.length > beforeRecover, `recover() re-synthesised (${net.calls.length - beforeRecover})`);
  eq(player.state().isPlaying, true, 'recover() produced audible progress');
  eq(player.state().index, 2, 'recover() stayed on a valid index');
  ok(!statuses.some((s) => /\b9 \/ 3\b/.test(s.message)), 'no status claims sentence 9 of 3');
  player.destroy();
}

// ── T13 H3: speed must not be applied twice ──────────────
console.log('\nT13 speed is applied once (synthesis), not twice (synthesis x playbackRate)');
{
  reset('ok', 50);
  const tts = createTtsClient({ maxInflight: 2 });
  const player = createPlayer({
    tts, getSentences: () => mkSentences(3), getVoice: () => 'af', getSpeed: () => 2,
  });
  player.play(0);
  await advance(300);
  const q = new URL(`http://x${net.calls[0].url}`).searchParams;
  eq(q.get('speed'), '2', 'synthesis speed sent to the server');
  eq(audios[0].playbackRate, 1, 'element plays at native rate');
  eq(Number(q.get('speed')) * audios[0].playbackRate, 2, 'effective rate is 2x, not 4x');
  // and a rebuild must not reintroduce it
  audios[0].error = { code: 4 };
  audios[0].dispatch('error');
  await advance(300);
  eq(audios[audios.length - 1].playbackRate, 1, 'rebuilt element still plays at native rate');
  player.destroy();
}

// ── T14 H5: circuit breaker on the skip cascade ──────────
console.log('\nT14 a persistently failing document stops after a bounded number of skips');
{
  reset('error', 50);
  const tts = createTtsClient({ maxInflight: 2, retries: 0 });
  const statuses = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(60), getVoice: () => 'af', getSpeed: () => 1,
    onStatus: (s) => statuses.push(s),
  });
  player.play(0);
  await advance(30000);                 // long enough for the whole cascade to run
  const skips = statuses.filter((s) => /^Skipped sentence/.test(s.message)).length;
  const toasts = statuses.filter((s) => s.level === 'warn' || s.level === 'error').length;
  console.log(`        requests=${net.calls.length} skips=${skips} toasts=${toasts}`);
  ok(net.calls.length <= 12, `requests bounded (${net.calls.length}, uncapped would be 120)`);
  ok(skips <= 5, `skips bounded (${skips}, uncapped would be 60)`);
  ok(toasts <= 12, `toasts bounded (${toasts}, uncapped would be 120)`);
  eq(player.state().isPlaying, false, 'the cascade stopped instead of running to the end');
  eq(statuses.filter((s) => /circuit|stopped after/i.test(s.message)).length, 1,
     'the user is told exactly once');

  net.mode = 'ok';
  const beforeRecover = net.calls.length;
  player.recover();
  await advance(500);
  ok(net.calls.length > beforeRecover, 'recover() clears the breaker and retries');
  eq(player.state().isPlaying, true, 'playback resumes after recover()');
  player.destroy();
}

// ── T15 M13: the pending queue is bounded ────────────────
console.log('\nT15 the pending prefetch queue is capped, and never at the expense of foreground work');
{
  reset('hang');
  const MAX_QUEUED = 8;                 // mirrors DEFAULT_MAX_QUEUED in ttsclient.js
  const tts = createTtsClient({ maxInflight: 2 });
  tts.prefetch(Array.from({ length: 500 }, (_, i) => ({ key: i + 10, text: `s${i + 10}`, voice: 'af', speed: 1 })));
  await flush();
  const s = tts.stats();
  console.log(`        queued=${s.queued} inflight=${s.inflight} (uncapped would be 498)`);
  ok(s.queued <= MAX_QUEUED, `queued capped at ${MAX_QUEUED} (got ${s.queued})`);
  eq(s.inflight, 2, 'still saturating maxInflight');
  let rejected = null;
  tts.get(0, 's0', 'af', 1).catch((e) => { rejected = e; });
  await flush();
  eq(rejected, null, 'the foreground request was not dropped by the cap');
  ok(tts.stats().queued <= MAX_QUEUED, 'still capped after a foreground enqueue');
  tts.abortAll();
  await flush();
}

// ── J5: the inter-sentence gap ───────────────────────────
// Three separable costs sit between sentence N ending and N+1 being heard:
//   (a) the element's load+decode of the next blob — modelled here as LOAD_MS,
//   (b) synthesis of N+1, if prefetch has not finished it,
//   (c) lead-in/tail silence baked into the WAV itself.
// (c) is server-side and measured in tts_engine.py's comment. These harnesses
// isolate (a) and (b), which are the client's to remove.
const LOAD_MS = 120;                       // modelled element load+decode per transition
const GAP_CEILING_MS = 5;                  // a swap may cost microtasks, nothing more

/** Fire `ended` on the element that is actually audible, and time the handover. */
async function endAndTime(player) {
  const current = live();
  const spare = alive().find((a) => a !== current);
  const at = now;
  current.paused = true; current.ended = true;
  current.dispatch('ended');
  await flush();            // the handover's microtasks happen at `at`, not on a timer
  await advance(2000);
  return { gap: audible[audible.length - 1].at - at, spareReady: spare ? spare.readyState : -1 };
}

console.log('\nT16 HEADLINE (J5): the next sentence is already decoded when this one ends');
{
  reset('ok', 100);
  audioDefaults.loadMs = LOAD_MS;
  const tts = createTtsClient({ maxInflight: 2 });
  const statuses = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(8), getVoice: () => 'af', getSpeed: () => 1,
    onStatus: (s) => statuses.push(s),
  });
  player.play(0);
  await advance(2000);
  eq(player.state().isPlaying, true, 'sentence 1 playing');
  const gaps = [], readies = [];
  for (let n = 0; n < 5; n += 1) {
    const r = await endAndTime(player);
    gaps.push(r.gap); readies.push(r.spareReady);
  }
  console.log(`        gaps(ms)=${gaps.join(',')}  spare readyState at 'ended'=${readies.join(',')}`);
  ok(readies.every((r) => r >= 3),
     `the next element is loaded (readyState >= 3) when 'ended' fires (${readies})`);
  ok(Math.max(...gaps) <= GAP_CEILING_MS,
     `every handover <= ${GAP_CEILING_MS} ms (max ${Math.max(...gaps)}, single-element baseline ${LOAD_MS})`);
  eq(player.state().index, 5, 'advanced five sentences');
  eq(statuses.filter((s) => s.level === 'warn' || s.level === 'error').length, 0,
     'no warning surfaced by the double buffer');
  player.destroy();
}

console.log('\nT17 onIndex fires once per sentence, in order, never ahead of the voice');
{
  reset('ok', 100);
  audioDefaults.loadMs = LOAD_MS;
  const tts = createTtsClient({ maxInflight: 2 });
  const seen = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(6), getVoice: () => 'af', getSpeed: () => 1,
    onIndex: (i) => seen.push({ i, at: now }),
  });
  player.play(0);
  await advance(2000);
  for (let n = 0; n < 4; n += 1) await endAndTime(player);
  eq(seen.map((s) => s.i).join(','), '0,1,2,3,4', 'one onIndex per sentence, in order');
  const lag = seen.map((s, n) => audible[n].at - s.at);
  console.log(`        onIndex -> audible lag(ms)=${lag.join(',')} (lag[0] is the cold start)`);
  ok(lag.slice(1).every((d) => d >= 0 && d <= GAP_CEILING_MS),
     `every handover's highlight lands with the voice, not ahead of it (${lag})`);
  eq(seen.length, 5, 'no extra onIndex from the prefetch or preload path');
  player.destroy();
}

console.log('\nT18 transport still works mid-prefetch, and stop() leaves nothing playing');
{
  reset('ok', 100);
  audioDefaults.loadMs = LOAD_MS;
  const tts = createTtsClient({ maxInflight: 2 });
  const player = createPlayer({
    tts, getSentences: () => mkSentences(10), getVoice: () => 'af', getSpeed: () => 1,
  });
  player.play(2);
  await advance(2000);
  player.toggle();                                   // pause mid-prefetch
  eq(player.state().isPlaying, false, 'pause works while the spare is arming');
  ok(alive().every((a) => a.paused), 'nothing is playing while paused');
  player.toggle();                                   // resume
  await advance(500);
  eq(player.state().isPlaying, true, 'resume works');
  player.next();
  await advance(1000);
  eq(player.state().index, 3, 'next()');
  player.prev();
  await advance(1000);
  eq(player.state().index, 2, 'prev()');
  player.seekRelative(4);
  await advance(1000);
  eq(player.state().index, 6, 'seekRelative(4)');
  eq(live().src.startsWith('blob:s6'), true, `the audible element is s6 (${live().src})`);
  ok(alive().filter((a) => !a.paused).length === 1, 'exactly one element is audible at a time');
  player.setIndex(9);
  eq(player.state().index, 9, 'setIndex moves the cursor without playing');
  player.stop();
  await advance(1000);
  ok(alive().every((a) => a.paused), 'stop(): no orphaned element left playing');
  ok(alive().every((a) => !a.src), `stop(): no element left holding a blob (${alive().map((a) => a.src)})`);
  player.destroy();
  await flush();
  ok(audios.every((a) => [...a.listeners.values()].flat().length === 0),
     'destroy(): both elements fully unbound');
}

console.log('\nT19 a failed prefetch of N+1 does not disturb N, nor feed the H5 cascade');
{
  reset('ok', 100);
  audioDefaults.loadMs = LOAD_MS;
  net.failText = new Set(['s1']);                    // only sentence 2 cannot synthesise
  const tts = createTtsClient({ maxInflight: 2, retries: 0 });
  const statuses = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(6), getVoice: () => 'af', getSpeed: () => 1,
    onStatus: (s) => statuses.push(s),
  });
  player.play(0);
  await advance(3000);
  eq(player.state().isPlaying, true, 'sentence 1 plays through a failed prefetch of 2');
  eq(player.state().skipped, 0, 'a failed prefetch is not a skip');
  eq(statuses.filter((s) => s.level === 'error').length, 0, 'no error surfaced for a prefetch');
  const r = await endAndTime(player);
  console.log(`        handover into the unsynthesisable sentence: ${r.gap} ms`);
  eq(player.state().skipped, 1, 'sentence 2 is skipped once, by the foreground path');
  eq(player.state().index, 2, 'and the reading continues at sentence 3');
  eq(player.state().isPlaying, true, 'still playing');
  player.destroy();
}

console.log('\nT20 H2 still re-anchors, and a stale armed buffer is never resurrected');
{
  reset('ok', 100);
  audioDefaults.loadMs = LOAD_MS;
  const tts = createTtsClient({ maxInflight: 2 });
  let count = 10;
  const player = createPlayer({
    tts, getSentences: () => mkSentences(count), getVoice: () => 'af', getSpeed: () => 1,
  });
  player.play(8);
  await advance(2000);
  eq(live().src.startsWith('blob:s8'), true, 'playing sentence 9 of 10');
  count = 3;                                         // Rebuild shrinks the script
  const a0 = live();
  a0.ended = true; a0.paused = true;
  a0.dispatch('ended');
  await advance(1000);
  eq(player.state().isPlaying, false, 'stopped past the end of the shortened list');
  player.toggle();
  await advance(1000);
  eq(player.state().index, 2, 'toggle() re-anchored onto the last surviving sentence');
  eq(live().src.startsWith('blob:s2'), true, `and s2 is what is audible (${live().src})`);
  ok(!alive().some((a) => !a.paused && a.src.startsWith('blob:s9')),
     'the buffer armed with the dead sentence 10 never plays');
  player.destroy();
}

// ── W1 listening stats ───────────────────────────────────
console.log('\nW1  onListen credits only audio actually heard, and each sentence that ends');
{
  reset('ok', 100);
  const tts = createTtsClient({ maxInflight: 2 });
  const heard = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(4), getVoice: () => 'af', getSpeed: () => 1,
    onListen: (ev) => heard.push(ev),
  });
  player.play(0);
  await advance(1000);
  const a0 = live();
  [0.5, 1.0, 1.4].forEach((t) => { a0.currentTime = t; a0.dispatch('timeupdate'); });
  a0.currentTime = 30; a0.dispatch('timeupdate');      // a seek, not 28.6 s of listening
  a0.duration = 30.5; a0.ended = true; a0.paused = true;
  a0.dispatch('ended');
  await advance(1000);
  const seconds = heard.filter((e) => e.type === 'time').reduce((sum, e) => sum + e.seconds, 0);
  eq(Math.round(seconds * 10) / 10, 1.9, 'credited 1.4 s of steady play + 0.5 s to the end');
  const ends = heard.filter((e) => e.type === 'heard');
  eq(ends.length, 1, 'one sentence heard');
  eq(`${ends[0].index}/${ends[0].total}/${ends[0].sentence.text}/${ends[0].voice}`, '0/4/s0/af',
     'the heard event names the sentence, its place and the voice');
  player.destroy();
}

// ── P2 media keys (N6): external pause/play, pause during a load ──
const timeHeard = (heard) => Math.round(heard.filter((e) => e.type === 'time')
  .reduce((sum, e) => sum + e.seconds, 0) * 10) / 10;
const lastState = (statuses) => statuses[statuses.length - 1]?.state;
const countState = (statuses, state) => statuses.filter((s) => s.state === state).length;
const mkPlayer = (extra = {}) => {
  const tts = createTtsClient({ maxInflight: 2 });
  const statuses = [];
  const heard = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(4), getVoice: () => 'af', getSpeed: () => 1,
    onStatus: (s) => statuses.push(s), onListen: (ev) => heard.push(ev), ...extra,
  });
  return { player, statuses, heard, tts };
};

console.log('\nP2a HEADLINE: a pause from outside the app (F8) reports paused, and resumes in place');
{
  reset('ok', 100);
  const { player, statuses, heard } = mkPlayer();
  player.play(0);
  await advance(1000);
  const a = live();
  a.currentTime = 1.0; a.dispatch('timeupdate');
  a.currentTime = 1.6; a.pause(); a.dispatch('pause');   // the OS paused it, not the app
  eq(lastState(statuses), 'paused', 'external pause emitted paused');
  eq(player.state().isPlaying, false, 'player knows it is paused');
  eq(timeHeard(heard), 1.6, 'listening credited up to the pause point');
  const calls = net.calls.length;
  const plays = a.playCalls;
  const playing = countState(statuses, 'playing');
  player.toggle();
  a.dispatch('play');                                     // the element echoes the app's play()
  await flush();
  eq(player.state().isPlaying, true, 'toggle after an external pause resumes');
  eq(a.playCalls, plays + 1, 'the same element resumed');
  eq(net.calls.length, calls, 'no new synthesis');
  eq(countState(statuses, 'playing'), playing + 1, 'one playing status, not one per echo');
  a.pause(); a.dispatch('pause');
  a.play(); a.dispatch('play');                           // the OS resumed it
  eq(lastState(statuses), 'playing', 'external play emitted playing');
  eq(player.state().isPlaying, true, 'player knows it is playing');
  player.destroy();
}

console.log('\nP2b app-initiated pause/resume: one status each, idempotent');
{
  reset('ok', 100);
  const { player, statuses } = mkPlayer();
  player.play(0);
  await advance(1000);
  const a = live();
  player.pause();
  a.dispatch('pause');                                    // the element echoes the app's pause()
  eq(countState(statuses, 'paused'), 1, 'one paused status for an app pause');
  player.pause();
  eq(countState(statuses, 'paused'), 1, 'pause() when paused is a no-op');
  const plays = a.playCalls;
  player.resume();
  await flush();
  player.resume();
  await flush();
  eq(a.playCalls, plays + 1, 'resume() when playing is a no-op');
  eq(lastState(statuses), 'playing', 'resumed');
  player.destroy();
}

console.log('\nP2c HEADLINE: pause during a sentence load is honoured when the load completes');
{
  reset('ok', 500);
  const { player, statuses } = mkPlayer();
  player.play(0);
  await advance(100);
  eq(player.state().isLoading, true, 'loading');
  player.pause();
  eq(lastState(statuses), 'paused', 'paused reported at once');
  await advance(2000);
  eq(audible.length, 0, 'no audio started after the load completed');
  eq(player.state().isPlaying, false, 'still paused');
  eq(lastState(statuses), 'paused', 'no playing status after the load');
  player.resume();
  await advance(100);
  eq(audible.length, 1, 'resume() plays');
  eq(player.state().index, 0, 'the sentence that was loading');
  eq(lastState(statuses), 'playing', 'playing reported');
  player.destroy();
}

console.log('\nP2d toggle during a load pauses, a second toggle un-pauses');
{
  reset('ok', 500);
  const { player, statuses } = mkPlayer();
  player.play(0);
  await advance(100);
  player.toggle();
  eq(lastState(statuses), 'paused', 'first toggle paused');
  player.toggle();
  eq(lastState(statuses), 'loading', 'second toggle went back to loading');
  await advance(1000);
  eq(audible.length, 1, 'audio started once loaded');
  eq(player.state().isPlaying, true, 'playing');
  player.destroy();
}

console.log('\nP2e pause while the element is still decoding: nothing keeps playing');
{
  reset('ok', 100);
  audioDefaults.loadMs = 300;
  const { player, statuses } = mkPlayer();
  player.play(0);
  await advance(200);                                     // fetched, element decoding
  player.pause();
  await advance(1000);
  eq(player.state().isPlaying, false, 'not playing');
  eq(audios[0].paused && audios[1].paused, true, 'both elements paused');
  eq(lastState(statuses), 'paused', 'paused is the last word');
  player.destroy();
}

console.log('\nP2f the pause that precedes a natural `ended` is not a user pause');
{
  reset('ok', 100);
  const { player, statuses } = mkPlayer();
  player.play(0);
  await advance(1000);
  const a = live();
  a.ended = true; a.paused = true;
  a.dispatch('pause');
  a.dispatch('ended');
  await advance(1000);
  eq(countState(statuses, 'paused'), 0, 'no paused status at a natural end');
  eq(player.state().index, 1, 'advanced to the next sentence');
  eq(player.state().isPlaying, true, 'and kept reading');
  player.destroy();
}

console.log('\nP2g an explicit jump overrides a pending pause');
{
  reset('ok', 500);
  const { player } = mkPlayer();
  player.play(0);
  await advance(100);
  player.pause();
  player.next();
  await advance(1000);
  eq(player.state().index, 1, 'jumped');
  eq(player.state().isPlaying, true, 'the jump plays');
  player.destroy();
}

console.log('\nP2h F2: Play after a paused speed/voice change fetches the sentence anew, not the revoked blob');
{
  reset('ok', 100);
  const { player, statuses, tts } = mkPlayer();
  player.play(0);
  await advance(1000);
  const a = live();
  player.pause();
  a.dispatch('pause');
  tts.clear();                                            // settings.js clearAudio: revokes every blob, the paused one too
  const calls = net.calls.length;
  const plays = a.playCalls;
  player.toggle();
  ok(player.state().isLoading, 'it loads the sentence again');
  eq(a.playCalls, plays, 'the element holding the revoked blob is not played');
  await advance(1000);
  ok(net.calls.length > calls, 'a new synthesis for the sentence');
  eq(player.state().index, 0, 'the same sentence, from its start');
  eq(player.state().isPlaying, true, 'and it plays');
  eq(lastState(statuses), 'playing', 'status says playing');
  player.destroy();
}

finish();

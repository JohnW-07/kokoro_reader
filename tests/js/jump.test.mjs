// Jump and busy-server harness for static/js/playback.js + ttsclient.js (A3, A12).
// Split from player.test.mjs to keep both under 800 lines; same fakes. Run: node jump.test.mjs
import {
  now, advance, flush, net, audible, reset, ok, eq, createTtsClient, createPlayer,
  mkSentences, live, finish,
} from './playerfakes.mjs';
console.log('\nT21 A3: a jump to an uncached sentence silences the old one; its late `ended` never skips the target');
{
  reset('ok', 100);
  const tts = createTtsClient({ maxInflight: 2 });
  const player = createPlayer({
    tts, getSentences: () => mkSentences(10), getVoice: () => 'af', getSpeed: () => 1,
  });
  player.play(0);
  await advance(1000);
  const old = live();
  eq(old.src.startsWith('blob:s0'), true, 'reading sentence 1');
  net.latency = 2000;                                // sentence 6 is uncached and slow
  player.play(5);
  await flush();
  eq(old.paused, true, 'the old sentence stops the moment the jump starts');
  old.ended = true;
  old.dispatch('ended');                             // an `ended` already queued lands anyway
  await advance(3000);
  eq(player.state().index, 5, 'the cursor stays on the jump target');
  ok(live().src.startsWith('blob:s5'), `sentence 6 is what is audible (${live().src})`);
  ok(!audible.some((a) => a.src.startsWith('blob:s6')), 'sentence 7 was never played in its place');
  player.destroy();
}

console.log('\nT22 A12: a 503 for the current sentence waits Retry-After, bounded, and is not a failure');
{
  reset('ok', 50);
  net.retryAfter = '2';
  net.replies = new Map([['s0', [503, 503, 503]]]);
  const tts = createTtsClient({ maxInflight: 2, retries: 1 });
  tts.setCurrent(0);
  let url = null, err = null;
  tts.get(0, 's0', 'af', 1).then((u) => { url = u; }, (e) => { err = e; });
  await advance(50 + 1999);
  eq(net.calls.length, 1, 'no retry before Retry-After elapses (the old backoff was 300 ms)');
  await advance(3 * 2050);
  eq(net.calls.length, 4, 'three busy replies waited out, then a fourth attempt');
  ok(url && url.startsWith('blob:s0'), 'resolves: busy replies did not use up the one retry');
  eq(err, null, 'no error surfaced');
  eq(tts.stats().errors, 0, 'errors counter untouched');

  reset('ok', 50, 503);                              // permanently busy…
  net.retryAfter = '3600';                           // …with a hostile header
  const tts2 = createTtsClient({ maxInflight: 2, retries: 1 });
  tts2.setCurrent(1);
  let e2 = null;
  tts2.get(1, 's1', 'af', 1).catch((e) => { e2 = e; });
  await advance(15000);
  eq(e2 && e2.status, 503, 'a permanently busy server still surfaces, within 15 s (header said 1 h)');
  console.log(`        attempts before giving up: ${net.calls.length}`);
}

console.log('\nT23 A12: jumping onto a busy server is neither a skip nor a step toward the H5 stop');
{
  reset('ok', 50);
  net.retryAfter = '1';
  net.replies = new Map([['s4', [503, 503, 503, 503]]]);
  const tts = createTtsClient({ maxInflight: 2 });
  const statuses = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(10), getVoice: () => 'af', getSpeed: () => 1,
    onStatus: (s) => statuses.push(s),
  });
  player.play(4);
  await advance(8000);
  eq(player.state().index, 4, 'still on the target');
  eq(player.state().skipped, 0, 'no skip');
  ok(live().src.startsWith('blob:s4'), `the target is what is audible (${live().src})`);
  eq(statuses.filter((s) => s.level !== 'info').length, 0, 'no failure or retry toast');
  player.destroy();
}

console.log('\nT24 A12: the busy wait and its retry budget are separate, and Retry-After is capped');
{
  reset('ok', 50);
  net.retryAfter = '1';
  net.replies = new Map([['s0', [503, 503, 500]]]);  // busy twice, then one real failure
  const tts = createTtsClient({ maxInflight: 2, retries: 1 });
  tts.setCurrent(0);
  let url = null, err = null;
  tts.get(0, 's0', 'af', 1).then((u) => { url = u; }, (e) => { err = e; });
  await advance(5000);
  eq(err, null, 'the 500 still gets its one retry: busy waits spent none of it');
  ok(url && url.startsWith('blob:s0'), 'resolves on the fourth attempt');
  eq(net.calls.length, 4, 'four attempts: 503, 503, 500, 200');

  reset('ok', 50);
  net.retryAfter = '60';
  net.replies = new Map([['s1', [503]]]);
  const tts2 = createTtsClient({ maxInflight: 2, retries: 0 });
  tts2.setCurrent(1);
  let url2 = null, e2 = null;
  tts2.get(1, 's1', 'af', 1).then((u) => { url2 = u; }, (e) => { e2 = e; });
  await advance(50 + 4900);
  eq(net.calls.length, 1, 'still waiting just under the 5 s cap');
  await advance(300);
  eq(net.calls.length, 2, 'Retry-After: 60 is waited as 5 s, then retried');
  await advance(100);
  ok(url2 && url2.startsWith('blob:s1'), `and resolves (${e2 && e2.message})`);
}

console.log('\nT25 A12: an abandoned busy jump frees its slot at once (s4 busy, s5 busy, s6 free)');
{
  reset('ok', 50);
  net.retryAfter = '5';
  net.replies = new Map([['s4', Array(20).fill(503)], ['s5', Array(20).fill(503)]]);
  const tts = createTtsClient({ maxInflight: 2 });
  const player = createPlayer({
    tts, getSentences: () => mkSentences(10), getVoice: () => 'af', getSpeed: () => 1,
  });
  player.play(4);
  await advance(100);
  player.play(5);
  await advance(100);
  const jumpedAt = now;
  player.play(6);
  await advance(6000);
  const heard = audible.find((a) => a.src.startsWith('blob:s6'));
  const waited = heard ? heard.at - jumpedAt : Infinity;
  console.log(`        s6 audible ${waited} ms after the jump (5300 ms before the wakeable wait)`);
  ok(waited <= 100, `s6 is not queued behind two sleeping busy waits (${waited} ms)`);
  eq(player.state().index, 6, 'on the last target');
  eq(player.state().skipped, 0, 'abandoned jumps are not skips');
  player.destroy();
}

console.log('\nT26 A3: after a jump that fails outright, Play never resumes the abandoned sentence');
{
  reset('ok', 50);
  const tts = createTtsClient({ maxInflight: 2, retries: 0 });
  const player = createPlayer({
    tts, getSentences: () => mkSentences(10), getVoice: () => 'af', getSpeed: () => 1,
  });
  player.play(0);
  await advance(1000);
  eq(live().src.startsWith('blob:s0'), true, 'reading sentence 1');
  net.mode = 'error';
  player.play(5);                                    // s6..s10 all fail: the H5 breaker trips
  await advance(10000);
  eq(player.state().isPlaying, false, 'stopped by the breaker');
  const before = audible.length;
  player.toggle();
  await advance(1000);
  ok(!audible.slice(before).some((a) => a.src.startsWith('blob:s0')),
     `Play does not resume sentence 1 under sentence ${player.state().index + 1}'s label`);
  player.destroy();
}

finish();

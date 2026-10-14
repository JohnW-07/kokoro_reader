// C1/N5 harness: context-chosen pause and the early hand-over at a sentence boundary.
// Pure cadence.js, then playback.js + ttsclient.js on the shared fakes (player.test.mjs is at
// its 800-line budget, so the boundary cases live here). Run: node cadence.test.mjs
import {
  now, advance, flush, net, audible, audios, reset, ok, eq, createTtsClient, createPlayer, live, finish,
} from './playerfakes.mjs';

const ROOT = new URL('../../static/js/', import.meta.url);
const {
  PAUSE, pauseAfter, handoffDelayMs, isAtHandoff, nextLead,
  HANDOFF_LEAD_MS, ARM_WINDOW_MS, MAX_HANDOFF_LEAD_MS, MAX_GAP_SAMPLE_MS, MIN_LEAD_GAIN,
} = await import(new URL('cadence.js', ROOT).href);

const DURATION_S = 2;           // the fake element's sentence length
const ARM_AT_MS = 300;          // a timeupdate this far from the end arms the hand-over
const MS_PER_S = 1000;
const at = (leftMs) => DURATION_S - leftMs / MS_PER_S;

// Two paragraphs, a heading, a paragraph — `raw` is the block text, as the pipeline sends it.
const script = [
  { text: 's0', raw: 'P1', kind: 'body', page: 1 },
  { text: 's1', raw: 'P1', kind: 'body', page: 1 },
  { text: 's2', raw: 'P2', kind: 'body', page: 1 },
  { text: 's3', raw: 'H', kind: 'heading', page: 1 },
  { text: 's4', raw: 'P3', kind: 'body', page: 1 },
  { text: 's5', raw: 'P3', kind: 'body', page: 1 },
  { text: 's6', raw: 'P3', kind: 'body', page: 2 },
  { text: 's7', raw: 'P4', kind: 'body', page: 2 },
];

/** Put the live element `leftMs` from its end and fire the `timeupdate` a browser would. */
function nearEnd(el, leftMs) {
  el.duration = DURATION_S;
  el.currentTime = at(leftMs);
  el.dispatch('timeupdate');
}

async function started(listen = []) {
  reset('ok', 100);
  const tts = createTtsClient({ maxInflight: 2 });
  const player = createPlayer({
    tts, getSentences: () => script, getVoice: () => 'af', getSpeed: () => 1,
    onListen: (e) => listen.push(e),
  });
  player.play(0);
  await advance(2000);                     // s0 audible, s1 synthesised and armed on the spare
  return player;
}

const heard = (listen) => listen.filter((e) => e.type === 'heard').map((e) => e.index).join(',');

console.log('\nC1  pauseAfter: short inside a paragraph, longer at its end, longest around a heading');
{
  const tiers = script.map((_, i) => pauseAfter(script, i));
  eq(tiers.join(','), 'sentence,paragraph,section,section,sentence,sentence,paragraph,paragraph',
     'tier per boundary');
  const joined = [
    { raw: 'A', kind: 'body' }, { raw: 'A B', kind: 'body' }, { raw: 'B', kind: 'body' },
  ];
  eq(pauseAfter(joined, 0), PAUSE.SENTENCE, 'a sentence joined across blocks continues the one before');
  eq(pauseAfter(joined, 1), PAUSE.SENTENCE, '…and the one after');
  eq(pauseAfter([{ raw: 'A', kind: 'body' }, { raw: 'A', kind: 'caption' }], 0), PAUSE.PARAGRAPH,
     'a kind change is a paragraph break');
  eq(pauseAfter([{ kind: 'body' }, { kind: 'body' }], 0), PAUSE.PARAGRAPH, 'no raw: no claim of the same paragraph');
}

console.log('\nC2  handoff timing is pure: armed only near the end, leading it by HANDOFF_LEAD_MS');
{
  eq(handoffDelayMs(at(HANDOFF_LEAD_MS + ARM_WINDOW_MS + 1), DURATION_S), null, 'not armed outside the window');
  eq(Math.round(handoffDelayMs(at(HANDOFF_LEAD_MS + ARM_WINDOW_MS), DURATION_S)), ARM_WINDOW_MS,
     'armed at its edge');
  eq(Math.round(handoffDelayMs(at(ARM_AT_MS), DURATION_S)), ARM_AT_MS - HANDOFF_LEAD_MS, 'delay = remaining − lead');
  eq(handoffDelayMs(at(10), DURATION_S), 0, 'already past the lead: now');
  eq(handoffDelayMs(0, NaN), null, 'unknown duration: never armed');
  ok(isAtHandoff(at(HANDOFF_LEAD_MS), DURATION_S) && !isAtHandoff(at(ARM_AT_MS), DURATION_S),
     'isAtHandoff only inside the lead');
}

console.log('\nC3  every request names the beat after its sentence');
{
  await started();
  const sent = net.calls.map((c) => {
    const q = new URL(`http://x${c.url}`).searchParams;
    return `${q.get('text')}:${q.get('pause')}`;
  });
  const want = net.calls.map((c) => {
    const i = Number(new URL(`http://x${c.url}`).searchParams.get('text').slice(1));
    return `s${i}:${pauseAfter(script, i)}`;
  });
  ok(sent.length >= 2, `get and prefetch both issued (${sent})`);
  eq(sent.join(' '), want.join(' '), 'pause param per sentence');
  reset('ok', 100);
  const tts = createTtsClient({ maxInflight: 2 });
  tts.get(0, 's0', 'af', 1);
  await flush();
  eq(new URL(`http://x${net.calls[0].url}`).searchParams.has('pause'), false,
     'no pause given: none sent, the server default applies');
}

console.log('\nC4  MEASURED (fake): the next sentence starts HANDOFF_LEAD_MS before the end, not after `ended`');
{
  const listen = [];
  const player = await started(listen);
  const old = live();
  nearEnd(old, ARM_AT_MS);
  const end = now + ARM_AT_MS;
  await advance(ARM_AT_MS - HANDOFF_LEAD_MS - 10);
  eq(player.state().index, 0, 'still sentence 1 just before the hand-over');
  old.currentTime = at(HANDOFF_LEAD_MS + 5);       // the element kept playing meanwhile
  await advance(20);
  eq(player.state().index, 1, 'handed over to sentence 2');
  const next = audible[audible.length - 1];
  ok(next.src.startsWith('blob:s1'), `sentence 2 audible (${next.src})`);
  const lead = end - next.at;
  console.log(`        next audible ${lead} ms before the old element's end (ended-path handover: 0 ms + browser latency)`);
  ok(lead >= HANDOFF_LEAD_MS - 10 && lead <= HANDOFF_LEAD_MS, `leads the end by ~${HANDOFF_LEAD_MS} ms (${lead})`);
  eq(old.paused, false, 'the old element plays out its tail (C1b drain), not cut');
  ok(old.src.startsWith('blob:s0'), `…still on sentence 1 (${old.src})`);
  eq(heard(listen), '0', 'sentence 1 counted heard once');
  old.ended = true;
  old.dispatch('ended');                           // its own `ended` lands late, on the retired element
  eq(old.paused, true, 'once it has ended it is quieted');
  await advance(1000);
  eq(player.state().index, 1, '`ended` after an early hand-over does not advance again');
  eq(heard(listen), '0', '…nor count the sentence twice');
  player.destroy();
}

console.log('\nC5  a pause near the boundary does not start the next sentence');
{
  const player = await started();
  const el = live();
  nearEnd(el, ARM_AT_MS);
  await advance(100);
  player.pause();
  el.currentTime = at(HANDOFF_LEAD_MS);            // as far as it got before the pause
  await advance(2000);
  eq(player.state().index, 0, 'cursor stays on sentence 1');
  eq(player.state().isPlaying, false, 'still paused');
  ok(!audible.some((a) => a.src.startsWith('blob:s1')), 'sentence 2 never sounded');
  player.resume();
  await flush();
  nearEnd(el, HANDOFF_LEAD_MS);
  await advance(100);
  eq(player.state().index, 1, 'after resume the boundary hands over as usual');
  player.destroy();
}

console.log('\nC6  an outside pause (media key) near the boundary holds too');
{
  const player = await started();
  const el = live();
  nearEnd(el, ARM_AT_MS);
  await advance(100);
  el.paused = true;
  el.dispatch('pause');
  el.currentTime = at(HANDOFF_LEAD_MS);
  await advance(2000);
  eq(player.state().index, 0, 'cursor stays on sentence 1');
  ok(!audible.some((a) => a.src.startsWith('blob:s1')), 'sentence 2 never sounded');
  player.destroy();
}

console.log('\nC7  a position that stopped moving (stall) is re-checked: no cut into speech');
{
  const player = await started();
  nearEnd(live(), ARM_AT_MS);                      // and currentTime never moves again
  await advance(1000);
  eq(player.state().index, 0, 'the timer fired, saw 300 ms still to play, and held');
  player.destroy();
}

console.log('\nC8  a jump while the hand-over is pending wins; the stale timer does nothing');
{
  const player = await started();
  const el = live();
  nearEnd(el, ARM_AT_MS);
  await advance(100);
  player.play(5);
  el.currentTime = at(HANDOFF_LEAD_MS);
  await advance(2000);
  eq(player.state().index, 5, 'cursor on the jump target');
  ok(live().src.startsWith('blob:s5'), `sentence 6 audible (${live().src})`);
  ok(!audible.some((a) => a.src.startsWith('blob:s1') || a.src.startsWith('blob:s6')),
     'neither the old next nor the target\'s next sounded');
  player.destroy();
}

console.log('\nC9  `ended` before a late timer (throttled window) is handled once');
{
  const listen = [];
  const player = await started(listen);
  const el = live();
  nearEnd(el, ARM_AT_MS);
  el.currentTime = DURATION_S;
  el.paused = true; el.ended = true;
  el.dispatch('ended');
  await advance(2000);
  eq(player.state().index, 1, 'advanced exactly one sentence');
  eq(heard(listen), '0', 'sentence 1 counted heard once');
  player.destroy();
}

/** Start sentence 1 alone, with the next armed; returns the player and the play() time. */
async function begin(listen = []) {
  reset('ok', 100);
  const tts = createTtsClient({ maxInflight: 2 });
  const player = createPlayer({
    tts, getSentences: () => script, getVoice: () => 'af', getSpeed: () => 1,
    onListen: (e) => listen.push(e),
  });
  player.play(0);
  await advance(150);                       // s0 fetched (100 ms) and play() called
  return { player, playAt: audible[0].at };
}

const TIMEUPDATE_EVERY_MS = 250;            // the slowest period browsers use

/** Run the boundary from `armLeft` ms out and return how far before the end it handed over. */
async function handoverLead(player, armLeft) {
  const from = player.state().index;
  const el = live();
  nearEnd(el, armLeft);
  for (let t = 0; t <= armLeft; t += 5) {
    el.currentTime = at(armLeft - t);
    if (t % TIMEUPDATE_EVERY_MS === 0) el.dispatch('timeupdate');
    await advance(5);
    if (player.state().index !== from) return armLeft - t;
  }
  return -1;
}

const GAP = 400;                            // WebKit-like: next clock start − previous clock end
const SENTENCE_MS = DURATION_S * MS_PER_S;

/**
 * Drive `el` as a real element whose media clock started at `startAt`: currentTime follows
 * the fake clock, `timeupdate` every TIMEUPDATE_EVERY_MS. Returns how many ms before its end
 * the cursor moved on, or -1 if it never did. `staleFirstMs`: the first reading lags that much.
 */
async function playOut(player, el, startAt, staleFirstMs = 0) {
  const from = player.state().index;
  const endAt = startAt + SENTENCE_MS;
  let lag = staleFirstMs;
  el.duration = DURATION_S;
  await advance(Math.max(0, startAt - now));
  while (now < endAt) {
    await advance(5);
    el.currentTime = Math.min(DURATION_S, Math.max(0, now - startAt - lag) / MS_PER_S);
    if ((now - startAt) % TIMEUPDATE_EVERY_MS < 5) {
      el.dispatch('timeupdate');
      lag = 0;
    }
    if (player.state().index !== from) return endAt - now;
  }
  return -1;
}

/** Sentence 1 from its play(), sentence 2's clock `gap` after its end; sentence 2's lead. */
async function leadAfterGap(player, playAt, gap, between = async () => {}) {
  await playOut(player, live(), playAt);
  await between();
  return playOut(player, live(), playAt + SENTENCE_MS + gap);
}

console.log('\nC10 the lead is learnt: each boundary\'s gap corrects it, 1/n then MIN_LEAD_GAIN, within bounds');
{
  eq(nextLead(50, 400), 450, 'the first gap is taken whole');
  eq(nextLead(450, -100, 1), 400, 'the second halves it: the running mean');
  eq(nextLead(400, 100, 9), 400 + MIN_LEAD_GAIN * 100, 'later gaps by MIN_LEAD_GAIN');
  eq(nextLead(20, -100), 0, 'never negative');
  eq(nextLead(700, 600), MAX_HANDOFF_LEAD_MS, 'capped');
  eq(nextLead(50, MAX_GAP_SAMPLE_MS + 1), 50, 'a gap over MAX_GAP_SAMPLE_MS (a stall) is ignored');
  eq(nextLead(50, -MAX_GAP_SAMPLE_MS - 1), 50, '…either way');
  eq(nextLead(50, -MAX_GAP_SAMPLE_MS), 0, '…one at it counts');
  eq(nextLead(50, NaN), 50, 'NaN is ignored');
  eq(Math.round(handoffDelayMs(at(900), DURATION_S, 500)), 400, 'a longer lead hands over earlier');
  eq(handoffDelayMs(at(500 + ARM_WINDOW_MS + 1), DURATION_S, 500), null, '…and arms earlier, by the same window');
  ok(isAtHandoff(at(500), DURATION_S, 500) && !isAtHandoff(at(600), DURATION_S, 500), 'isAtHandoff follows the lead');
}

console.log('\nC11 MEASURED (fake): a boundary that started 400 ms late (WebKit) moves the next hand-over earlier');
{
  const { player, playAt } = await begin();
  const first = await playOut(player, live(), playAt);
  ok(Math.abs(first - HANDOFF_LEAD_MS) <= 5, `first boundary: the default lead (${first})`);
  const lead = await playOut(player, live(), playAt + SENTENCE_MS + GAP);
  const want = HANDOFF_LEAD_MS + GAP;
  console.log(`        next hand-over ${lead} ms before the end (learnt lead ${want})`);
  ok(Math.abs(lead - want) <= 5, `lead ≈ ${want} (${lead})`);
  const third = await playOut(player, live(), playAt + 2 * SENTENCE_MS + GAP - 100);
  ok(Math.abs(third - (want - 50)) <= 5, `a 100 ms early start halves back (${third})`);
  player.destroy();
}

console.log('\nC11b a stale reading (Chromium steps currentTime ~64 ms) does not skew the gap');
{
  const { player, playAt } = await begin();
  await playOut(player, live(), playAt, 60);       // its first reading 60 ms behind the clock
  const lead = await playOut(player, live(), playAt + SENTENCE_MS + GAP);
  const want = HANDOFF_LEAD_MS + GAP;
  ok(Math.abs(lead - want) <= 5, `the earliest reading dates the clock: lead ≈ ${want} (${lead})`);
  player.destroy();
}

console.log('\nC12 no sample: a cold element, a pause, a jump');
{
  let { player, playAt } = await begin();
  audios.find((a) => a !== live()).readyState = 2;   // the spare still loading at its play()
  let lead = await leadAfterGap(player, playAt, GAP);
  ok(Math.abs(lead - HANDOFF_LEAD_MS) <= 5, `cold element (its gap is loading): lead unchanged (${lead})`);
  player.destroy();

  ({ player, playAt } = await begin());
  lead = await leadAfterGap(player, playAt, GAP, async () => {
    player.pause();
    player.resume();
    await flush();
  });
  ok(Math.abs(lead - HANDOFF_LEAD_MS) <= 5, `paused before its boundary settled: lead unchanged (${lead})`);
  player.destroy();

  ({ player, playAt } = await begin());
  lead = await leadAfterGap(player, playAt, GAP, async () => {
    player.play(3);                                  // a jump: not a boundary
    await advance(10);
  });
  ok(Math.abs(lead - HANDOFF_LEAD_MS) <= 5, `a jump: lead unchanged (${lead})`);
  player.destroy();
}

console.log('\nC13 a boundary reached by `ended` (the timer lost the race) is measured too');
{
  const { player, playAt } = await begin();
  const el = live();
  await advance(150);
  el.duration = DURATION_S;
  el.currentTime = (now - playAt) / MS_PER_S;
  el.dispatch('timeupdate');                       // dated, then never armed: straight to `ended`
  el.currentTime = DURATION_S;
  el.paused = true; el.ended = true;
  el.dispatch('ended');
  await flush();
  const lead = await playOut(player, live(), playAt + SENTENCE_MS + GAP);
  const want = HANDOFF_LEAD_MS + GAP;
  ok(Math.abs(lead - want) <= 5, `lead ≈ ${want} (${lead})`);
  player.destroy();
}

console.log('\nC14 the drained element: a preload waits for it; a pause or a jump cuts it');
{
  let { player } = await begin();
  await advance(200);                       // s1 armed on the spare
  let old = live();
  await handoverLead(player, 300);
  await advance(200);                       // s2 synthesised; its preload aims at the draining element
  ok(old.src.startsWith('blob:s0') && !old.paused, `still playing out sentence 1 (${old.src})`);
  old.ended = true;
  old.dispatch('ended');
  ok(old.src.startsWith('blob:s2'), `after \`ended\` it takes the waiting preload (${old.src})`);
  player.destroy();

  ({ player } = await begin());
  await advance(200);
  old = live();
  await handoverLead(player, 300);
  await advance(10);
  player.pause();
  eq(old.paused, true, 'a pause also stops the sentence being left');
  player.destroy();

  ({ player } = await begin());
  await advance(200);
  old = live();
  await handoverLead(player, 300);
  await advance(10);
  player.play(5);
  eq(old.paused, true, 'a jump cuts it too');
  await advance(500);
  ok(!audible.some((a) => a.src.startsWith('blob:s1') && a.el === old), 'and nothing else sounded on it');
  player.destroy();
}

finish();

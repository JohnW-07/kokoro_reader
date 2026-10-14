// R6: macOS removed the Siri voice. The server answers 424; the player falls back to
// Kokoro on the same sentence and the switch says so, instead of a skip cascade.
import { advance, net, ok, eq, reset, createTtsClient, createPlayer, mkSentences, finish } from './playerfakes.mjs';
import { fallBackToKokoro, SIRI_VOICE, SIRI_GONE_MESSAGE, ttsVoice } from '../../static/js/engineswitch.js';
import { VOICE_UNAVAILABLE_STATUS } from '../../static/js/ttsclient.js';

const voiceOf = (call) => new URL('http://x' + call.url).searchParams.get('voice');

function mkPlayer({ onVoiceUnavailable, voice }) {
  const tts = createTtsClient({ maxInflight: 2 });
  const statuses = [];
  const player = createPlayer({
    tts, getSentences: () => mkSentences(6), getVoice: () => voice.current, getSpeed: () => 1,
    onStatus: (s) => statuses.push(s), onVoiceUnavailable,
  });
  return { player, statuses };
}

console.log('\nV1  the server status the client keys on');
eq(VOICE_UNAVAILABLE_STATUS, 424, 'matches routes/tts.py VOICE_UNAVAILABLE_STATUS');

console.log('\nV2  a 424 switches voice and replays the same sentence, with no skip');
{
  reset('ok', 50);
  net.replies.set('s0', [VOICE_UNAVAILABLE_STATUS]);
  const voice = { current: SIRI_VOICE };
  let calls = 0;
  const { player, statuses } = mkPlayer({ voice, onVoiceUnavailable: () => { calls += 1; voice.current = 'af_aoede'; } });
  player.play(0);
  await advance(1000);
  const s0 = net.calls.filter((c) => c.text === 's0');
  eq(calls, 1, 'the fallback runs once');
  eq(s0.length, 2, 's0 asked twice: once as Siri, never retried as Siri, then as Kokoro');
  eq(voiceOf(s0[1]), 'af_aoede', 'the replay asks for the Kokoro voice');
  eq(player.state().index, 0, 'still on the first sentence');
  eq(player.state().isPlaying, true, 'and reading it');
  eq(statuses.filter((s) => /Skipped|failed/.test(s.message)).length, 0, 'no skip or failure status');
  player.destroy();
}

console.log('\nV3  a fallback that cannot change the voice is an ordinary failure, not a loop');
{
  reset('ok', 50);
  net.replies.set('s0', [VOICE_UNAVAILABLE_STATUS, VOICE_UNAVAILABLE_STATUS]);
  const voice = { current: SIRI_VOICE };
  let calls = 0;
  const { player, statuses } = mkPlayer({ voice, onVoiceUnavailable: () => { calls += 1; } });
  player.play(0);
  await advance(3000);
  eq(calls, 2, 'asked once per attempt, then given up (MAX_SYNTH_FAILURES)');
  ok(statuses.some((s) => /Skipped sentence 1/.test(s.message)), 'the sentence is skipped as before');
  eq(player.state().index, 1, 'and reading carries on');
  player.destroy();
}

console.log('\nV4  other failures never ask for a fallback');
{
  reset('ok', 50);
  net.replies.set('s0', [500, 500]);
  const voice = { current: SIRI_VOICE };
  let calls = 0;
  const { player } = mkPlayer({ voice, onVoiceUnavailable: () => { calls += 1; } });
  player.play(0);
  await advance(3000);
  eq(calls, 0, 'a 500 is not "voice gone"');
  player.destroy();
}

console.log('\nV5  fallBackToKokoro picks the Kokoro voice again for good and says why');
function fakes(initial) {
  let current = { ...initial };
  const select = { value: 'siri_nora', options: [{ value: 'siri_nora' }], querySelector: () => ({}), appendChild: () => {} };
  const log = { saves: 0, switches: 0, toasts: [] };
  const state = { get: () => current, set: (p) => { current = { ...current, ...p }; }, savePrefs: () => { log.saves += 1; } };
  const ui = { el: (id) => (id === 'voiceSelect' ? select : null), toast: (m, level) => log.toasts.push({ m, level }) };
  return { state, ui, select, log, onSwitch: () => { log.switches += 1; } };
}
{
  const f = fakes({ voice: 'bm_george', siriVoice: true });
  fallBackToKokoro(f);
  eq(f.state.get().siriVoice, false, 'state: Siri off');
  eq(ttsVoice(f.state.get()), 'bm_george', 'requests now go to the chosen Kokoro voice');
  eq(f.log.saves, 1, 'saved, so the next launch does not try Siri again');
  eq(f.select.value, 'bm_george', 'the voice list shows the Kokoro voice');
  eq(f.log.switches, 1, 'cached audio dropped, as for a manual flip');
  eq(f.log.toasts.length, 1, 'one toast');
  eq(f.log.toasts[0]?.m, SIRI_GONE_MESSAGE, 'with the clear message');
  eq(f.log.toasts[0]?.level, 'warn', 'as a warning');
  ok(/Siri/.test(SIRI_GONE_MESSAGE) && /Kokoro/.test(SIRI_GONE_MESSAGE), 'naming both voices');
  fallBackToKokoro(f);
  eq(f.log.toasts.length + f.log.saves + f.log.switches, 3, 'already off: a second call does nothing');
}

finish();

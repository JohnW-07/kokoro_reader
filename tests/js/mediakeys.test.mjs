// N6: hardware media keys (F8 / ⏯, ⏭, ⏮). mediakeys.js registers navigator.mediaSession
// action handlers and keeps playbackState + metadata in step with the player's status;
// transport.js supplies the handlers, so a key behaves exactly like the matching button.
import { createMediaKeys, sessionState } from '../../static/js/mediakeys.js';
import { createTransport } from '../../static/js/transport.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const eq = (a, b, n) => ok(n, Object.is(a, b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** A fake navigator.mediaSession; `refuse` lists actions this "browser" does not support. */
function fakeSession(refuse = []) {
  const handlers = new Map();
  return {
    handlers, playbackState: 'none', metadata: null,
    setActionHandler(name, fn) {
      if (refuse.includes(name)) throw new TypeError(`unsupported action ${name}`);
      handlers.set(name, fn);
    },
  };
}
class FakeMetadata { constructor(init) { Object.assign(this, init); } }
const fakeState = (s) => ({ get: () => s });
const doc = { docName: 'GR00T N1', index: 4, sentences: Array.from({ length: 120 }, () => ({})) };

console.log('\nM1 every transport action is registered and reaches its handler');
{
  const session = fakeSession();
  const calls = [];
  const actions = Object.fromEntries(['play', 'pause', 'nexttrack', 'previoustrack']
    .map((name) => [name, () => calls.push(name)]));
  const keys = createMediaKeys({ actions, state: fakeState(doc), session, Metadata: FakeMetadata });
  eq(keys.isSupported, true, 'supported with a mediaSession');
  ['play', 'pause', 'nexttrack', 'previoustrack'].forEach((name) => session.handlers.get(name)?.({ action: name }));
  eq(calls.join(','), 'play,pause,nexttrack,previoustrack', 'each key ran its own action once');
}

console.log('\nM2 playbackState and metadata follow the player status');
{
  const session = fakeSession();
  const keys = createMediaKeys({ actions: {}, state: fakeState(doc), session, Metadata: FakeMetadata });
  keys.sync('playing');
  eq(session.playbackState, 'playing', 'playing → playing');
  eq(session.metadata?.title, 'GR00T N1', 'title is the document');
  eq(session.metadata?.artist, 'Sentence 5 of 120', 'artist line is the place in it');
  keys.sync('paused');
  eq(session.playbackState, 'paused', 'paused → paused (so ⏯ resumes)');
  [['loading', 'playing'], ['recovering', 'playing'], ['idle', 'paused'], ['error', 'paused']]
    .forEach(([phase, want]) => eq(sessionState(phase), want, `${phase} → ${want}`));
}

console.log('\nM3 no mediaSession (or a partial one) is harmless');
{
  const keys = createMediaKeys({ actions: { play() {} }, state: fakeState(doc), session: undefined });
  eq(keys.isSupported, false, 'unsupported without a mediaSession');
  keys.sync('playing');
  ok('sync() without a session does not throw', true);
  const session = fakeSession(['previoustrack']);
  const actions = { play() {}, pause() {}, nexttrack() {}, previoustrack() {} };
  createMediaKeys({ actions, state: fakeState({ docName: '', index: 0, sentences: [] }), session, Metadata: FakeMetadata });
  eq(session.handlers.size, 3, 'an action the browser refuses does not stop the others');
  const noMeta = fakeSession();
  createMediaKeys({ actions, state: fakeState(doc), session: noMeta, Metadata: undefined }).sync('playing');
  eq(noMeta.playbackState, 'playing', 'playbackState still set without MediaMetadata');
}

console.log('\nM4 transport.mediaActions: play/pause are explicit, next/prev step and re-follow');
{
  const log = [];
  const player = {
    resume: () => log.push('resume'), pause: () => log.push('pause'),
    next: () => log.push('next'), prev: () => log.push('prev'), toggle: () => log.push('toggle'),
    state: () => ({ isRunning: true }),
  };
  const follower = { resume: () => log.push('follow') };
  const { mediaActions } = createTransport({ player, follower, state: fakeState(doc), ui: {} });
  mediaActions.pause();
  eq(log.join(','), 'pause', 'pause key pauses, never toggles, and leaves the view alone');
  log.length = 0;
  mediaActions.play();
  eq(log.join(','), 'resume,follow', 'play key resumes and follows');
  log.length = 0;
  mediaActions.nexttrack();
  mediaActions.previoustrack();
  eq(log.join(','), 'next,follow,prev,follow', 'next/prev step like the arrow buttons');
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'}  —  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// The real playback.js + ttsclient.js against the REAL server. Only <audio> is faked,
// and it is faked honestly: it actually waits, and can be made to wedge on demand.
import { readFileSync } from 'node:fs';

let wedged = false, playCalls = 0;
class FakeAudio {
    constructor() { this._l = new Map(); this.src = ''; this.currentTime = 0; this.playbackRate = 1; this.paused = true; this.style = {}; }
    addEventListener(t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); }
    removeEventListener(t, fn) { const a = this._l.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    emit(t, d) { for (const fn of [...(this._l.get(t) || [])]) fn(d || { type: t }); }
    load() {}
    setAttribute() {} removeAttribute() {} remove() {}
    get preload() { return this._pre; } set preload(v) { this._pre = v; }
    async play() {
        playCalls++;
        this.paused = false;
        if (wedged) return new Promise(() => {});          // the WKWebView wedge
        setTimeout(() => { this.emit('playing'); setTimeout(() => { this.paused = true; this.emit('ended'); }, 12); }, 4);
    }
    pause() { this.paused = true; }
}
globalThis.document = {
    createElement: (t) => (t === 'audio' ? new FakeAudio() : { style: {}, setAttribute() {}, append() {}, appendChild(c){return c;} }),
    body: { append() {}, appendChild(c) { return c; }, removeChild() {} },
};
globalThis.Audio = FakeAudio;
// Keep the real URL class -- ttsclient builds request URLs with it -- and only add the
// two blob statics jsdom-less Node lacks.
URL.createObjectURL = (b) => `blob:${Math.random()}`;
URL.revokeObjectURL = () => {};
globalThis.Blob = class { constructor(p) { this.size = (p[0]?.byteLength ?? p[0]?.length ?? 0); } };

const { createTtsClient } = await import(new URL('../../static/js/ttsclient.js', import.meta.url).href);
const { createPlayer } = await import(new URL('../../static/js/playback.js', import.meta.url).href);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${x}`)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const S = process.env.KOKORO_FIXTURES || '/tmp';
const texts = JSON.parse(readFileSync(`${S}/pi06_sents.json`, 'utf8')).filter(t => t.length > 25 && t.length < 300);

const makeSentences = (n) => texts.slice(0, n).map((t, i) => ({ text: t, page: 1 + (i >> 3), items: [i] }));
let sentences = makeSentences(25);
const seen = [], statuses = [];
const tts = createTtsClient({ endpoint: 'http://127.0.0.1:8000/api/tts' });
const player = createPlayer({
    tts,
    getSentences: () => sentences,
    getVoice: () => 'af_heart',
    getSpeed: () => 1.0,
    onIndex: (i) => seen.push(i),
    onStatus: (s) => statuses.push(s),
    onEnded: () => statuses.push({ state: 'done' }),
});

console.log(`\n1. reading ${sentences.length} real sentences through the real server`);
const t0 = Date.now();
player.play(0);
const deadline = Date.now() + 120000;
while (seen.at(-1) !== sentences.length - 1 && Date.now() < deadline) await sleep(100);
ok('   reached the last sentence', seen.at(-1) === sentences.length - 1, `stopped at ${seen.at(-1)}`);
ok('   visited every index in order', seen.join() === [...Array(sentences.length).keys()].join(),
    seen.slice(0, 30).join(','));
ok('   no error status was emitted', !statuses.some(s => s.level === 'warn' || s.level === 'error'),
    JSON.stringify(statuses.filter(s => s.level).slice(0, 2)));
console.log(`        ${((Date.now() - t0) / 1000).toFixed(1)}s wall, ${playCalls} play() calls`);

console.log('\n2. the script shrinks under the cursor (a Rebuild)');
player.play(20);
await sleep(300);
sentences = makeSentences(3);
const before = seen.length;
player.toggle();
await sleep(1500);
ok('   toggle() still produced progress', seen.length > before, `${before} -> ${seen.length}`);
ok('   it re-anchored inside the new script', seen.at(-1) < 3, `index ${seen.at(-1)}`);
const beforeRecover = seen.length;
player.recover();
await sleep(3000);
ok('   recover() also works', seen.length > beforeRecover, `${beforeRecover} -> ${seen.length}`);

console.log('\n3. a wedged media element is recovered, not fatal');
sentences = makeSentences(12);
player.stop();
wedged = true;
player.play(0);
await sleep(9000);
const sawRecovery = statuses.some(s => /recover|retry|stall/i.test(JSON.stringify(s)));
ok('   the watchdog noticed and reported', sawRecovery, JSON.stringify(statuses.slice(-3)));
wedged = false;
const beforeUnwedge = seen.length;
player.recover();
await sleep(6000);
ok('   R (recover) gets playback moving again', seen.length > beforeUnwedge, `${beforeUnwedge} -> ${seen.length}`);
player.stop();

console.log('\n4. a document the server cannot synthesise does not melt down');
sentences = Array.from({ length: 40 }, (_, i) => ({ text: '', page: 1, items: [i] }));
const beforeToasts = statuses.length;
player.play(0);
await sleep(6000);
const warns = statuses.slice(beforeToasts).filter(s => s.level === 'warn' || s.level === 'error');
ok('   it stops instead of cascading', warns.length < 15, `${warns.length} warn/error statuses`);
console.log(`        ${warns.length} warn/error statuses for 40 unsynthesisable sentences`);
player.stop();
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

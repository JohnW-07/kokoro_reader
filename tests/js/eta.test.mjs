/* Harness for N11, the reading ETA (eta.js): the rate it learns from heard sentences, the
   characters left on the page and in the paper, and the numbers the stats page is handed. */
import assert from 'node:assert/strict';
import * as eta from '../../static/js/eta.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const V = 'af_aoede';
const s = (page, text) => ({ page, text, raw: text, kind: 'body', items: [] });
// Pages 1 and 2: 10 + 20 chars on page 1, 30 + 40 on page 2.
const DOC = [s(1, 'a'.repeat(10)), s(1, 'b'.repeat(20)), s(2, 'c'.repeat(30)), s(2, 'd'.repeat(40))];

await test('before any listening the rate is the default, scaled by speed', () => {
  assert.equal(eta.secondsPerChar({}, V, 1), 1 / eta.DEFAULT_CHARS_PER_S);
  assert.equal(eta.secondsPerChar({}, V, 2), 1 / (eta.DEFAULT_CHARS_PER_S * 2));
  assert.equal(eta.secondsPerChar(undefined, V, 1), 1 / eta.DEFAULT_CHARS_PER_S);
});

await test('a sample seeds the rate for its voice and speed only', () => {
  const rates = eta.withSample({}, V, 1, { seconds: 10, chars: 100 });
  assert.equal(eta.secondsPerChar(rates, V, 1), 0.1);
  assert.equal(eta.secondsPerChar(rates, V, 1.5), 1 / (eta.DEFAULT_CHARS_PER_S * 1.5), 'other speed untouched');
  assert.equal(eta.secondsPerChar(rates, 'am_puck', 1), 1 / eta.DEFAULT_CHARS_PER_S, 'other voice untouched');
});

await test('later samples move the rate by an EWMA weighted by characters', () => {
  const one = eta.withSample({}, V, 1, { seconds: 10, chars: 100 });           // 0.1 s/char
  const two = eta.withSample(one, V, 1, { seconds: 5, chars: 100 });           // 0.05 s/char
  const a = eta.EWMA_ALPHA;
  const expected = ((1 - a) * 10 + 5) / ((1 - a) * 100 + 100);
  assert.ok(Math.abs(eta.secondsPerChar(two, V, 1) - expected) < 1e-12);
  assert.ok(eta.secondsPerChar(two, V, 1) < 0.1 && eta.secondsPerChar(two, V, 1) > 0.05);
  assert.equal(eta.secondsPerChar(one, V, 1), 0.1, 'the old rates object is not mutated');
});

await test('nonsense samples are ignored', () => {
  const base = eta.withSample({}, V, 1, { seconds: 10, chars: 100 });
  for (const bad of [{ seconds: 0, chars: 100 }, { seconds: 5, chars: 0 }, { seconds: NaN, chars: 9 },
    { seconds: 100, chars: 10 }, { seconds: 0.01, chars: 100 }]) {
    assert.equal(eta.withSample(base, V, 1, bad), base, JSON.stringify(bad));
  }
});

await test('the rate table stays bounded', () => {
  let rates = {};
  for (let i = 0; i < eta.MAX_RATE_KEYS + 5; i += 1) rates = eta.withSample(rates, `v${i}`, 1, { seconds: 1, chars: 15 });
  assert.equal(Object.keys(rates).length, eta.MAX_RATE_KEYS);
  assert.ok(`${'v'}${eta.MAX_RATE_KEYS + 4}@1.00` in rates, 'the newest voice is kept');
});

await test('saved rates are cleaned on load', () => {
  assert.deepEqual(eta.cleanRates(null), {});
  assert.deepEqual(eta.cleanRates({ 'a@1.00': { s: 2, c: 30 }, bad: { s: -1, c: 3 }, nope: 7 }), { 'a@1.00': { s: 2, c: 30 } });
});

await test('remaining characters: the current sentence to the end of its page, and of the paper', () => {
  assert.deepEqual(eta.remaining(DOC, 0), { page: 1, pageChars: 30, docChars: 100, sentencesLeft: 4 });
  assert.deepEqual(eta.remaining(DOC, 1), { page: 1, pageChars: 20, docChars: 90, sentencesLeft: 3 });
  assert.deepEqual(eta.remaining(DOC, 2), { page: 2, pageChars: 70, docChars: 70, sentencesLeft: 2 });
  assert.deepEqual(eta.remaining(DOC, 3), { page: 2, pageChars: 40, docChars: 40, sentencesLeft: 1 });
  assert.equal(eta.remaining([], 0), null);
  assert.deepEqual(eta.remaining(DOC, 99), eta.remaining(DOC, 3), 'an index past the end clamps');
});

await test('sentences with nothing to say add no time', () => {
  // The server only sends spoken sentences (pipeline._to_sentences drops speak=False blocks);
  // an empty one, or one with only on-page text, still must not count as speech.
  const list = [s(1, 'x'.repeat(10)), { page: 1, text: '', raw: '' }, { page: 1 }, s(1, 'y'.repeat(5))];
  assert.equal(eta.remaining(list, 0).pageChars, 15);
  assert.equal(eta.spokenChars({ text: '', raw: 'on page' }), 7, 'raw stands in for text, as in playback.js');
});

await test('the view divides characters by the learnt rate', () => {
  const rates = eta.withSample({}, V, 1, { seconds: 10, chars: 100 });
  const view = eta.etaView({ sentences: DOC, index: 1, rates, voice: V, speed: 1 });
  assert.deepEqual(view, { page: 1, pageSeconds: 2, docSeconds: 9, sentencesLeft: 3, heardShare: 0.25 });
  assert.equal(eta.etaView({ sentences: [], index: 0, rates, voice: V, speed: 1 }), null);
});

await test('compact text for the status bar', () => {
  assert.equal(eta.formatEta(20), '<1 min');
  assert.equal(eta.formatEta(3 * 60 + 10), '3 min');
  assert.equal(eta.formatEta(72 * 60), '1 h 12 m');
  assert.equal(eta.formatEta(2 * 3600), '2 h');
  assert.equal(eta.scopeText({ page: 180, paper: 72 * 60 }, 'page'), '≈3 min left on page · 1 h 12 m in paper');
});

// ── the tracker: turns playback.js listen events into samples ────────────────
const tracker = () => {
  const saved = [];
  let rates = {};
  const t = eta.createEtaTracker({
    getSpeed: () => 1, getRates: () => rates, setRates: (r) => { rates = r; saved.push(r); },
  });
  return { t, saved, rates: () => rates };
};
const heard = (index, text = 'z'.repeat(100), voice = V) => ({ type: 'heard', index, total: 9, sentence: s(1, text), voice });
const time = (seconds) => ({ type: 'time', seconds, voice: V });

await test('a sentence heard straight after the one before it is a sample', () => {
  const { t, saved, rates } = tracker();
  t.listen(time(3)); t.listen(heard(0));          // the first one after Play: its start is unknown
  assert.equal(saved.length, 0);
  t.listen(time(4)); t.listen(time(4)); t.listen(heard(1));
  assert.equal(saved.length, 1);
  assert.equal(eta.secondsPerChar(rates(), V, 1), 0.08);
});

await test('a jump discards the time it cut short', () => {
  const { t, saved } = tracker();
  t.listen(heard(4));
  t.listen(time(2));                               // half of 5, then a jump to 9
  t.listen(time(8)); t.listen(heard(9));
  assert.equal(saved.length, 0, 'not contiguous: no sample');
  t.listen(time(8)); t.listen(heard(10));
  assert.equal(saved.length, 1);
});

await test('a voice change starts its own rate', () => {
  const { t, rates } = tracker();
  t.listen(heard(0)); t.listen(time(10)); t.listen(heard(1, 'z'.repeat(100), 'am_puck'));
  assert.equal(eta.secondsPerChar(rates(), 'am_puck', 1), 0.1);
  assert.equal(eta.secondsPerChar(rates(), V, 1), 1 / eta.DEFAULT_CHARS_PER_S);
});

await test('junk events are ignored', () => {
  const { t, saved } = tracker();
  [null, {}, { type: 'other' }, time(-3), time('x')].forEach((ev) => t.listen(ev));
  assert.equal(saved.length, 0);
});

// ── scopes: page → section → chapter → paper ─────────────────────────────────
// Chapter A (depth 0) at 0 holds section A.1 at 1; chapter B at 3. Pages: 1,1,2,2.
const TOC = [{ index: 0, depth: 0 }, { index: 1, depth: 1 }, { index: 3, depth: 0 }];

await test('each scope ends where its page, contents entry or the paper ends', () => {
  assert.equal(eta.scopeEnd(DOC, TOC, 1, 'page'), 2);
  assert.equal(eta.scopeEnd(DOC, TOC, 1, 'section'), 3, 'A.1 runs to chapter B');
  assert.equal(eta.scopeEnd(DOC, TOC, 0, 'section'), 1, 'chapter A\'s own text ends at A.1');
  assert.equal(eta.scopeEnd(DOC, TOC, 1, 'chapter'), 3);
  assert.equal(eta.scopeEnd(DOC, TOC, 3, 'chapter'), 4);
  assert.equal(eta.scopeEnd(DOC, [], 1, 'chapter'), -1, 'no contents, no chapter');
  assert.equal(eta.scopeEnd(DOC, TOC, 1, 'paper'), 4);
});

await test('seconds per scope, only the scopes the paper has, and a missing scope shows the page', () => {
  const left = eta.scopeSeconds({ sentences: DOC, index: 1, entries: TOC, perChar: 1 });
  assert.deepEqual(left, { page: 20, section: 50, chapter: 50, paper: 90 });
  assert.equal(eta.shownScope(left, 'chapter'), 'chapter');
  const bare = eta.scopeSeconds({ sentences: DOC, index: 1, entries: [], perChar: 1 });
  assert.deepEqual(Object.keys(bare), ['page', 'paper']);
  assert.equal(eta.shownScope(bare, 'chapter'), 'page');
  assert.equal(eta.scopeText(bare, 'chapter'), '≈<1 min left on page · 2 min in paper');
  assert.equal(eta.scopeText({ paper: 600, page: 60 }, 'paper'), '≈10 min left in paper');
  assert.equal(eta.scopeSeconds({ sentences: [], index: 0, perChar: 1 }), null);
});

await test('stats: wpm from the learnt rate and words per char, TTS time in s then min', () => {
  assert.equal(eta.wordsPerChar([s(1, 'ab cd'), s(1, 'efgh')]), 3 / 9);
  assert.equal(eta.wordsPerChar([]), 0);
  // 1/6 word per char at 15 chars/s → 2.5 words/s → 150 wpm
  assert.equal(eta.statsText({ wordsPerChar: 1 / 6, perChar: 1 / 15, computeMs: 48_400 }), '150 wpm · TTS 48 s');
  assert.equal(eta.statsText({ wordsPerChar: 1 / 6, perChar: 1 / 15, computeMs: 190_000 }), '150 wpm · TTS 3 min');
});

// ── etastatus.js: the readout beside the page pill ───────────────────────────
const { createEtaStatus } = await import('../../static/js/etastatus.js');
const fakeState = (initial) => {
  let cur = initial;
  const subs = [];
  return {
    get: () => cur,
    set: (patch) => { cur = { ...cur, ...patch }; subs.forEach((fn) => fn(cur)); },
    subscribe: (fn) => subs.push(fn),
    savePrefs: () => { fakeState.saves += 1; },
  };
};
fakeState.saves = 0;

await test('the readout is hidden with no paper, and follows the cursor and the learnt rate', () => {
  const root = { hidden: false, textContent: 'stale', addEventListener: () => {} };
  const st = fakeState({ docId: null, sentences: [], index: 0, etaRates: {}, voice: V, siriVoice: false, speed: 1 });
  const status = createEtaStatus({ root, state: st });
  assert.equal(root.hidden, true);
  assert.equal(root.textContent, '');
  const long = Array.from({ length: 4 }, (_, i) => s(i < 2 ? 1 : 2, 'w'.repeat(1500)));
  st.set({ docId: 'ab12cd34', sentences: long });
  assert.equal(root.hidden, false);
  assert.equal(root.textContent, '≈3 min left on page · 7 min in paper');   // 3000 / 15 = 200 s, 6000 / 15 = 400 s
  st.set({ index: 2 });
  assert.equal(root.textContent, '≈3 min left on page · 3 min in paper');
  status.listen(heard(2, 'w'.repeat(1500))); status.listen(time(150)); status.listen(heard(3, 'w'.repeat(1500)));
  assert.equal(fakeState.saves, 1, 'a learnt rate is saved to prefs');
  assert.equal(root.textContent, '≈5 min left on page · 5 min in paper');   // 0.1 s/char × 3000
});

await test('the readout follows the chosen scope, and the extras add wpm and TTS time', () => {
  const root = { hidden: true, textContent: '' };
  const long = Array.from({ length: 4 }, (_, i) => s(i < 2 ? 1 : 2, 'w'.repeat(1500)));
  const st = fakeState({ docId: 'ab12cd34', sentences: long, index: 0, etaRates: {}, voice: V, siriVoice: false,
    speed: 1, tocEntries: [{ index: 0, depth: 0 }, { index: 3, depth: 0 }], etaScope: 'page', etaStats: false });
  createEtaStatus({ root, state: st, getComputeMs: () => 5000 });
  assert.equal(root.textContent, '≈3 min left on page · 7 min in paper');
  st.set({ etaScope: 'section' });
  assert.equal(root.textContent, '≈5 min left in section · 7 min in paper');   // 4500 / 15 = 300 s
  st.set({ etaScope: 'paper', etaStats: true });
  assert.match(root.textContent, /^≈7 min left in paper · \d+ wpm · TTS 5 s$/);
  st.set({ etaScope: 'chapter', tocEntries: [] });
  assert.match(root.textContent, /^≈3 min left on page · /, 'a scope the paper lacks shows the page');
});

// ── the stats page's "This paper" numbers travel in the frame URL ────────────
await test('paper numbers round-trip through a query string, and junk reads as none', () => {
  const view = { page: 2, pageSeconds: 61.4, docSeconds: 4321.9, sentencesLeft: 12, heardShare: 0.4567 };
  const query = eta.paperQuery('ab12cd34', view);
  assert.deepEqual(eta.readPaperQuery(`?embed=1&${query}`),
    { docId: 'ab12cd34', pageSeconds: 61, docSeconds: 4322, sentencesLeft: 12, heardShare: 0.457 });
  assert.equal(eta.paperQuery(null, view), '');
  assert.equal(eta.paperQuery('ab12cd34', null), '');
  assert.equal(eta.readPaperQuery('?embed=1'), null);
  assert.equal(eta.readPaperQuery('?doc=NOT_HEX&page_s=1&doc_s=1&left=1&heard=0'), null);
  assert.equal(eta.readPaperQuery('?doc=ab12cd34&page_s=-1&doc_s=1&left=1&heard=0'), null);
  assert.equal(eta.readPaperQuery('?doc=ab12cd34&page_s=1&doc_s=1&left=1&heard=2'), null);
});

console.log(`\nALL GREEN — ${passed} tests passed\n`);

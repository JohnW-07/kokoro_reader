/* Harness for the Wrapped page's pure helpers (statsformat.js) and the listening log (listenlog.js). */
import assert from 'node:assert/strict';
import * as fmt from '../../static/js/statsformat.js';
import { createListenLog, wordCount } from '../../static/js/listenlog.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

// ── statsformat.js ───────────────────────────────────────────────────────────
await test('durations read as hours and minutes, never negative', () => {
  assert.equal(fmt.formatDuration(0), '0 min');
  assert.equal(fmt.formatDuration(30), '<1 min');
  assert.equal(fmt.formatDuration(12 * 60 + 59), '12 min');
  assert.equal(fmt.formatDuration(2 * 3600 + 5 * 60), '2 h 05 min');
  assert.equal(fmt.formatDuration(-9), '0 min');
  assert.equal(fmt.formatDuration('junk'), '0 min');
});

await test('the hero number switches from minutes to hours at one hour', () => {
  assert.deepEqual(fmt.heroTime(59 * 60), { value: '59', unit: 'minutes' });
  assert.deepEqual(fmt.heroTime(60), { value: '1', unit: 'minute' });
  assert.deepEqual(fmt.heroTime(5.4), { value: '5', unit: 'seconds' }, 'a first short listen is not "0"');
  assert.deepEqual(fmt.heroTime(0), { value: '0', unit: 'seconds' });
  assert.equal(fmt.plural(1, 'day', 'days'), '1 day');
  assert.equal(fmt.plural(1200, 'word', 'words'), '1,200 words');
  assert.deepEqual(fmt.heroTime(3600), { value: '1', unit: 'hour' });
  assert.deepEqual(fmt.heroTime(4.25 * 3600), { value: '4.3', unit: 'hours' });
});

await test('counts get separators, and compact notation from 100k', () => {
  assert.equal(fmt.formatCount(12345), '12,345');
  assert.equal(fmt.formatCount(1234567), '1.2M');
  assert.equal(fmt.formatCount(undefined), '0');
});

await test('hit rate is a percentage, or a dash before any request', () => {
  assert.equal(fmt.formatPercent(0.834), '83%');
  assert.equal(fmt.formatPercent(null), '—');
});

await test('voices, titles, days and hours get human labels', () => {
  assert.equal(fmt.voiceLabel('af_aoede'), 'Aoede · American');
  assert.equal(fmt.voiceLabel('bm_george'), 'George · British');
  assert.equal(fmt.voiceLabel(null), '—');
  assert.equal(fmt.paperTitle('Attention Is All You Need.PDF'), 'Attention Is All You Need');
  assert.equal(fmt.paperTitle('  '), 'Untitled paper');
  assert.equal(fmt.dayLabel('2026-03-14'), 'Sat, Mar 14');
  assert.equal(fmt.dayLabel('nope'), '—');
  assert.deepEqual([0, 9, 12, 23].map(fmt.hourLabel), ['12 am', '9 am', '12 pm', '11 pm']);
});

await test('R8: the per-voice rows label each voice and say n/a where Siri has no tokens', () => {
  const rows = fmt.voiceUsageRows([
    { voice: 'af_aoede', tokens: 123456, chars: 1200 },
    { voice: 'siri_nora', tokens: null, chars: 40 },
  ]);
  assert.deepEqual(rows, [
    { voice: 'Aoede · American', tokens: '123.5K', chars: '1,200' },
    { voice: 'Siri Nora', tokens: fmt.NO_TOKENS, chars: '40' },
  ]);
  assert.equal(fmt.NO_TOKENS, 'n/a');
  assert.deepEqual(fmt.voiceUsageRows([{ voice: 'af_aoede', tokens: 0, chars: 3 }])[0].tokens, '0',
    'a counted zero is a number, not n/a');
  assert.deepEqual(fmt.voiceUsageRows(undefined), [], 'a payload from before R8 shows no rows');
});

await test('the hour chart scales to the busiest hour and names it', () => {
  const hours = Array(24).fill(0);
  hours[9] = 50;
  hours[21] = 100;
  const chart = fmt.hourChart(hours);
  assert.equal(chart.bars.length, 24);
  assert.equal(chart.peak, 21);
  assert.equal(chart.bars[9].share, 0.5);
  assert.equal(fmt.hourChart([]).peak, null);
});

await test('the period picker lists years newest first, the current one always, then All time', () => {
  assert.deepEqual(fmt.yearOptions([2024, 2026], 2026).map((o) => o.value), ['2026', '2024', 'all']);
  assert.deepEqual(fmt.yearOptions([], 2026).map((o) => o.label), ['2026', 'All time']);
});

await test('equivalences only say something when there is something to say', () => {
  assert.deepEqual(fmt.equivalences({ listening: {}, llm: {}, longest_streak: {} }), []);
  const lines = fmt.equivalences({
    listening: { words: 180000, seconds: 4 * 3600 }, longest_streak: { days: 3 },
    llm: { saved_in: 900, saved_out: 100 },
  });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /≈ 2 novels/);
  assert.match(lines[1], /≈ 2 feature films/);
  assert.match(lines[2], /^3 days in a row/);
  assert.match(lines[3], /^1,000 LLM tokens/);
});

await test('a comparison that would round below 0.1 is left out ("≈ 0 novels")', () => {
  assert.deepEqual(fmt.equivalences({ listening: { words: 300, seconds: 300 } }), []);
  const minutes = fmt.equivalences({ listening: { words: 9000, seconds: 10 * 60 } });
  assert.equal(minutes.length, 2);
  assert.match(minutes[0], /≈ 0\.1 novels$/);
  assert.match(minutes[1], /≈ 0\.1 feature films$/, 'marathons (0.04) are dropped');
});

// ── listenlog.js ─────────────────────────────────────────────────────────────
function harness(doc = { docId: 'a'.repeat(40), title: 'Paper A' }) {
  const sent = [];
  const timers = [];
  let current = doc;
  const log = createListenLog({
    send: (batch, opts) => { sent.push({ batch, opts }); },
    getDoc: () => current,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  return { log, sent, timers, setDoc: (d) => { current = d; } };
}
const heard = (index, page, text = 'one two three') =>
  ({ type: 'heard', index, total: 10, sentence: { text, page }, voice: 'af_aoede' });

await test('wordCount counts words in sentence objects and strings', () => {
  assert.equal(wordCount({ text: '  The  result is clear. ' }), 4);
  assert.equal(wordCount('a b'), 2);
  assert.equal(wordCount(null), 0);
});

await test('one batch adds up time, sentences, words, page turns and progress', async () => {
  const { log, sent } = harness();
  log.add({ type: 'time', seconds: 1.5, voice: 'af_aoede' });
  log.add(heard(0, 1));
  log.add(heard(1, 1));
  log.add(heard(4, 2));
  log.add({ type: 'time', seconds: -3, voice: 'af_aoede' });
  assert.equal(await log.flush(), true);
  assert.deepEqual(sent[0].batch, {
    doc_id: 'a'.repeat(40), title: 'Paper A', voice: 'af_aoede',
    seconds: 1.5, sentences: 3, words: 9, pages: 1, progress: 0.5,
  });
  assert.equal(log.pending(), null);
  assert.equal(await log.flush(), false, 'nothing pending, nothing sent');
});

await test('a new paper or voice starts a new batch; the old one goes out first', () => {
  const { log, sent, setDoc } = harness();
  log.add({ type: 'time', seconds: 2, voice: 'af_aoede' });
  log.add({ type: 'time', seconds: 3, voice: 'bm_george' });
  setDoc({ docId: 'b'.repeat(40), title: 'Paper B' });
  log.add({ type: 'time', seconds: 4, voice: 'bm_george' });
  assert.deepEqual(sent.map((s) => `${s.batch.doc_id[0]}/${s.batch.voice}/${s.batch.seconds}`),
    ['a/af_aoede/2', 'a/bm_george/3']);
  assert.equal(log.pending().seconds, 4);
});

await test('the timer flushes, a beacon flush says so, and send failures are swallowed', async () => {
  const { log, sent, timers } = harness();
  log.add({ type: 'time', seconds: 1, voice: 'af' });
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(sent.length, 1);
  log.add({ type: 'time', seconds: 1, voice: 'af' });
  await log.flush({ beacon: true });
  assert.equal(sent[1].opts.beacon, true);

  const failing = createListenLog({ send: () => { throw new Error('offline'); }, getDoc: () => ({}),
    setTimer: () => 1, clearTimer: () => {} });
  failing.add({ type: 'time', seconds: 1, voice: 'af' });
  assert.equal(await failing.flush(), false);
  const rejecting = createListenLog({ send: () => Promise.reject(new Error('500')),
    getDoc: () => ({}), setTimer: () => 1, clearTimer: () => {} });
  rejecting.add({ type: 'time', seconds: 1, voice: 'af' });
  assert.equal(await rejecting.flush(), false);
});

await test('an unknown voice name is blanked rather than rejected by the server', () => {
  const { log } = harness();
  log.add({ type: 'time', seconds: 1, voice: 'af bella, evil' });
  assert.equal(log.pending().voice, '');
});

// ── statsdialog.js ───────────────────────────────────────────────────────────
// The smallest DOM the dialog touches; installed last so the tests above stay DOM-free.
class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; }
  setAttribute() {}
  addEventListener() {}
  focus() {}
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
}
class FakeDialog extends FakeNode {
  constructor() { super('dialog'); this.open = false; this.shown = 0; }
  showModal() {
    if (this.open) throw new Error('InvalidStateError: already open');
    this.open = true;
    this.shown += 1;
  }
  close() { this.open = false; }
}
globalThis.window = { addEventListener: () => {} };
globalThis.document = { getElementById: () => null, body: new FakeNode('body'),
  createElement: (tag) => (tag === 'dialog' ? new FakeDialog() : new FakeNode(tag)) };
const { initStatsDialog } = await import('../../static/js/statsdialog.js');
const lastDialog = () => document.body.children.at(-1);

await test('a stats POST that never answers still lets the dialog open', async () => {
  const dialog = initStatsDialog(new FakeNode('button'),
    { flush: () => new Promise(() => {}), flushTimeoutMs: 5 });
  await dialog.open();
  assert.equal(lastDialog().open, true);
});

await test('a second open while one is pending or shown never calls showModal twice', async () => {
  let release;
  const dialog = initStatsDialog(new FakeNode('button'),
    { flush: () => new Promise((resolve) => { release = resolve; }), flushTimeoutMs: 1000 });
  const first = dialog.open();
  const second = dialog.open();   // a double click while the flush is in flight
  release(true);
  await Promise.all([first, second]);
  await dialog.open();            // and once more while it is showing
  assert.equal(lastDialog().shown, 1);
});

await test('the frame URL carries the open paper\'s numbers, and none without a paper (N11)', async () => {
  const frameOf = async (paper) => {
    const dialog = initStatsDialog(new FakeNode('button'), { flush: () => Promise.resolve(), paper });
    await dialog.open();
    return lastDialog().children[0].src;
  };
  assert.equal(await frameOf(() => 'doc=ab12cd34&left=3'), '/static/stats.html?embed=1&doc=ab12cd34&left=3');
  assert.equal(await frameOf(() => ''), '/static/stats.html?embed=1');
  assert.equal(await frameOf(undefined), '/static/stats.html?embed=1', 'the default reads state.js: no paper open');
});

console.log(`\nALL GREEN — ${passed} tests passed\n`);

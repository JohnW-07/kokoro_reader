/* Harness for static/js/summary.js and summarypanel.js — the Summary tab (N9). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { El } from './shellenv.mjs';
import * as rules from '../../static/js/summary.js';
import { createSummaryPanel } from '../../static/js/summarypanel.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};
const flush = () => new Promise((r) => setImmediate(r));

const sent = (text, page) => ({ text, raw: text, page, kind: 'body', items: [] });
const SCRIPT = [
  sent('Intro on page one.', 1), sent('Methods start here.', 2), sent('We used 12 GPUs.', 2),
  sent('Results follow.', 3), sent('Accuracy was 91.4%.', 3),
];
const SECTIONS = [{ index: 1, title: 'Methods', page: 2 }, { index: 3, title: 'Results', page: 3 }];

console.log('\n[1] the limits mirror the server');

await test('MAX_TEXT_CHARS and the backends equal kokoro_reader/summary.py', () => {
  const py = readFileSync(new URL('../../kokoro_reader/summary.py', import.meta.url), 'utf8');
  assert.equal(rules.MAX_TEXT_CHARS, Number(py.match(/^MAX_TEXT_CHARS = ([\d_]+)/m)[1].replace(/_/g, '')));
  assert.match(py, new RegExp(`^BACKENDS = \\("${rules.BACKEND_APPLE}", "${rules.BACKEND_QWEN}"\\)`, 'm'));
});

console.log('\n[2] scopes');

await test('pageScope joins the page and nothing else', () => {
  const scope = rules.pageScope(SCRIPT, 2);
  assert.deepEqual({ ...scope }, { kind: 'page', page: 2, label: 'page 2', text: 'Methods start here. We used 12 GPUs.', clipped: false });
  assert.ok(Object.isFrozen(scope));
  assert.equal(rules.pageScope(SCRIPT, 9), null);
  assert.equal(rules.pageScope(undefined, 1), null);
});

await test('cursorPage follows the cursor and survives an empty script', () => {
  assert.equal(rules.cursorPage({ sentences: SCRIPT, index: 4 }), 3);
  assert.equal(rules.cursorPage({ sentences: SCRIPT, index: 99 }), 3);
  assert.equal(rules.cursorPage({ sentences: [], index: 0 }), 0);
  assert.equal(rules.cursorPage(), 0);
});

await test('sectionScope runs from the heading at or before the cursor to the next one', () => {
  assert.equal(rules.sectionScope(SECTIONS, SCRIPT, 2).text, 'Methods start here. We used 12 GPUs.');
  assert.equal(rules.sectionScope(SECTIONS, SCRIPT, 4).text, 'Results follow. Accuracy was 91.4%.');
  assert.equal(rules.sectionScope(SECTIONS, SCRIPT, 4).label, '“Results”');
  assert.equal(rules.sectionScope(SECTIONS, SCRIPT, 0), null, 'before the first heading');
  assert.equal(rules.sectionScope([], SCRIPT, 2), null, 'no headings');
});

await test('a long scope is cut at a sentence boundary under the cap and says so', () => {
  const long = Array.from({ length: 400 }, (_, i) => sent(`Sentence number ${i} has some words in it.`, 1));
  const scope = rules.pageScope(long, 1);
  assert.ok(scope.text.length <= rules.MAX_TEXT_CHARS);
  assert.ok(scope.text.endsWith('in it.'));
  assert.equal(scope.clipped, true);
});

console.log('\n[3] backends and errors');

await test('Apple alone unless the reader turned the LLM on', () => {
  assert.deepEqual(rules.backendsFor({ use_llm: false }), ['apple']);
  assert.deepEqual(rules.backendsFor(undefined), ['apple']);
  assert.deepEqual(rules.backendsFor({ use_llm: true }), ['apple', 'qwen']);
});

const httpErr = (status, message) => Object.assign(new Error(message), { kind: 'http', status });

await test('requestSummary falls through a 503 to the next backend, not other errors', async () => {
  const scope = rules.pageScope(SCRIPT, 2);
  const asked = [];
  const post = async (p) => {
    asked.push(p.backend);
    if (p.backend === 'apple') throw httpErr(503, 'Apple Intelligence is turned off');
    return { summary: 'ok', backend: p.backend, cached: false };
  };
  const got = await rules.requestSummary({ post, scope, docId: 'd', backends: ['apple', 'qwen'] });
  assert.equal(got.backend, 'qwen');
  assert.deepEqual(asked, ['apple', 'qwen']);
  await assert.rejects(rules.requestSummary({ post, scope, docId: 'd', backends: ['apple'] }), /turned off/);
  let calls = 0;
  const bad = async () => { calls += 1; throw httpErr(502, 'empty'); };
  await assert.rejects(rules.requestSummary({ post: bad, scope, docId: 'd', backends: ['apple', 'qwen'] }), /empty/);
  assert.equal(calls, 1, 'a 502 is an answer, not a reason to ask the next backend');
});

await test('errorMessage names the reason', () => {
  assert.match(rules.errorMessage(httpErr(503, 'Apple Intelligence is turned off')), /unavailable: Apple Intelligence is turned off/);
  assert.match(rules.errorMessage({ kind: 'timeout' }), /too long/);
  assert.match(rules.errorMessage(httpErr(502, 'the model declined')), /Could not summarise: the model declined/);
});

await test('summarySentences splits on sentence ends, keeps decimals, and freezes', () => {
  const list = rules.summarySentences('Accuracy was 91.4% overall. It used 12 GPUs! Done?', 3);
  assert.deepEqual(list.map((s) => s.text), ['Accuracy was 91.4% overall.', 'It used 12 GPUs!', 'Done?']);
  assert.ok(Object.isFrozen(list) && list.every((s) => Object.isFrozen(s) && s.page === 3 && s.kind === 'summary'));
  assert.deepEqual(rules.summarySentences('', 1), []);
});

console.log('\n[4] the panel');

function fakeState(initial) {
  let current = Object.freeze(initial);
  const fns = new Set();
  return {
    get: () => current,
    set(patch) { current = Object.freeze({ ...current, ...patch }); fns.forEach((fn) => fn(current)); },
    subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
  };
}

function fakePlayer(log, name) {
  let running = false;
  return {
    options: null,
    state: () => ({ isRunning: running }),
    play(i) { running = true; log.push(`${name}.play(${i})`); },
    resume() { running = true; log.push(`${name}.resume`); },
    pause() { running = false; log.push(`${name}.pause`); },
    reset() { running = false; log.push(`${name}.reset`); },
  };
}

function setup({ use_llm = false, replies = {}, onVoiceUnavailable } = {}) {
  const log = [];
  const root = new El('section');
  const state = fakeState({ docId: 'doc1', sentences: SCRIPT, sections: SECTIONS, index: 2, speed: 1, options: { use_llm } });
  const main = fakePlayer(log, 'main');
  const summaryPlayer = fakePlayer(log, 'summary');
  const pending = [];
  const post = (payload) => new Promise((resolve, reject) => {
    log.push(`post(${payload.backend},p${payload.page})`);
    const canned = replies[payload.backend];
    if (canned instanceof Error) return reject(canned);
    if (canned) return resolve(canned);
    pending.push({ payload, resolve, reject });
  });
  const makePlayer = (opts) => { summaryPlayer.options = opts; log.push('makePlayer'); return summaryPlayer; };
  const panel = createSummaryPanel({ root, state, post, mainPlayer: main, makePlayer, voiceOf: (s) => s.voice || 'af_aoede', onVoiceUnavailable });
  const q = (sel) => root.querySelector(sel);
  const click = (sel) => q(sel).dispatch('click');
  return { log, root, state, main, summaryPlayer, pending, panel, q, click };
}
const REPLY = { summary: 'Methods used 12 GPUs. That is all.', backend: 'apple', cached: false };

await test('no root: inert, never throws', () => {
  const panel = createSummaryPanel({ root: null });
  panel.pause();
});

await test('page button sends the cursor page text and shows the summary with the note', async () => {
  const t = setup({ replies: { apple: REPLY } });
  t.click('.summary-btn');
  await flush();
  assert.deepEqual(t.log, ['post(apple,p2)']);
  assert.equal(t.q('.summary-result').hidden, false);
  assert.equal(t.q('.summary-text').children.length, 2);
  assert.match(t.q('.summary-note').textContent, /may omit details/i);
  assert.match(t.q('.summary-heading').textContent, /page 2 · Apple on-device model/);
});

await test('Play pauses the main reader first, then starts the summary at 0', async () => {
  const t = setup({ replies: { apple: REPLY } });
  t.main.play(5);
  t.log.length = 0;
  t.click('.summary-btn');
  await flush();
  t.click('.summary-play');
  assert.deepEqual(t.log, ['post(apple,p2)', 'makePlayer', 'main.pause', 'summary.play(0)']);
  assert.equal(t.summaryPlayer.options.getSentences().length, 2);
  assert.equal(t.summaryPlayer.options.getVoice(), 'af_aoede');
  t.click('.summary-play');
  t.click('.summary-play');
  assert.deepEqual(t.log.slice(-2), ['summary.pause', 'summary.resume']);
});

await test('panel.pause (the main reader started) pauses a running summary only', async () => {
  const t = setup({ replies: { apple: REPLY } });
  t.panel.pause();
  assert.deepEqual(t.log, []);
  t.click('.summary-btn');
  await flush();
  t.click('.summary-play');
  t.panel.pause();
  assert.equal(t.log.at(-1), 'summary.pause');
});

await test('503 from Apple falls back to Qwen only when use_llm is on', async () => {
  const off = setup({ replies: { apple: httpErr(503, 'Apple Intelligence is turned off') } });
  off.click('.summary-btn');
  await flush();
  assert.deepEqual(off.log, ['post(apple,p2)']);
  assert.match(off.q('.summary-status').textContent, /unavailable: Apple Intelligence is turned off/);
  assert.equal(off.q('.summary-result').hidden, true);

  const on = setup({ use_llm: true, replies: { apple: httpErr(503, 'off'), qwen: { ...REPLY, backend: 'qwen' } } });
  on.click('.summary-btn');
  await flush();
  assert.deepEqual(on.log, ['post(apple,p2)', 'post(qwen,p2)']);
  assert.match(on.q('.summary-heading').textContent, /local Qwen model/);
});

await test('a reply that lands after the document changed is dropped', async () => {
  const t = setup();
  t.click('.summary-btn');
  t.state.set({ docId: 'doc2' });
  t.pending[0].resolve(REPLY);
  await flush();
  assert.equal(t.q('.summary-result').hidden, true);
});

await test('a newer request supersedes an older one, and a new summary resets the player', async () => {
  const t = setup({ replies: {} });
  t.click('.summary-btn');
  await flush();
  t.pending[0].resolve(REPLY);
  await flush();
  t.click('.summary-play');
  t.q('.summary-btn').dispatch('click');
  assert.ok(t.log.includes('summary.reset'), 'new summary stops the old one');
  const older = setup();
  older.click('.summary-btn');
  older.click('.summary-btn');
  older.pending[1].resolve({ ...REPLY, summary: 'Newer one.' });
  await flush();
  older.pending[0].resolve({ ...REPLY, summary: 'Older one.' });
  await flush();
  assert.equal(older.q('.summary-text').textContent.trim(), 'Newer one.');
});

await test('the section button shows only inside a section and sends that section', async () => {
  const t = setup({ replies: { apple: REPLY } });
  const sectionBtn = t.root.querySelectorAll('.summary-btn')[1];
  t.state.set({ index: 0 });
  assert.equal(sectionBtn.hidden, true);
  t.state.set({ index: 4 });
  assert.equal(sectionBtn.hidden, false);
  sectionBtn.dispatch('click');
  await flush();
  assert.deepEqual(t.log, ['post(apple,p3)']);
  assert.match(t.q('.summary-heading').textContent, /“Results”/);
});

await test('no script: a warning, no request', async () => {
  const t = setup();
  t.state.set({ sentences: [], index: 0 });
  t.click('.summary-btn');
  await flush();
  assert.deepEqual(t.log, []);
  assert.match(t.q('.summary-status').textContent, /Nothing to summarise/);
});

await test('R6: the summary player gets the same voice fallback as the reader', async () => {
  const onVoiceUnavailable = () => {};
  const t = setup({ replies: { apple: REPLY }, onVoiceUnavailable });
  t.click('.summary-btn');
  await flush();
  t.click('.summary-play');
  assert.equal(t.summaryPlayer.options.onVoiceUnavailable, onVoiceUnavailable);
});

console.log(`\n${passed} passed`);

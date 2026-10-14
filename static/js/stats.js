// ── Reading Wrapped page ─────────────────────────────────────────────────────
// Fetches /api/stats for the chosen period and draws it. Every value goes in via
// textContent (titles come from the user's files). Inside the reader it runs in
// an iframe (?embed=1, see statsdialog.js) and asks its parent to close it. The reader
// also hands it the open paper's ETA numbers in the URL, for "This paper" (N11).

import * as fmt from './statsformat.js';
import { readPaperQuery } from './eta.js';

const API = '/api/stats';
const CLOSE_MESSAGE = 'kokoro-stats-close';
const RESET_WORD = 'reset';
const embedded = new URLSearchParams(location.search).get('embed') === '1';
const openPaper = readPaperQuery(location.search);
const $ = (id) => document.getElementById(id);
let period = '';

/** A small element builder; `text` sets textContent, other props become attributes. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  });
  children.filter((child) => child != null).forEach((child) => node.append(child));
  return node;
}

function card(label, value, note) {
  return el('div', { class: 'st-card' },
    el('p', { class: 'st-label', text: label }),
    el('p', { class: 'st-value', text: value }),
    note ? el('p', { class: 'st-note', text: note }) : null);
}

function setStatus(text, tone = '') {
  $('st-status').textContent = text;
  $('st-status').dataset.tone = tone;
}

function renderHero(s) {
  const time = fmt.heroTime(s.listening.seconds);
  $('st-range').textContent = fmt.rangeTitle(s.range);
  $('st-hero-value').textContent = time.value;
  $('st-hero-unit').textContent = time.unit;
  $('st-hero-sub').textContent = [
    fmt.plural(s.listening.sentences, 'sentence', 'sentences'),
    fmt.plural(s.listening.words, 'word', 'words'),
    `${fmt.plural(s.listening.days, 'day', 'days')} with a voice on`,
  ].join(' · ');
}

function renderCards(s) {
  const top = s.voices[0];
  $('st-cards').replaceChildren(
    card('Papers opened', fmt.formatCount(s.papers.opened)),
    card('Papers finished', fmt.formatCount(s.papers.finished), '90% or more heard'),
    card('Pages turned', fmt.formatCount(s.listening.pages), 'while listening'),
    card('Highlights', fmt.formatCount(s.notes.highlights)),
    card('Words of notes', fmt.formatCount(s.notes.words)),
    card('Favorite voice', fmt.voiceLabel(s.favorite_voice),
      top ? fmt.formatDuration(top.seconds) : 'Play a paper to pick one'),
  );
}

function renderHours(s) {
  const chart = fmt.hourChart(s.hours);
  const bars = chart.bars.map((bar) => el('span', {
    class: bar.hour === chart.peak ? 'st-bar is-peak' : 'st-bar',
    style: `--share: ${bar.share}`,
    title: `${bar.label}: ${fmt.formatDuration(bar.seconds)}`,
  }));
  $('st-hours').replaceChildren(...bars);
  $('st-hours').setAttribute('aria-label', chart.peak === null
    ? 'No listening yet'
    : `Listening by hour of day; most at ${fmt.hourLabel(chart.peak)}`);
}

function renderTop(s) {
  const most = s.top_papers[0]?.seconds || 0;
  const rows = s.top_papers.map((paper) => el('li', { class: 'st-paper' },
    el('span', { class: 'st-paper-title', text: fmt.paperTitle(paper.title) }),
    el('span', { class: 'st-paper-time', text: fmt.formatDuration(paper.seconds) }),
    el('span', { class: 'st-paper-bar', style: `--share: ${most ? paper.seconds / most : 0}`,
      'aria-hidden': 'true' })));
  $('st-top').replaceChildren(...(rows.length ? rows
    : [el('li', { class: 'st-empty', text: 'Nothing played yet in this period.' })]));
}

function moment(term, value, note) {
  return [el('dt', { text: term }), el('dd', {}, el('span', { text: value }),
    note ? el('small', { text: note }) : null)];
}

function renderMoments(s) {
  const busy = s.busiest_day;
  const streak = s.longest_streak;
  const peak = fmt.hourChart(s.hours).peak;
  $('st-moments').replaceChildren(
    ...moment('Busiest day', busy ? fmt.dayLabel(busy.date) : '—',
      busy ? fmt.formatDuration(busy.seconds) : null),
    ...moment('Longest streak', fmt.plural(streak.days, 'day', 'days'),
      streak.days > 1 ? `${fmt.dayLabel(streak.start)} – ${fmt.dayLabel(streak.end)}` : null),
    ...moment('Favorite hour', peak === null ? '—' : fmt.hourLabel(peak)),
  );
}

/** The open paper: all-time listening from the server, the rest from the reader's cursor. */
function renderPaper(s) {
  const panel = $('st-paper-panel');
  panel.hidden = !openPaper || !s.paper;
  if (panel.hidden) return;
  $('st-paper-name').textContent = fmt.paperTitle(s.paper.title);
  $('st-paper').replaceChildren(
    card('Time with it', fmt.formatDuration(s.paper.seconds), 'all time'),
    card('Heard', fmt.formatPercent(openPaper.heardShare), 'up to where you are'),
    card('Left on this page', `≈${fmt.formatDuration(openPaper.pageSeconds)}`),
    card('Left in the paper', `≈${fmt.formatDuration(openPaper.docSeconds)}`, 'at this voice and speed'),
    card('Sentences left', fmt.formatCount(openPaper.sentencesLeft)),
  );
}

function renderMachine(s) {
  const { llm, tts } = s;
  $('st-machine').replaceChildren(
    card('LLM tokens in', fmt.formatCount(llm.tokens_in), `${fmt.formatCount(llm.calls)} calls`),
    card('LLM tokens out', fmt.formatCount(llm.tokens_out)),
    card('Tokens saved by cache', fmt.formatCount(llm.saved_in + llm.saved_out),
      `${fmt.formatCount(llm.hits)} cache hits`),
    card('Kokoro phoneme tokens', fmt.formatCount(tts.tokens),
      `≈${fmt.formatCount(tts.tokens_saved)} saved by cache`),
    card('Characters voiced', fmt.formatCount(tts.chars)),
    card('Audio generated', fmt.formatDuration(tts.audio_seconds)),
    card('Audio cache hit rate', fmt.formatPercent(tts.hit_rate),
      `${fmt.formatCount(tts.hits)} of ${fmt.formatCount(tts.requests)} sentences`),
  );
}

function renderVoices(s) {
  const rows = fmt.voiceUsageRows(s.tts.by_voice);
  $('st-voices').hidden = rows.length === 0;
  $('st-voices-body').replaceChildren(...rows.map((r) => el('tr', {},
    el('th', { scope: 'row', text: r.voice }), el('td', { text: r.tokens }), el('td', { text: r.chars }))));
}

function renderFun(s) {
  const lines = fmt.equivalences(s);
  $('st-fun').replaceChildren(...(lines.length
    ? lines.map((text) => el('li', { text }))
    : [el('li', { class: 'st-empty', text: 'Play a paper and come back for the fun facts.' })]));
}

function renderPicker(s) {
  const select = $('st-year');
  const current = new Date().getFullYear();
  const options = fmt.yearOptions(s.years, current)
    .map((o) => el('option', { value: o.value, text: o.label }));
  select.replaceChildren(...options);
  select.value = s.range;
}

function render(s) {
  renderPicker(s);
  renderHero(s);
  renderPaper(s);
  renderCards(s);
  renderHours(s);
  renderTop(s);
  renderMoments(s);
  renderMachine(s);
  renderVoices(s);
  renderFun(s);
  $('st-since').textContent = s.since
    ? `Counting since ${fmt.dayLabel(s.since.slice(0, 10))}. Stats stay on this Mac.`
    : 'Stats stay on this Mac.';
}

async function load(year = period) {
  period = year;
  setStatus('Loading…');
  document.body.setAttribute('aria-busy', 'true');
  try {
    const params = new URLSearchParams({ ...(year ? { year } : {}), ...(openPaper ? { doc: openPaper.docId } : {}) });
    const query = params.toString() ? `?${params}` : '';
    const res = await fetch(`${API}${query}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    setStatus('');
  } catch (err) {
    setStatus(`Couldn't load your stats (${err.message}).`, 'error');
  } finally {
    document.body.removeAttribute('aria-busy');
  }
}

function showConfirm(open) {
  $('st-confirm').hidden = !open;
  $('st-reset-start').hidden = open;
  (open ? $('st-reset-cancel') : $('st-reset-start')).focus();
}

async function resetStats() {
  $('st-reset-go').disabled = true;
  try {
    const res = await fetch(`${API}/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: RESET_WORD }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showConfirm(false);
    await load();
    setStatus('Stats reset.');
  } catch (err) {
    setStatus(`Couldn't reset (${err.message}).`, 'error');
  } finally {
    $('st-reset-go').disabled = false;
  }
}

function close() {
  if (embedded) window.parent.postMessage({ type: CLOSE_MESSAGE }, location.origin);
}

function bind() {
  $('st-year').addEventListener('change', (ev) => load(ev.target.value));
  $('st-reset-start').addEventListener('click', () => showConfirm(true));
  $('st-reset-cancel').addEventListener('click', () => showConfirm(false));
  $('st-reset-go').addEventListener('click', resetStats);
  $('st-close').hidden = !embedded;
  $('st-close').addEventListener('click', close);
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!$('st-confirm').hidden) showConfirm(false);
    else close();
  });
}

bind();
load();

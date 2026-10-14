// ── Stats formatting ─────────────────────────────────────────────────────────
// Pure helpers for the Wrapped page (stats.js): numbers, durations, labels and
// the fun equivalences. No DOM, no fetch, so tests/js/stats.test.mjs covers them.

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const NOON = 12;
/** A typical novel (~90k words), a feature film (2 h), a marathon's average finish (4.5 h). */
export const NOVEL_WORDS = 90000;
export const FILM_SECONDS = 2 * SECONDS_PER_HOUR;
export const MARATHON_SECONDS = 4.5 * SECONDS_PER_HOUR;
/** Below this many hours the hero number is shown in minutes. */
const HOURS_THRESHOLD = 1;
const COMPACT_FROM = 100000;
const PERCENT = 100;
const ONE_DECIMAL = 10;
/** A comparison that rounds below this says nothing ("≈ 0 novels") and is left out. */
const MIN_RATIO = 0.1;

const VOICE_ACCENTS = Object.freeze({
  a: 'American', b: 'British', e: 'Spanish', f: 'French', h: 'Hindi',
  i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Mandarin',
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const finite = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/** 1234567 → "1,234,567"; from 100k up, "1.2M" style. */
export function formatCount(n) {
  const value = Math.round(finite(n));
  if (Math.abs(value) < COMPACT_FROM) return value.toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
    .format(value);
}

/** Seconds → "2 h 05 min", "12 min", "<1 min", "0 min". */
export function formatDuration(seconds) {
  const s = Math.max(0, finite(seconds));
  if (s === 0) return '0 min';
  if (s < SECONDS_PER_MINUTE) return '<1 min';
  const hours = Math.floor(s / SECONDS_PER_HOUR);
  const minutes = Math.floor((s % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  if (hours === 0) return `${minutes} min`;
  return `${hours.toLocaleString('en-US')} h ${String(minutes).padStart(2, '0')} min`;
}

/** The hero number: `{value, unit}` in hours (one decimal), minutes under an hour, seconds under a minute. */
export function heroTime(seconds) {
  const s = Math.max(0, finite(seconds));
  const hours = s / SECONDS_PER_HOUR;
  if (hours >= HOURS_THRESHOLD) {
    const value = hours.toFixed(1).replace(/\.0$/, '');
    return { value, unit: value === '1' ? 'hour' : 'hours' };
  }
  if (s < SECONDS_PER_MINUTE) {
    const secs = Math.round(s);
    return { value: String(secs), unit: secs === 1 ? 'second' : 'seconds' };
  }
  const minutes = Math.round(s / SECONDS_PER_MINUTE);
  return { value: String(minutes), unit: minutes === 1 ? 'minute' : 'minutes' };
}

/** 0.834 → "83%"; null/undefined (no requests yet) → "—". */
export function formatPercent(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) return '—';
  return `${Math.round(Number(rate) * PERCENT)}%`;
}

/** "af_aoede" → "Aoede · American"; anything unexpected is shown as given. */
export function voiceLabel(voice) {
  const match = /^([a-z])[a-z]_([a-z0-9]+)$/i.exec(voice || '');
  if (!match) return voice || '—';
  const name = match[2].charAt(0).toUpperCase() + match[2].slice(1);
  const accent = VOICE_ACCENTS[match[1].toLowerCase()];
  return accent ? `${name} · ${accent}` : name;
}

/** Siri renders without phoneme tokens, so its row says so instead of showing 0 (R8). */
export const NO_TOKENS = 'n/a';
const SIRI_PREFIX = 'siri_';

function voiceName(voice) {
  if (!String(voice).startsWith(SIRI_PREFIX)) return voiceLabel(voice);
  const name = voice.slice(SIRI_PREFIX.length);
  return `Siri ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** /api/stats tts.by_voice → table rows; tokens is null where none were counted. */
export function voiceUsageRows(byVoice) {
  return (byVoice || []).map((row) => ({
    voice: voiceName(row.voice),
    tokens: row.tokens === null || row.tokens === undefined ? NO_TOKENS : formatCount(row.tokens),
    chars: formatCount(row.chars),
  }));
}

/** "Attention.pdf" → "Attention"; blank → "Untitled paper". */
export function paperTitle(title) {
  const clean = String(title || '').trim().replace(/\.pdf$/i, '');
  return clean || 'Untitled paper';
}

/** "2026-03-14" → "Sat, Mar 14" (calendar date, no time-zone shift). */
export function dayLabel(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  if (!match) return '—';
  const [y, m, d] = match.slice(1).map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[day.getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

/** 0 → "12 am", 13 → "1 pm". */
export function hourLabel(hour) {
  const h = ((Math.round(finite(hour)) % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
  const twelve = h % NOON === 0 ? NOON : h % NOON;
  return `${twelve} ${h < NOON ? 'am' : 'pm'}`;
}

/**
 * The hour-of-day chart: 24 bars scaled to the busiest hour, plus that peak.
 * @param {number[]} hours seconds per hour, index 0–23
 */
export function hourChart(hours) {
  const values = Array.from({ length: HOURS_PER_DAY }, (_, h) => Math.max(0, finite(hours?.[h])));
  const max = Math.max(...values);
  const peak = max > 0 ? values.indexOf(max) : null;
  return {
    bars: values.map((seconds, hour) => ({
      hour, seconds, share: max > 0 ? seconds / max : 0, label: hourLabel(hour),
    })),
    peak,
  };
}

/** The period picker: All time, then every year with data, newest first, always `current`. */
export function yearOptions(years, current) {
  const list = [...new Set([...(years || []), current].filter(Number.isInteger))]
    .sort((a, b) => b - a);
  return [...list.map((y) => ({ value: String(y), label: String(y) })),
    { value: 'all', label: 'All time' }];
}

/** 1 → "1 day", 3 → "3 days" (the count formatted). */
export const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;
const ratio = (n, per) => Math.round((finite(n) / per) * ONE_DECIMAL) / ONE_DECIMAL;

/** Fun comparisons for the summary; only the ones with something to say. */
export function equivalences(summary) {
  const listening = summary?.listening || {};
  const words = finite(listening.words);
  const seconds = finite(listening.seconds);
  const llm = summary?.llm || {};
  const out = [];
  const novels = ratio(words, NOVEL_WORDS);
  if (novels >= MIN_RATIO) out.push(`${formatCount(words)} words heard ≈ ${novels} novels`);
  const likened = [[ratio(seconds, FILM_SECONDS), 'feature films'],
    [ratio(seconds, MARATHON_SECONDS), 'marathons']].filter(([n]) => n >= MIN_RATIO);
  if (likened.length) {
    out.push(`${formatDuration(seconds)} of listening ≈ `
      + likened.map(([n, what]) => `${n} ${what}`).join(' or '));
  }
  const streak = finite(summary?.longest_streak?.days);
  if (streak > 1) out.push(`${plural(streak, 'day', 'days')} in a row with a paper open`);
  const saved = finite(llm.saved_in) + finite(llm.saved_out);
  if (saved > 0) out.push(`${formatCount(saved)} LLM tokens never had to be generated twice`);
  return out;
}

/** The headline under the title: what range this is. */
export function rangeTitle(range) {
  return range === 'all' ? 'All time' : `Your ${range}`;
}

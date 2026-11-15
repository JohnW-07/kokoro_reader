// ── Application state ────────────────────────────────────────────────────────
// The single place mutable state is allowed to live. Updates replace the state
// object rather than mutating it, so subscribers can compare cheaply and no
// module can quietly change another's view of the world.

import { loadSubs } from './subs.js';
import { clampZoom, ZOOM_FIT } from './zoom.js';
import { clampPitch, clampExpr } from './voiceshape.js';
import { clampDb, clampEven } from './voicefx.js';
import { VIEW_MARGIN, VIEW_SECTIONS } from './anchors.js';
import { cleanRates, ETA_SCOPES } from './eta.js';

/** @typedef {'yellow'|'green'|'blue'|'pink'} HighlightColor */

const DEFAULT_OPTIONS = Object.freeze({
  read_headings: true,
  read_equations: true,
  read_captions: true,
  read_tables: false,
  read_footnotes: false,
  read_references: false,
  use_llm: false,
});

const INITIAL = Object.freeze({
  docId: null,
  docName: '',
  numPages: 0,
  sentences: [],
  scriptStats: null,
  /** The paper's own headings, `{page, y, title}` (U8); see anchors.js. */
  sections: [],
  /** Margin lines that may print a page number, `{page, text, kind}` (N8); see pagelabels.js. */
  pageMarks: [],
  index: 0,
  voice: 'af_aoede',
  /** Dev switch: synthesise with the Siri voice instead of `voice`; see engineswitch.js. */
  siriVoice: false,
  speed: 1.0,
  /** Kokoro's native voice knobs (V1); see voiceshape.js. 1 is the model's own voice. */
  voicePitch: 1,
  voiceExpr: 1,
  /** Bass/Treble (dB) and Even-out (0–1) applied after generation (V1); see voicefx.js. */
  fxBass: 0,
  fxTreble: 0,
  fxEven: 0,
  /** Page zoom; 1 is fit-to-width. See zoom.js. */
  zoom: ZOOM_FIT,
  options: DEFAULT_OPTIONS,
  highlights: [],
  /** The notes editor's blocks for the open paper (T7); see blocks.js. */
  blocks: [],
  llmAvailable: false,
  llmModel: '',
  loading: false,
  sidebarCollapsed: false,
  notesCollapsed: false,
  /** The Highlights list at the top of the notes column folded away (R3). */
  highlightsCollapsed: false,
  /** How the notes column is laid out (U8): beside the text, or by section. */
  notesView: VIEW_MARGIN,
  /** Global "say instead" substitutions (T6); see subs.js. */
  subs: Object.freeze([]),
  /** The view scrolls along with the voice (N12); see follow.js. */
  followEnabled: true,
  /** Follow, Snap and jump scrolls glide, even under Reduce Motion (N12). */
  smoothScroll: true,
  /** Learnt speaking rates per voice and speed, for the reading ETA (N11); see eta.js. */
  etaRates: Object.freeze({}),
  /** What the ETA pill counts down to (eta.js ETA_SCOPES), and whether it adds wpm and TTS time. */
  etaScope: 'page',
  etaStats: false,
  /** The paper's contents entries (toc.js), set by nav.js; the ETA's sections and chapters. */
  tocEntries: Object.freeze([]),
  /** Colour theme id, or 'system' (docs/19); themeboot.js resolves and applies it. */
  theme: 'light',
});

let current = INITIAL;
const listeners = new Set();

/** @returns {typeof INITIAL} the current immutable state snapshot */
export function get() {
  return current;
}

/**
 * Merge `patch` into the state and notify subscribers.
 * @param {object} patch
 * @returns {object} the new state
 */
export function set(patch) {
  const next = Object.freeze({ ...current, ...patch });
  if (next === current) return current;
  current = next;
  for (const fn of listeners) {
    try {
      fn(current);
    } catch (err) {
      // A broken subscriber must not stop the others or corrupt state.
      console.error('state subscriber failed', err);
    }
  }
  return current;
}

/**
 * @param {(s: object) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reset everything that belongs to a document, keeping user preferences. */
export function resetDocument() {
  return set({
    docId: null,
    docName: '',
    numPages: 0,
    sentences: [],
    scriptStats: null,
    sections: [],
    tocEntries: [],
    pageMarks: [],
    index: 0,
    highlights: [],
    blocks: [],
  });
}

export { DEFAULT_OPTIONS };

// ── Preference persistence ───────────────────────────────────────────────────
// Voice, speed, zoom, read-options, substitutions and the panel layout are per-user, not per-document; localStorage is
// the right home for them and a failure to read it must never block startup.

const PREF_KEY = 'kokoro.prefs.v2';

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    set({
      voice: typeof saved.voice === 'string' ? saved.voice : current.voice,
      speed: Number.isFinite(saved.speed) ? clampSpeed(saved.speed) : current.speed,
      zoom: Number.isFinite(saved.zoom) ? clampZoom(saved.zoom) : current.zoom,
      options: { ...DEFAULT_OPTIONS, ...(saved.options || {}) },
      // Absent in prefs written before the collapsible sidebar: those users start expanded.
      sidebarCollapsed: saved.sidebarCollapsed === true,
      // Same for prefs written before the notes column could collapse.
      notesCollapsed: saved.notesCollapsed === true,
      // And before the Highlights list moved into it (R3): open, as its old tab was.
      highlightsCollapsed: saved.highlightsCollapsed === true,
      // Only the section view has to be asked for; margin is the default and the fallback.
      notesView: saved.notesView === VIEW_SECTIONS ? VIEW_SECTIONS : VIEW_MARGIN,
      subs: loadSubs(saved.subs),
      siriVoice: saved.siriVoice === true,
      // Absent in prefs written before N12: those users keep following, smoothly.
      followEnabled: saved.followEnabled !== false,
      smoothScroll: saved.smoothScroll !== false,
      etaRates: cleanRates(saved.etaRates),
      etaScope: ETA_SCOPES.includes(saved.etaScope) ? saved.etaScope : 'page',
      etaStats: saved.etaStats === true,
      // Absent in prefs written before V1: clampPitch/clampExpr turn that into neutral.
      voicePitch: clampPitch(saved.voicePitch),
      voiceExpr: clampExpr(saved.voiceExpr),
      fxBass: clampDb(saved.fxBass),
      fxTreble: clampDb(saved.fxTreble),
      fxEven: clampEven(saved.fxEven),
      // Absent before docs/19: Light. An unknown id also draws Light (themeboot.js).
      theme: typeof saved.theme === 'string' ? saved.theme : current.theme,
    });
  } catch (err) {
    console.warn('could not read saved preferences', err);
  }
}

export function savePrefs() {
  try {
    const {
      voice, speed, zoom, options, sidebarCollapsed, notesCollapsed, highlightsCollapsed, notesView, subs, siriVoice,
      followEnabled, smoothScroll, etaRates, etaScope, etaStats, voicePitch, voiceExpr, fxBass, fxTreble, fxEven, theme,
    } = current;
    localStorage.setItem(PREF_KEY, JSON.stringify({
      voice, speed, zoom, options, sidebarCollapsed, notesCollapsed, highlightsCollapsed, notesView, subs, siriVoice,
      followEnabled, smoothScroll, etaRates, etaScope, etaStats, voicePitch, voiceExpr, fxBass, fxTreble, fxEven, theme,
    }));
  } catch (err) {
    console.warn('could not save preferences', err);
  }
}

const MIN_SPEED = 0.5;
const MAX_SPEED = 2.0;

export function clampSpeed(v) {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(v) || 1.0));
}

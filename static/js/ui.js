// ── Chrome: status, toasts, tabs, options ─────────────────────────────────
// Presentation only. Nothing here owns application state; callers pass data in
// and hand back callbacks.

import { pillText } from './pagelabels.js';

const TOAST_MS = 4200;

const el = (id) => document.getElementById(id);

// ── Status bar ───────────────────────────────────────────────────────────────

/**
 * @param {string} message
 * @param {'info'|'loading'|'warn'|'error'|'recovering'} [level]
 * @param {{announce?: boolean}} [opts] announce: false keeps a screen reader quiet, for
 *   lines rewritten every sentence that would otherwise talk over the voice (A7)
 */
export function setStatus(message, level = 'info', { announce = true } = {}) {
  const bar = el('status-bar');
  if (!bar) return;
  // Set before the text changes: a live region judges a change by its politeness then.
  bar.setAttribute('aria-live', announce ? 'polite' : 'off');
  bar.className = level === 'info' ? '' : level;
  bar.textContent = '';
  if (level === 'loading' || level === 'recovering') {
    const spin = document.createElement('div');
    spin.className = 'spinner';
    bar.appendChild(spin);
  }
  bar.appendChild(document.createTextNode(message));
}

let toastTimer = null;

/** @param {string} message @param {'info'|'warn'|'error'} [level] */
export function toast(message, level = 'info') {
  const node = el('toast');
  if (!node) return;
  node.textContent = message;
  node.className = level === 'info' ? '' : level;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, TOAST_MS);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });
}

export function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${name}`);
  });
}

// ── Read options ─────────────────────────────────────────────────────────────

/**
 * @param {object} options current values
 * @param {(patch:object) => void} onChange
 */
export function bindOptions(options, onChange) {
  document.querySelectorAll('[data-opt]').forEach((input) => {
    input.checked = Boolean(options[input.dataset.opt]);
    input.addEventListener('change', () => onChange({ [input.dataset.opt]: input.checked }));
  });
}

export function syncOptions(options) {
  document.querySelectorAll('[data-opt]').forEach((input) => {
    input.checked = Boolean(options[input.dataset.opt]);
  });
}

/** Reflect whether the local LLM is usable, and disable the toggle when it is not. */
export function setLlmAvailability({ available, model }) {
  const row = el('llm-row');
  const hint = el('llm-hint');
  const box = row?.querySelector('input');
  if (!row || !hint || !box) return;
  hint.textContent = available ? (model || 'local model') : 'model not installed';
  box.disabled = !available;
  row.classList.toggle('disabled', !available);
  if (!available) box.checked = false;
}

// The rail's buttons forward to these, so they share their enabled state.
const TRANSPORT_IDS = ['prevBtn', 'ppBtn', 'nextBtn', 'recoverBtn', 'rebuildBtn',
  'railPrevBtn', 'railPpBtn', 'railNextBtn'];
const PLAY_BUTTON_IDS = ['ppBtn', 'railPpBtn'];
const SPEED_LABEL_IDS = ['speedVal', 'railSpeedBtn'];

export function setControlsEnabled(on) {
  TRANSPORT_IDS.forEach((id) => {
    const node = el(id);
    if (node) node.disabled = !on;
  });
}

/** Both play buttons carry a play and a pause glyph; the class picks which shows. */
export function setPlayIcon(isPlaying) {
  PLAY_BUTTON_IDS.forEach((id) => {
    const btn = el(id);
    if (!btn) return;
    btn.classList.toggle('is-playing', isPlaying);
    btn.setAttribute('aria-pressed', String(isPlaying));
  });
}

/** @param {string} label e.g. `1.25×` */
export function setSpeedLabel(label) {
  SPEED_LABEL_IDS.forEach((id) => {
    const node = el(id);
    if (node) node.textContent = label;
  });
}

let pill = Object.freeze({ page: 0, total: 0, labels: null });

function renderPagePill() {
  const node = el('page-pill');
  if (!node) return;
  node.hidden = !pill.total;
  node.textContent = pillText(pill.page, pill.total, pill.labels);
}

export function setPagePill(page, total) {
  pill = Object.freeze({ ...pill, page, total });
  renderPagePill();
}

/** The printed page numbers (N8): the pill shows "p. 11 · 23/40" where they differ. */
export function setPageLabels(labels) {
  pill = Object.freeze({ ...pill, labels });
  renderPagePill();
}

export function setDocName(name, loaded) {
  const zone = el('drop-zone');
  if (!zone) return;
  zone.textContent = loaded ? name : 'Drop a PDF here or click to browse';
  zone.className = loaded ? 'loaded' : '';
}

// Chrome with nothing to act on until a paper is open: shown exactly when the welcome is not.
const DOCUMENT_CHROME_IDS = ['transport', 'toc-section', 'railPpBtn', 'railPrevBtn', 'railNextBtn',
  'railFollowBtn', 'notes-view'];

export function hideWelcome(hidden) {
  const w = el('welcome');
  if (w) w.style.display = hidden ? 'none' : '';
  DOCUMENT_CHROME_IDS.forEach((id) => {
    const node = el(id);
    if (node) node.hidden = !hidden;
  });
}

export { el };

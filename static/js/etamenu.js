// ── ETA dropdown ─────────────────────────────────────────────────────────────
// The ETA pill opens a small menu: what the time counts down to (page, section, chapter,
// whole paper, each with its own time; the ones the paper lacks here are disabled) and a
// switch that adds wpm and TTS time to the pill. Styled as the read menu (.read-menu).

import { ETA_SCOPES, formatEta, shownScope } from './eta.js';

const LABELS = Object.freeze({ page: 'Page', section: 'Section', chapter: 'Chapter', paper: 'Whole paper' });

function makeItem(role, key, label) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'read-menu-item eta-item';
  item.setAttribute('role', role);
  item.dataset.key = key;
  const name = document.createElement('span');
  name.className = 'eta-item-name';
  name.textContent = label;
  const time = document.createElement('span');
  time.className = 'eta-item-time';
  item.append(name, time);
  return item;
}

/**
 * @param {{ pill: HTMLElement, menu: HTMLElement, getLeft: () => object|null,
 *           getState: () => {etaScope: string, etaStats: boolean},
 *           onScope: (scope: string) => void, onStats: (on: boolean) => void }} deps
 * @returns {{ refresh: () => void, close: (refocus?: boolean) => void }}
 */
export function createEtaMenu({ pill, menu, getLeft, getState, onScope, onStats }) {
  const scopeItems = ETA_SCOPES.map((k) => makeItem('menuitemradio', k, LABELS[k]));
  const statsItem = makeItem('menuitemcheckbox', 'stats', 'Show wpm and TTS time');
  const sep = document.createElement('div');
  sep.className = 'eta-sep';
  sep.setAttribute('role', 'separator');
  menu.append(...scopeItems, sep, statsItem);

  const isOpen = () => menu.classList.contains('is-open');

  function refresh() {
    const left = getLeft();
    const { etaScope, etaStats } = getState();
    const shown = shownScope(left, etaScope);
    scopeItems.forEach((item) => {
      const has = Boolean(left && item.dataset.key in left);
      item.disabled = !has;
      item.setAttribute('aria-checked', String(item.dataset.key === shown));
      item.lastChild.textContent = has ? formatEta(left[item.dataset.key]) : '—';
    });
    statsItem.setAttribute('aria-checked', String(Boolean(etaStats)));
  }

  function open() {
    refresh();
    menu.classList.add('is-open');
    pill.setAttribute('aria-expanded', 'true');
    menu.querySelector('.eta-item[aria-checked="true"]:not(:disabled)')?.focus({ preventScroll: true });
  }

  function close(refocus = false) {
    if (!isOpen()) return;
    menu.classList.remove('is-open');
    pill.setAttribute('aria-expanded', 'false');
    if (refocus) pill.focus({ preventScroll: true });
  }

  pill.addEventListener('click', () => (isOpen() ? close() : open()));
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.eta-item');
    if (!item || item.disabled) return;
    if (item === statsItem) { onStats(!getState().etaStats); refresh(); return; }   // a switch: stays open
    onScope(item.dataset.key);
    close(true);
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(true); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); return; }   // not the global shortcuts
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll('.eta-item:not(:disabled)')];
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(items.indexOf(document.activeElement) + step + items.length) % items.length]?.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !menu.contains(e.target) && !pill.contains(e.target)) close();
  }, true);

  return { refresh: () => { if (isOpen()) refresh(); }, close };
}

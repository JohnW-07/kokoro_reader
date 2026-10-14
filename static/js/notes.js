/**
 * notes.js — the Highlights section at the top of the notes column: every highlight and its
 * note, under a heading that folds the list away (R3).
 *
 * Pure list/filter/export helpers are exported separately so they can be tested
 * without a DOM. The panel never uses `confirm()`/`alert()`/`prompt()`: native
 * modal dialogs freeze the pywebview bridge.
 *
 * No imports. Collaborators arrive through `createNotesPanel` options.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const COLORS = ['yellow', 'green', 'blue', 'pink'];
/** Rows rendered before the "show more" cut-off — 5000 DOM rows is not an option. */
const PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 120;
const TEXT_CLAMP_CHARS = 400;
/** The folding part of the panel; the app has one panel, so one id. */
const CONTENT_ID = 'highlights-list';

// ── Pure helpers (exported for tests) ─────────────────────────────────────────

/**
 * Filter/search predicate for one highlight.
 * @param {object} highlight
 * @param {{colors?:string[]|Set<string>, query?:string, notesOnly?:boolean}} filter
 * @returns {boolean}
 */
export function matchesFilter(highlight, filter = {}) {
  if (!highlight) return false;
  const colors = filter.colors instanceof Set ? filter.colors : new Set(filter.colors || []);
  if (colors.size > 0 && !colors.has(highlight.color)) return false;
  if (filter.notesOnly && !String(highlight.note || '').trim()) return false;
  const query = String(filter.query || '').trim().toLowerCase();
  if (!query) return true;
  const haystack = `${highlight.text || ''}\n${highlight.note || ''}`.toLowerCase();
  return haystack.includes(query);
}

const byNewestFirst = (a, b) =>
  String(b.created_at || '').localeCompare(String(a.created_at || '')) ||
  String(b.id || '').localeCompare(String(a.id || ''));

/**
 * Group highlights by page, ascending page, newest-first within a page.
 * @param {Array<object>} highlights
 * @returns {Array<{page:number, items:Array<object>}>}
 */
export function groupByPage(highlights) {
  const pages = new Map();
  for (const highlight of highlights || []) {
    const page = Number(highlight.page) || 1;
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(highlight);
  }
  return [...pages.keys()]
    .sort((a, b) => a - b)
    .map((page) => ({ page, items: [...pages.get(page)].sort(byNewestFirst) }));
}

const byOldestFirst = (a, b) =>
  String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
  String(a.id || '').localeCompare(String(b.id || ''));

function highlightMarkdown(highlight) {
  const quoted = String(highlight.text || '').trim() || '(no text)';
  const lines = quoted.split('\n').map((line) => `> ${line}`);
  const note = String(highlight.note || '').trim();
  if (note) lines.push('', `*${note}*`);
  return [...lines, '', `(${highlight.color})`, ''];
}

/**
 * Deterministic Markdown export, grouped by page in page order.
 * Mirrors `kokoro_reader.notes_store.export_markdown` so both sides agree.
 * @param {Array<object>} highlights
 * @param {{title?:string}} [options]
 * @returns {string}
 */
export function toMarkdown(highlights, options = {}) {
  const title = String(options.title || '').trim() || 'Highlights';
  const lines = [`# ${title}`, ''];
  const groups = groupByPage(highlights);
  if (groups.length === 0) return [...lines, '*No highlights yet.*', ''].join('\n');
  for (const group of groups) {
    lines.push(`## Page ${group.page}`, '');
    for (const highlight of [...group.items].sort(byOldestFirst)) {
      lines.push(...highlightMarkdown(highlight));
    }
  }
  return lines.join('\n');
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  return node;
}

function button(className, label, text, attrs) {
  const node = el('button', className, { type: 'button', title: label, 'aria-label': label, ...attrs });
  node.textContent = text;
  return node;
}

function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => timer && clearTimeout(timer);
  return wrapped;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * @param {{root:HTMLElement, onJump?:function, onUpdate?:function,
 *          onDelete?:function, onExport?:function,
 *          collapsed?:boolean, onToggle?:(collapsed:boolean) => void}} options
 *   collapsed: start with the list folded away (the saved preference);
 *   onToggle: the reader folded or unfolded it
 */
export function createNotesPanel(options = {}) {
  const { root, onJump, onUpdate, onDelete, onExport, onToggle } = options;
  if (!root) throw new Error('createNotesPanel requires a root element');

  let highlights = [];
  let activeId = null;
  let editingId = null;
  let confirmingId = null;
  let limit = PAGE_SIZE;
  const filter = { colors: new Set(), query: '', notesOnly: false };

  const listEl = el('div', 'nt-list', { role: 'list' });
  const countEl = el('span', 'nt-count');
  const contentEl = Object.assign(el('div', 'nt-content'), { id: CONTENT_ID });
  const toggleEl = el('button', 'nt-disclosure', { type: 'button', 'aria-controls': CONTENT_ID });
  const searchEl = el('input', 'nt-search', {
    type: 'search',
    placeholder: 'Search text and notes…',
    title: 'Search highlights',
    'aria-label': 'Search highlights',
  });

  // ── chrome ────────────────────────────────────────────────────────────────

  function setCollapsed(collapsed) {
    contentEl.hidden = collapsed;
    root.classList.toggle('is-collapsed', collapsed);
    toggleEl.setAttribute('aria-expanded', String(!collapsed));
    toggleEl.title = collapsed ? 'Show the highlights' : 'Hide the highlights';
  }

  function buildHeader() {
    const head = el('div', 'nt-head');
    const title = el('span', 'label');
    title.textContent = 'Highlights';
    toggleEl.append(el('span', 'nt-chevron', { 'aria-hidden': 'true' }), title, countEl);
    toggleEl.addEventListener('click', () => {
      const collapsed = !contentEl.hidden;
      setCollapsed(collapsed);
      if (typeof onToggle === 'function') onToggle(collapsed);
    });
    const exportRow = el('div', 'nt-export');
    exportRow.append(
      button('nt-mini', 'Export notes and highlights as Markdown', 'MD', { 'data-export': 'md' }),
      button('nt-mini', 'Export highlights as JSON', 'JSON', { 'data-export': 'json' }),
    );
    exportRow.addEventListener('click', (event) => {
      const format = event.target.closest('button')?.getAttribute('data-export');
      if (format && typeof onExport === 'function') onExport(format);
    });
    head.append(toggleEl, exportRow);
    return head;
  }

  function buildFilters() {
    const row = el('div', 'nt-filters');
    const chips = el('div', 'nt-chips', { role: 'group', 'aria-label': 'Filter by colour' });
    for (const color of COLORS) {
      chips.appendChild(
        button('nt-chip', `Show only ${color} highlights`, '', {
          'data-color': color,
          'aria-pressed': 'false',
        }),
      );
    }
    chips.addEventListener('click', (event) => {
      const color = event.target.closest('button')?.getAttribute('data-color');
      if (!color) return;
      if (filter.colors.has(color)) filter.colors.delete(color);
      else filter.colors.add(color);
      limit = PAGE_SIZE;
      render();
    });
    const only = button('nt-toggle', 'Show only highlights that have a note', 'Notes only', {
      'aria-pressed': 'false',
      'data-role': 'notes-only',
    });
    only.addEventListener('click', () => {
      filter.notesOnly = !filter.notesOnly;
      limit = PAGE_SIZE;
      render();
    });
    searchEl.addEventListener(
      'input',
      debounce(() => {
        filter.query = searchEl.value;
        limit = PAGE_SIZE;
        render();
      }, SEARCH_DEBOUNCE_MS),
    );
    row.append(chips, searchEl, only);
    return row;
  }

  root.classList.add('nt-panel');
  root.textContent = '';
  contentEl.append(buildFilters(), listEl);
  root.append(buildHeader(), contentEl);
  setCollapsed(Boolean(options.collapsed));

  // ── rows ──────────────────────────────────────────────────────────────────

  function noteEditor(highlight) {
    const box = el('textarea', 'nt-editor', {
      rows: '3',
      placeholder: 'Write a note…',
      title: 'Edit note',
      'aria-label': 'Edit note',
    });
    box.value = highlight.note || '';
    const commit = () => {
      const value = box.value;
      editingId = null;
      if (value !== (highlight.note || '') && typeof onUpdate === 'function') {
        onUpdate(highlight.id, { note: value });
      }
      render();
    };
    box.addEventListener('blur', commit);
    box.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        editingId = null;
        box.removeEventListener('blur', commit);
        render();
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        box.blur();
      }
    });
    return box;
  }

  function metaRow(highlight) {
    const meta = el('div', 'nt-meta');
    const page = el('span', 'nt-page');
    page.textContent = `p. ${highlight.page}`;
    meta.appendChild(page);
    if (confirmingId === highlight.id) {
      const ask = el('span', 'nt-confirm');
      ask.textContent = 'Delete?';
      meta.append(
        ask,
        button('nt-mini nt-danger', 'Confirm delete', 'Yes', { 'data-act': 'delete-yes' }),
        button('nt-mini', 'Keep highlight', 'No', { 'data-act': 'delete-no' }),
      );
      return meta;
    }
    meta.appendChild(button('nt-mini', 'Delete highlight', '🗑', { 'data-act': 'delete' }));
    return meta;
  }

  function rowEl(highlight) {
    const row = el('div', 'nt-row', {
      role: 'listitem',
      tabindex: '0',
      'data-id': highlight.id,
      'data-color': highlight.color,
    });
    if (highlight.id === activeId) row.classList.add('is-active');
    const bar = el('span', 'nt-bar', { 'data-color': highlight.color, 'aria-hidden': 'true' });
    const body = el('div', 'nt-body');
    const text = el('div', 'nt-text');
    text.textContent = String(highlight.text || '').slice(0, TEXT_CLAMP_CHARS);
    body.appendChild(text);
    if (editingId === highlight.id) {
      body.appendChild(noteEditor(highlight));
    } else {
      const note = el('div', highlight.note ? 'nt-note' : 'nt-note is-empty', {
        'data-act': 'edit',
        title: 'Click to edit this note',
      });
      note.textContent = highlight.note || 'Add a note…';
      body.appendChild(note);
    }
    body.appendChild(metaRow(highlight));
    row.append(bar, body);
    return row;
  }

  function emptyState(hasAny) {
    const box = el('div', 'nt-empty');
    const title = el('div', 'nt-empty-title');
    const hint = el('div', 'nt-empty-hint');
    if (hasAny) {
      title.textContent = 'Nothing matches';
      hint.textContent = 'Clear the search box or the colour chips above.';
    } else {
      title.textContent = 'No highlights yet';
      hint.textContent = 'Select any text in the document, then pick a colour from the toolbar that appears. Press 📝 to attach a note.';
    }
    box.append(title, hint);
    return box;
  }

  // ── render ────────────────────────────────────────────────────────────────

  function syncChrome(shownCount, totalCount) {
    countEl.textContent = shownCount === totalCount ? `${totalCount}` : `${shownCount} / ${totalCount}`;
    countEl.title = `${totalCount} highlight${totalCount === 1 ? '' : 's'}`;
    for (const chip of root.querySelectorAll('.nt-chip')) {
      const on = filter.colors.has(chip.getAttribute('data-color'));
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', String(on));
    }
    const only = root.querySelector('[data-role="notes-only"]');
    only.classList.toggle('is-on', filter.notesOnly);
    only.setAttribute('aria-pressed', String(filter.notesOnly));
  }

  function render() {
    const matched = highlights.filter((highlight) => matchesFilter(highlight, filter));
    const groups = groupByPage(matched);
    listEl.textContent = '';
    syncChrome(Math.min(matched.length, limit), matched.length);
    if (matched.length === 0) {
      listEl.appendChild(emptyState(highlights.length > 0));
      return;
    }
    const frag = document.createDocumentFragment();
    let rendered = 0;
    for (const group of groups) {
      if (rendered >= limit) break;
      const head = el('div', 'nt-page-head');
      head.textContent = `Page ${group.page}`;
      frag.appendChild(head);
      for (const highlight of group.items) {
        if (rendered >= limit) break;
        frag.appendChild(rowEl(highlight));
        rendered += 1;
      }
    }
    listEl.appendChild(frag);
    if (matched.length > rendered) {
      const more = button('nt-more', 'Show more highlights', `Show ${matched.length - rendered} more`);
      more.addEventListener('click', () => {
        limit += PAGE_SIZE;
        render();
      });
      listEl.appendChild(more);
    }
  }

  // ── interaction ───────────────────────────────────────────────────────────

  function onListClick(event) {
    const row = event.target.closest('.nt-row');
    if (!row) return;
    const id = row.getAttribute('data-id');
    const highlight = highlights.find((item) => item.id === id);
    if (!highlight) return;
    const act = event.target.closest('[data-act]')?.getAttribute('data-act');
    if (act === 'delete') {
      confirmingId = id;
      return render();
    }
    if (act === 'delete-no') {
      confirmingId = null;
      return render();
    }
    if (act === 'delete-yes') {
      confirmingId = null;
      if (typeof onDelete === 'function') onDelete(id);
      return;
    }
    if (act === 'edit') {
      editingId = id;
      render();
      listEl.querySelector(`.nt-row[data-id="${CSS.escape(id)}"] .nt-editor`)?.focus();
      return;
    }
    activeId = id;
    if (typeof onJump === 'function') onJump(highlight);
    render();
  }

  function onListKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest?.('.nt-row');
    if (!row || row !== event.target) return;
    event.preventDefault();
    row.click();
  }

  listEl.addEventListener('click', onListClick);
  listEl.addEventListener('keydown', onListKeyDown);
  render();

  return {
    setHighlights(list) {
      highlights = Array.isArray(list) ? list.slice() : [];
      if (!highlights.some((item) => item.id === editingId)) editingId = null;
      if (!highlights.some((item) => item.id === confirmingId)) confirmingId = null;
      render();
    },
    setActive(id) {
      activeId = id;
      render();
      listEl.querySelector(`.nt-row[data-id="${CSS.escape(String(id))}"]`)?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    },
    render,
    destroy() {
      listEl.removeEventListener('click', onListClick);
      listEl.removeEventListener('keydown', onListKeyDown);
      root.textContent = '';
      root.classList.remove('nt-panel', 'is-collapsed');
      highlights = [];
    },
  };
}

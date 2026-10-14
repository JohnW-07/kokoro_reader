/**
 * highlights.js — text selection → normalised rect model → `.hl-layer` overlay.
 *
 * Rects are normalised to 0..1 of the page box so they survive re-render, zoom and
 * resize. The pdf.js text layer is NEVER mutated: everything painted here lives in
 * the `.hl-layer` overlay inside each page wrap, which sits below the text layer so
 * pdf.js keeps ownership of selection. Clicks are resolved by hit-testing the
 * normalised rects, so the overlay's pointer-events setting is irrelevant.
 * No imports; collaborators arrive as options.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_COLORS = ['yellow', 'green', 'blue', 'pink'];
const LINE_OVERLAP_RATIO = 0.5;   // vertical overlap that means "same text line"
const MERGE_GAP = 0.01;           // horizontal gap (of page width) still "abutting"
const MIN_RECT_SIZE = 0.0005;     // below this a rect is selection noise
// One bar per selected text line. A dense page holds ~60; anything past this is a
// runaway drag, and the server drops the overflow anyway (notes_store.MAX_RECTS_PER_HIGHLIGHT).
const MAX_RECTS_PER_HIGHLIGHT = 512;
const RESIZE_DEBOUNCE_MS = 120;
const SELECTION_DEBOUNCE_MS = 60;
const FLOATER_GAP_PX = 8;
const FLOATER_MARGIN_PX = 6;
const MAX_SELECTION_CHARS = 20000;
const COLOR_KEYS = ['1', '2', '3', '4'];
/** A button's activation keys, for the focusable highlight rects. */
const ACTIVATE_KEYS = new Set(['Enter', ' ']);
const EDITABLE = /^(INPUT|TEXTAREA|SELECT)$/;

// ── Pure geometry helpers (exported for tests) ────────────────────────────────

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const bottomOf = (r) => r.y + r.h;
const rightOf = (r) => r.x + r.w;

/** Coerce a DOMRect-ish value to a positive-area `{left, top, width, height}`, else null. */
export function toBox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const left = isNum(raw.left) ? raw.left : raw.x;
  const top = isNum(raw.top) ? raw.top : raw.y;
  const width = isNum(raw.width) ? raw.width : raw.right - left;
  const height = isNum(raw.height) ? raw.height : raw.bottom - top;
  if (![left, top, width, height].every(isNum) || width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/**
 * Normalise a viewport-space client rect to 0..1 page coordinates.
 * @returns {{x:number, y:number, w:number, h:number}|null}
 */
export function normalizeRect(rect, box) {
  const page = toBox(box);
  const r = toBox(rect);
  if (!page || !r) return null;
  const x = clamp01((r.left - page.left) / page.width);
  const y = clamp01((r.top - page.top) / page.height);
  const w = clamp01(Math.min(r.width / page.width, 1 - x));
  const h = clamp01(Math.min(r.height / page.height, 1 - y));
  return { x, y, w, h };
}

/** Inverse of {@link normalizeRect} — back to viewport pixels. */
export function denormalizeRect(rect, box) {
  const page = toBox(box);
  if (!page || !rect) return null;
  const { left, top, width, height } = page;
  return { left: left + rect.x * width, top: top + rect.y * height, width: rect.w * width, height: rect.h * height };
}

function onSameLine(a, b) {
  const overlap = Math.min(bottomOf(a), bottomOf(b)) - Math.max(a.y, b.y);
  const shortest = Math.min(a.h, b.h);
  return shortest > 0 && overlap / shortest >= LINE_OVERLAP_RATIO;
}

function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(rightOf(a), rightOf(b)) - x, h: Math.max(bottomOf(a), bottomOf(b)) - y };
}

/** Bucket rects into text lines, in reading order. */
function toLines(rects) {
  const lines = [];
  for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((candidate) => onSameLine(candidate[0], rect));
    if (line) line.push(rect);
    else lines.push([rect]);
  }
  return lines;
}

/** Merge one already-grouped line's rects, left to right. */
function mergeOneLine(line) {
  const sorted = [...line].sort((a, b) => a.x - b.x);
  return sorted.slice(1).reduce((acc, rect) => {
    const last = acc[acc.length - 1];
    if (rect.x <= rightOf(last) + MERGE_GAP) acc[acc.length - 1] = unionRect(last, rect);
    else acc.push(rect);
    return acc;
  }, [sorted[0]]);
}

/**
 * Collapse a selection's raw normalised rects into one bar per text line.
 * Pure — the input array is never mutated.
 */
export function mergeLineRects(rects) {
  if (!Array.isArray(rects) || rects.length === 0) return [];
  const usable = rects.filter((r) => r && r.w > MIN_RECT_SIZE && r.h > MIN_RECT_SIZE);
  if (usable.length === 0) return [];
  return toLines(usable).flatMap(mergeOneLine).slice(0, MAX_RECTS_PER_HIGHLIGHT);
}

/** Where a highlight starts: the leftmost rect of its top line, or null with no rects. */
function anchorOf(highlight) {
  const [top] = toLines(highlight.rects);
  return top ? top.reduce((a, b) => (b.x < a.x ? b : a)) : null;
}

/** Reading order: page, then line top to bottom, then left to right. Rect-less ones go last. */
function byReadingOrder(a, b) {
  if (a.page !== b.page) return a.page - b.page;
  const [ra, rb] = [anchorOf(a), anchorOf(b)];
  if (!ra || !rb) return Number(!ra) - Number(!rb);
  return onSameLine(ra, rb) ? ra.x - rb.x : ra.y - rb.y;
}

/** A sorted copy: the list itself keeps creation order. */
const inReadingOrder = (list) => [...list].sort(byReadingOrder);

/**
 * Split raw client rects across page boxes by centre point, normalising each.
 * @param {Array<{page:number, box:*}>} pageBoxes
 * @returns {Map<number, Array<{x:number,y:number,w:number,h:number}>>}
 */
export function groupRectsByPage(clientRects, pageBoxes) {
  const boxes = (pageBoxes || []).map((e) => ({ page: e.page, box: toBox(e.box) })).filter((e) => e.box);
  const byPage = new Map();
  for (const raw of clientRects || []) {
    const rect = toBox(raw);
    if (!rect) continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hit = boxes.find(({ box }) =>
      cx >= box.left && cx <= box.left + box.width && cy >= box.top && cy <= box.top + box.height);
    const norm = hit && normalizeRect(rect, hit.box);
    if (!norm) continue;
    if (!byPage.has(hit.page)) byPage.set(hit.page, []);
    byPage.get(hit.page).push(norm);
  }
  return byPage;
}

/**
 * Build one immutable highlight per page group, all sharing a `group` id.
 * @param {{id?:function, now?:function}} [deps] injectable for deterministic tests
 */
export function createHighlightsFromGroups(groups, color, deps = {}) {
  const id = deps.id || (() => crypto.randomUUID());
  const now = deps.now || (() => new Date().toISOString());
  const group = id();
  const stamp = now();
  return (groups || []).map((g) => ({
    id: id(), group, page: g.page, color, text: g.text || '', note: '',
    rects: g.rects, created_at: stamp, updated_at: stamp,
  }));
}

const rectContains = (r, nx, ny) => nx >= r.x && nx <= rightOf(r) && ny >= r.y && ny <= bottomOf(r);

// ── DOM helpers ───────────────────────────────────────────────────────────────

const swatchHtml = (color, label) =>
  `<button type="button" class="hl-swatch" data-color="${color}" title="${label}" aria-label="${label}"></button>`;
const actHtml = (act, label, glyph) =>
  `<button type="button" class="hl-act" data-act="${act}" title="${label}" aria-label="${label}">${glyph}</button>`;

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  return node;
}

/** Place a floater above `anchor`, flipped below when cramped, clamped to the viewport. */
function positionFloater(node, anchor) {
  node.style.visibility = 'hidden';
  node.style.left = '0px';
  node.style.top = '0px';
  const size = node.getBoundingClientRect();
  const above = anchor.top - FLOATER_GAP_PX - size.height;
  const top = above >= FLOATER_MARGIN_PX ? above : anchor.bottom + FLOATER_GAP_PX;
  const maxLeft = Math.max(window.innerWidth - size.width - FLOATER_MARGIN_PX, FLOATER_MARGIN_PX);
  const maxTop = Math.max(window.innerHeight - size.height - FLOATER_MARGIN_PX, FLOATER_MARGIN_PX);
  const left = anchor.left + anchor.width / 2 - size.width / 2;
  node.style.left = `${Math.round(Math.min(Math.max(left, FLOATER_MARGIN_PX), maxLeft))}px`;
  node.style.top = `${Math.round(Math.min(Math.max(top, FLOATER_MARGIN_PX), maxTop))}px`;
  node.style.visibility = '';
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

const escapeId = (id) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(id)) : String(id));

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * @param {{pdfView:object, onChange?:function, onReadFrom?:function, colors?:string[]}} options
 * @returns {object} the highlighter API
 */
export function createHighlighter(options = {}) {
  const { pdfView, onChange, onReadFrom, colors = DEFAULT_COLORS } = options;
  if (!pdfView) throw new Error('createHighlighter requires a pdfView');

  let highlights = [];
  let activeId = null;
  /** The last highlight the reader touched. Outlives the popover: a note written in
   *  the column is still about the highlight that was just clicked (U8). */
  let touchedId = null;
  let pending = null; // snapshot of the last live selection (clicking chrome clears it)
  let attached = false;
  let toolbar = null;
  let popover = null;

  // ── page geometry ───────────────────────────────────────────────────────────

  const call = (name, arg) => (typeof pdfView[name] === 'function' ? pdfView[name](arg) : null);
  const wrapFor = (page) => call('pageWrapEl', page) || null;
  const rectNode = (id) => document.querySelector(`.hl-rect[data-hl-id="${escapeId(id)}"]`);

  function numPages() {
    const n = call('numPages');
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  /**
   * The page box in *viewport* coords. pdfView.pageRect currently returns only
   * `{width, height}` (no origin), which toBox rejects, so the wrap's client rect
   * is used. Kept as a preference so a future pageRect with an origin just works.
   */
  function boxFor(page) {
    const declared = toBox(call('pageRect', page));
    if (declared) return declared;
    const wrap = wrapFor(page);
    return wrap ? toBox(wrap.getBoundingClientRect()) : null;
  }

  function candidateBoxes() {
    const out = [];
    for (let page = 1; page <= numPages(); page += 1) {
      const wrap = wrapFor(page);
      const box = wrap && boxFor(page);
      if (box) out.push({ page, box, wrap });
    }
    return out;
  }

  function layerFor(page) {
    const wrap = wrapFor(page);
    if (!wrap) return null;
    const existing = wrap.querySelector('.hl-layer');
    if (existing) return existing;
    const layer = el('div', 'hl-layer', { 'aria-hidden': 'true' });
    wrap.appendChild(layer);
    return layer;
  }

  // ── rendering ───────────────────────────────────────────────────────────────

  function rectEl(highlight, rect, index, total) {
    const node = el('div', 'hl-rect', { 'data-hl-id': highlight.id, 'data-color': highlight.color });
    Object.assign(node.style, {
      left: `${rect.x * 100}%`, top: `${rect.y * 100}%`,
      width: `${rect.w * 100}%`, height: `${rect.h * 100}%`,
    });
    if (highlight.id === activeId) node.classList.add('is-active');
    if (highlight.note && index === total - 1) node.classList.add('has-note');
    if (index > 0) return node;
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `${highlight.color} highlight: ${highlight.text.slice(0, 120)}`);
    return node;
  }

  function rerender(page) {
    const layer = layerFor(page);
    if (!layer) return;
    layer.textContent = '';
    const frag = document.createDocumentFragment();
    // DOM order is Tab order, so the rects go in in reading order, not creation order.
    for (const highlight of inReadingOrder(highlights.filter((hl) => hl.page === page))) {
      const total = highlight.rects.length;
      highlight.rects.forEach((rect, i) => frag.appendChild(rectEl(highlight, rect, i, total)));
    }
    layer.appendChild(frag);
  }

  /** The highlight whose rect has the keyboard focus, if one does. */
  const focusedId = () => document.activeElement?.closest?.('.hl-rect')?.dataset.hlId;

  /** Re-render every page. The focused rect is replaced too, so its highlight's new rect takes
   *  the focus: left on <body>, the next Space would play or pause instead of pressing it. */
  function renderAll() {
    const keep = focusedId();
    for (let page = 1; page <= numPages(); page += 1) if (wrapFor(page)) rerender(page);
    if (keep) rectNode(keep)?.focus();
  }

  // ── immutable state transitions ─────────────────────────────────────────────

  function commit(next) {
    highlights = next;
    renderAll();
    if (typeof onChange === 'function') onChange(next.slice());
  }

  function update(id, patch) {
    const stamp = new Date().toISOString();
    let changed = false;
    const next = highlights.map((hl) => {
      if (hl.id !== id) return hl;
      changed = true;
      return { ...hl, ...patch, id: hl.id, updated_at: stamp };
    });
    if (changed) commit(next);
  }

  function remove(id) {
    const order = inReadingOrder(highlights);
    const at = order.findIndex((hl) => hl.id === id);
    if (at < 0) return;
    const next = highlights.filter((hl) => hl.id !== id);
    const hadFocus = focusedId() === id;
    if (activeId === id) closePopover();
    commit(next);
    // Its rect is gone, so the focus moves on to the next highlight in reading order (else the
    // one before), as in a list. One with no rects has no node, so it is skipped. With none left
    // it falls to <body>: nothing is left to press there.
    const shown = (hl) => hl.rects.length > 0;
    const neighbour = order.slice(at + 1).find(shown) ?? order.slice(0, at).findLast(shown);
    if (hadFocus && neighbour) rectNode(neighbour.id)?.focus();
  }

  // ── selection ───────────────────────────────────────────────────────────────

  /** The part of `range` that lies inside `wrap`, as text. */
  function textIn(range, wrap) {
    if (!range.intersectsNode(wrap)) return '';
    try {
      const clip = range.cloneRange();
      const whole = document.createRange();
      whole.selectNodeContents(wrap);
      if (clip.compareBoundaryPoints(Range.START_TO_START, whole) < 0) clip.setStart(whole.startContainer, whole.startOffset);
      if (clip.compareBoundaryPoints(Range.END_TO_END, whole) > 0) clip.setEnd(whole.endContainer, whole.endOffset);
      return clip.toString().trim();
    } catch (err) {
      console.warn('highlights: could not clip selection to page', err);
      return '';
    }
  }

  function selectionGroups(range) {
    const boxes = candidateBoxes();
    const byPage = groupRectsByPage(range.getClientRects(), boxes);
    return boxes
      .filter((entry) => byPage.has(entry.page))
      .map((entry) => ({
        page: entry.page,
        rects: mergeLineRects(byPage.get(entry.page)),
        text: textIn(range, entry.wrap),
      }))
      .filter((group) => group.rects.length > 0);
  }

  function liveSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (!text || text.length > MAX_SELECTION_CHARS) return null;
    const node = selection.anchorNode;
    const host = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!host || !host.closest('.textLayer')) return null;
    const range = selection.getRangeAt(0);
    const groups = selectionGroups(range);
    return groups.length === 0 ? null
      : { groups, text, anchor: range.getBoundingClientRect(), startNode: range.startContainer };
  }

  // ── selection toolbar ───────────────────────────────────────────────────────

  function buildToolbar() {
    const bar = el('div', 'hl-toolbar', { role: 'toolbar', 'aria-label': 'Selection actions' });
    bar.innerHTML = colors.map((c) => swatchHtml(c, `Highlight ${c}`)).join('')
      + '<span class="hl-sep"></span>'
      + actHtml('note', 'Highlight and add a note', '📝')
      + actHtml('read', 'Read from here', '▶ Read from here')
      + actHtml('copy', 'Copy selection', '⧉');
    bar.addEventListener('mousedown', (event) => event.preventDefault());
    bar.addEventListener('click', onToolbarClick);
    document.body.appendChild(bar);
    return bar;
  }

  const hideToolbar = () => toolbar && toolbar.classList.remove('is-open');

  function showToolbar() {
    const snapshot = liveSelection();
    if (!snapshot) return hideToolbar();
    pending = snapshot;
    if (!toolbar) toolbar = buildToolbar();
    toolbar.classList.add('is-open');
    positionFloater(toolbar, snapshot.anchor);
  }

  function addFromPending(color, openNote) {
    if (!pending) return null;
    const created = createHighlightsFromGroups(pending.groups, color);
    commit([...highlights, ...created]);
    pending = null;
    hideToolbar();
    window.getSelection()?.removeAllRanges();
    const first = created[0] || null;
    // Just marking a passage makes it what the reader is on, popover or not (U8).
    if (first) touchedId = first.id;
    if (first && openNote) openPopover(first.id, true);
    return first;
  }

  async function copySelection() {
    const text = pending?.text || '';
    hideToolbar();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.warn('highlights: clipboard write failed', err);
    }
  }

  function readFromPending() {
    if (!pending || typeof onReadFrom !== 'function') return hideToolbar();
    const group = pending.groups[0];
    onReadFrom(group.page, pending.text, group.rects[0], pending.startNode);
    hideToolbar();
  }

  function onToolbarClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    const color = button.getAttribute('data-color');
    if (color) return void addFromPending(color, false);
    const act = button.getAttribute('data-act');
    if (act === 'note') return void addFromPending(colors[0], true);
    if (act === 'read') return readFromPending();
    if (act === 'copy') return void copySelection();
  }

  // ── highlight popover ───────────────────────────────────────────────────────

  function buildPopover() {
    const pop = el('div', 'hl-popover', { role: 'dialog', 'aria-label': 'Highlight options' });
    pop.innerHTML = `<div class="hl-pop-row">${colors.map((c) => swatchHtml(c, `Set colour ${c}`)).join('')}`
      + '<button type="button" class="hl-del" data-act="delete" title="Delete highlight" aria-label="Delete highlight">🗑</button></div>'
      + '<textarea class="hl-note" rows="3" placeholder="Add a note…" title="Note" aria-label="Note for this highlight"></textarea>'
      + '<div class="hl-pop-hint">Note saves on blur · Esc closes</div>';
    pop.addEventListener('mousedown', (event) => event.stopPropagation());
    pop.addEventListener('click', onPopoverClick);
    const note = pop.querySelector('.hl-note');
    note.addEventListener('blur', () => activeId && update(activeId, { note: note.value }));
    document.body.appendChild(pop);
    return pop;
  }

  function onPopoverClick(event) {
    const button = event.target.closest('button');
    if (!button || !activeId) return;
    const color = button.getAttribute('data-color');
    if (color) return update(activeId, { color });
    if (button.getAttribute('data-act') === 'delete') confirmDelete(button);
  }

  /** The first press arms the delete button; only a second press deletes. */
  function confirmDelete(button) {
    if (button.classList.contains('is-confirming')) return remove(activeId);
    button.classList.add('is-confirming');
    button.textContent = 'Delete?';
  }

  function openPopover(id, focusNote) {
    const highlight = highlights.find((hl) => hl.id === id);
    if (!highlight) return;
    activeId = id;
    touchedId = id;
    renderAll();
    const node = rectNode(id);
    if (!node) return;
    if (!popover) popover = buildPopover();
    const del = popover.querySelector('.hl-del');
    del.classList.remove('is-confirming');
    del.textContent = '🗑';
    popover.querySelector('.hl-note').value = highlight.note || '';
    popover.classList.add('is-open');
    positionFloater(popover, node.getBoundingClientRect());
    if (focusNote) popover.querySelector('.hl-note').focus();
  }

  function closePopover() {
    if (popover) popover.classList.remove('is-open');
    if (!activeId) return;
    activeId = null;
    renderAll();
  }

  // ── event handling ──────────────────────────────────────────────────────────

  /** Hit-test a click against normalised rects — the overlay itself is click-through. */
  function hitTest(event) {
    const wrap = event.target.closest?.('.pdf-page-wrap');
    const entry = wrap && candidateBoxes().find((candidate) => candidate.wrap === wrap);
    if (!entry) return null;
    const nx = (event.clientX - entry.box.left) / entry.box.width;
    const ny = (event.clientY - entry.box.top) / entry.box.height;
    // Later in the DOM paints on top, and the DOM is in reading order: the last one there wins.
    const onPage = inReadingOrder(highlights.filter((hl) => hl.page === entry.page));
    for (let i = onPage.length - 1; i >= 0; i -= 1) {
      if (onPage[i].rects.some((rect) => rectContains(rect, nx, ny))) return onPage[i];
    }
    return null;
  }

  const inChrome = (target) => Boolean(toolbar?.contains(target) || popover?.contains(target));

  function onDocumentClick(event) {
    if (inChrome(event.target)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const hit = hitTest(event);
    if (hit) return openPopover(hit.id, false);
    closePopover();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      hideToolbar();
      return closePopover();
    }
    // A focused rect is a [role=button]: its keys open it as a click would. main.js's
    // Space handler already leaves [role=button] alone (transportrules `ownsSpace`).
    // A chord (Shift/⌘/Ctrl/Alt held) is not a press of the button: it is left alone.
    const rect = event.target.closest?.('.hl-rect');
    const isChord = event.shiftKey || event.metaKey || event.ctrlKey || event.altKey;
    if (rect && ACTIVATE_KEYS.has(event.key) && !isChord) {
      event.preventDefault();
      return openPopover(rect.dataset.hlId, false);
    }
    if (!activeId || EDITABLE.test(event.target.tagName || '') || event.target.isContentEditable) return;
    const index = COLOR_KEYS.indexOf(event.key);
    if (index >= 0 && colors[index]) {
      event.preventDefault();
      return update(activeId, { color: colors[index] });
    }
    if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      return openPopover(activeId, true);
    }
    // focus() activates without the popover, so a stray key must not delete unseen (A5).
    if ((event.key === 'Delete' || event.key === 'Backspace') && popover?.classList.contains('is-open')) {
      event.preventDefault();
      confirmDelete(popover.querySelector('.hl-del'));
    }
  }

  function repositionPopover() {
    if (!activeId || !popover?.classList.contains('is-open')) return;
    const node = rectNode(activeId);
    if (node) positionFloater(popover, node.getBoundingClientRect());
  }

  const onSelectionChange = debounce(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) hideToolbar();
  }, SELECTION_DEBOUNCE_MS);

  const onResize = debounce(() => {
    renderAll();
    repositionPopover();
  }, RESIZE_DEBOUNCE_MS);

  // The queue auto-scrolls during playback; only a scroll that moves the selection hides the toolbar.
  const onScroll = (event) => {
    const anchorNode = window.getSelection()?.anchorNode;
    if (!(event.target instanceof Element) || !anchorNode || event.target.contains(anchorNode)) hideToolbar();
    repositionPopover();
  };
  const onMouseDown = (event) => !inChrome(event.target) && hideToolbar();
  const onMouseUp = () => setTimeout(showToolbar, 0);

  const LISTENERS = [
    [document, 'mouseup', onMouseUp, false],
    [document, 'mousedown', onMouseDown, true],
    [document, 'click', onDocumentClick, false],
    [document, 'selectionchange', onSelectionChange, false],
    [document, 'keydown', onKeyDown, false],
    [window, 'resize', onResize, false],
    [window, 'scroll', onScroll, true],
  ];

  function attach() {
    if (attached) return;
    attached = true;
    for (const [target, type, fn, capture] of LISTENERS) target.addEventListener(type, fn, capture);
  }

  function detach() {
    if (!attached) return;
    attached = false;
    for (const [target, type, fn, capture] of LISTENERS) target.removeEventListener(type, fn, capture);
    hideToolbar();
    closePopover();
  }

  function focus(id) {
    const highlight = highlights.find((hl) => hl.id === id);
    if (!highlight) return;
    if (typeof pdfView.scrollToPage === 'function') pdfView.scrollToPage(highlight.page);
    rectNode(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    activeId = id;
    touchedId = id;
    renderAll();
  }

  return {
    attach, detach, rerender, focus, update, remove,
    /**
     * True while a highlight owns the keyboard: `onKeyDown` then claims 1-4, N and,
     * with its popover open, Delete for it. Another `document` listener that binds one of those keys has to
     * ask — both listeners sit on the same node, so neither can suppress the other.
     */
    hasActive: () => activeId !== null,
    /** The highlight a note written right now would be about, if any (U8). */
    recent: () => highlights.find((hl) => hl.id === touchedId) || null,
    list: () => highlights.slice(),
    setHighlights(list) {
      highlights = Array.isArray(list) ? list.slice() : [];
      activeId = null;
      touchedId = null;
      renderAll();
    },
    add: (color) => addFromPending(color || colors[0], false),
    addNote: (id, text) => update(id, { note: String(text ?? '') }),
    destroy() {
      detach();
      onResize.cancel();
      onSelectionChange.cancel();
      toolbar?.remove();
      popover?.remove();
      toolbar = null;
      popover = null;
      highlights = [];
    },
  };
}

/**
 * noteseditor.js — the per-paper block editor in the notes column (T7).
 *
 * The DOM half: `blocks.js` owns every rule about what a block list *is*, this
 * file only renders one and turns keystrokes into calls on it. Two invariants:
 *
 *   - user text reaches the page through `textContent` only, never innerHTML,
 *     and a paste is stripped to `text/plain` before it is inserted;
 *   - keys pressed inside the editor never reach the document-level shortcuts
 *     (Space/←/→/S/R/B), so typing "B" writes a B instead of hiding the sidebar.
 */

import {
  applyShortcut,
  backspaceAtStart,
  convertBlock,
  ensureBlocks,
  indexOfBlock,
  insertAfter,
  markdownShortcut,
  highlightQuoteBlocks,
  isSlashTrigger,
  setAnchor,
  setText,
  splitBlock,
  toggleChecked,
} from './blocks.js';
import {
  groupNotes, isEmptyNote, opensNote, sameAnchor, sectionHeading, sortNotes, VIEW_MARGIN, VIEW_SECTIONS,
  withoutEmptyNote,
} from './anchors.js';
import { createSlashMenu } from './slashmenu.js';
import { isZoomKey } from './zoom.js';

const PLACEHOLDER = "Type '/' for commands";
const NO_DOC_HINT = 'Open a paper to take notes on it.';
const NO_HIGHLIGHT = 'Highlight something in the PDF first, then quote it here.';
const BULLET = '•';
/**
 * What the save-state readout says, to a screen reader and on hover (notesedit.css draws it
 * as a mark). `idle` shows nothing at all.
 */
const STATUS_TEXT = Object.freeze({
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
});
const TEXT_SELECTOR = '.ne-text';
const BLOCK_SELECTOR = '.ne-block';
const NOTE_SELECTOR = '.ne-note';
/** The view switch's two options, in order: name, and what the view does. */
const VIEW_OPTIONS = Object.freeze([
  { view: VIEW_MARGIN, label: 'Margin', title: 'Float notes beside what they are about' },
  { view: VIEW_SECTIONS, label: 'Sections', title: 'Group notes under the paper\u2019s sections' },
]);
/** Keys that move the switch to its other option (a radiogroup's arrows). */
const SWITCH_ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const SWITCH_PICKS = new Set([' ', 'Enter']);
/** MouseEvent.buttons bit for the primary button. */
const PRIMARY_BUTTON = 1;
/** Presses on these are the user's own business (typing, selecting, a control, the menu). */
const NOT_EMPTY_SPACE = `${TEXT_SELECTOR}, button, a, input, select, textarea, [contenteditable], .ne-slash, .ne-switch`;
/** The keyCode WebKit and Chromium report for keys an input method is handling. */
const IME_KEY_CODE = 229;
/** Input types that mean "the user just typed" — the only ones that fire a shortcut. */
const TYPING_INPUTS = Object.freeze(['insertText', 'insertCompositionText']);

/**
 * @param {object} deps
 * @param {HTMLElement} deps.root            the notes column
 * @param {(blocks:Array) => void} deps.onChange   called after every edit
 * @param {() => object|null} [deps.getHighlight]  the highlight "/quote" should cite
 * @param {() => object|null} [deps.getAnchor]      where in the paper a new note belongs
 * @param {(view:string) => void} [deps.onViewChange]  the user picked margin or sections
 * @param {() => void} [deps.onRender]              the rows moved; reposition them
 * @param {(message:string, level?:string) => void} [deps.onNotify]
 */
export function createNotesEditor({
  root, onChange, getHighlight = () => null, getAnchor = () => null,
  onViewChange = () => {}, onRender = () => {}, onNotify = () => {},
}) {
  if (!root) throw new Error('createNotesEditor requires a root element');
  if (typeof onChange !== 'function') throw new TypeError('createNotesEditor: onChange must be a function');

  let model = [];
  let enabled = false;
  let view = VIEW_MARGIN;
  /** The paper's own headings, `{page, y, title}`, for the section view. */
  let sections = [];
  /** Where the open `/` menu was typed: `{ id, start }`, start = offset of the slash. */
  let slash = null;
  /** The row a click on an empty column opened, until the reader writes in it or leaves it. */
  let unwritten = null;

  const panel = document.createElement('section');
  panel.className = 'ne-panel';

  const head = document.createElement('header');
  head.className = 'ne-head';
  const title = document.createElement('h2');
  title.className = 'ne-heading';
  title.textContent = 'Notes';
  const status = document.createElement('span');
  status.className = 'ne-status';
  status.id = 'notes-save-state';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const viewSwitch = buildViewSwitch();

  const tools = document.createElement('div');
  tools.className = 'ne-tools';
  tools.append(status, viewSwitch);
  head.append(title, tools);

  const docEl = document.createElement('div');
  docEl.className = 'ne-doc';
  docEl.id = 'notes-doc';
  docEl.setAttribute('aria-label', 'Notes for this paper');

  const hint = document.createElement('p');
  hint.className = 'ne-hint';
  hint.textContent = NO_DOC_HINT;

  panel.append(head, docEl, hint);
  root.appendChild(panel);

  const menu = createSlashMenu({
    onPick: runCommand,
    onClose: () => { slash = null; },
    bounds: () => root.getBoundingClientRect(),
  });

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  const rowFor = (id) => docEl.querySelector(`${BLOCK_SELECTOR}[data-id="${CSS.escape(String(id))}"]`);
  const textElFor = (id) => rowFor(id)?.querySelector(TEXT_SELECTOR) || null;

  /**
   * The block's text as the user sees it. Enter, Shift+Enter and paste are all
   * handled here, so the browser never builds markup of its own inside a block:
   * whatever is in there is the text, newlines included. (An empty block can
   * still hold a bogus <br>, which `textContent` correctly reports as nothing.)
   */
  function readText(el) {
    return el.textContent ?? '';
  }

  function caretOffset(el) {
    const doc = el.ownerDocument || document;
    const selection = doc.getSelection?.();
    if (!selection || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) {
      return readText(el).length;
    }
    const range = selection.getRangeAt(0);
    const upToCaret = range.cloneRange();
    upToCaret.selectNodeContents(el);
    upToCaret.setEnd(range.endContainer, range.endOffset);
    return upToCaret.toString().length;
  }

  function isCollapsed() {
    const selection = docEl.ownerDocument.getSelection();
    return !selection || selection.isCollapsed;
  }

  /** True while the user has text selected inside the note. */
  function selectsInNote() {
    const selection = docEl.ownerDocument.getSelection();
    return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed
      && docEl.contains(selection.getRangeAt(0).commonAncestorContainer));
  }

  function placeCaret(el, offset) {
    el.focus();
    const doc = el.ownerDocument || document;
    if (typeof doc.createTreeWalker !== 'function') return;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    let left = Math.max(0, offset);
    let node = walker.nextNode();
    let landed = false;
    while (node) {
      if (left <= node.nodeValue.length) {
        range.setStart(node, left);
        landed = true;
        break;
      }
      left -= node.nodeValue.length;
      node = walker.nextNode();
    }
    if (!landed) {
      range.selectNodeContents(el);
      range.collapse(false);
    } else {
      range.collapse(true);
    }
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  /**
   * One row per block, wrapped a note at a time. The wrapper is what the margin
   * layout moves and what the section view files under a heading, so both views
   * render the same rows from the same model and the toggle costs no edit.
   */
  function render() {
    menu.close();
    docEl.textContent = '';
    let ordinal = 0;
    let heading = null;
    for (const note of groupNotes(model)) {
      if (view === VIEW_SECTIONS) {
        const label = sectionHeading(sections, note.anchor);
        if (label && label !== heading) docEl.appendChild(sectionRow(label));
        heading = label;
      }
      const wrap = document.createElement('div');
      wrap.className = 'ne-note';
      pinNote(wrap, note.anchor);
      for (const block of note.blocks) {
        ordinal = block.type === 'ol' ? ordinal + 1 : 0;
        wrap.appendChild(renderBlock(block, ordinal));
      }
      docEl.appendChild(wrap);
    }
    onRender();
  }

  /** Where the note is pinned, in the page-relative terms the layout reads back. */
  function pinNote(wrap, anchor) {
    if (!anchor) {
      delete wrap.dataset.page;
      delete wrap.dataset.y;
      return;
    }
    wrap.dataset.page = String(anchor.page);
    wrap.dataset.y = String(anchor.y);
  }

  function sectionRow(label) {
    const row = document.createElement('h3');
    row.className = 'ne-section';
    row.textContent = label;
    return row;
  }

  function renderBlock(block, ordinal) {
    const row = document.createElement('div');
    row.className = `ne-block ne-${block.type}`;
    row.dataset.id = block.id;
    row.dataset.type = block.type;

    if (block.type === 'divider') {
      const rule = document.createElement('hr');
      rule.className = 'ne-rule';
      row.appendChild(rule);
      return row;
    }
    if (block.type === 'ul') row.appendChild(marker(BULLET));
    if (block.type === 'ol') row.appendChild(marker(`${ordinal}.`));
    if (block.type === 'todo') row.appendChild(checkbox(block));

    const text = document.createElement('div');
    text.className = 'ne-text';
    // plaintext-only keeps the browser from building markup for us; `true` is the
    // fallback, and the paste handler strips HTML either way.
    text.contentEditable = 'plaintext-only';
    if (text.contentEditable !== 'plaintext-only') text.contentEditable = 'true';
    text.dataset.placeholder = PLACEHOLDER;
    text.textContent = block.text;
    row.appendChild(text);
    return row;
  }

  function marker(label) {
    const span = document.createElement('span');
    span.className = 'ne-marker';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = label;
    return span;
  }

  function checkbox(block) {
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'ne-check';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(block.checked));
    box.setAttribute('aria-label', 'Toggle this to-do');
    box.dataset.id = block.id;
    if (block.checked) box.classList.add('is-checked');
    return box;
  }

  // ── Committing an edit ──────────────────────────────────────────────────────

  /** Tell the app, which saves what it is told: never the row a click opened and nobody wrote in. */
  function report() {
    onChange(withoutEmptyNote(model, unwritten));
  }

  /** Adopt a new block list, re-render, put the caret back, and tell the app. */
  function commit(blocks, focusId, caret) {
    model = ensureBlocks(sortNotes(blocks));
    render();
    if (focusId) {
      const el = textElFor(focusId);
      if (el) placeCaret(el, caret ?? 0);
    }
    report();
  }

  /** A text edit the browser already applied: keep the DOM, only update the model. */
  function syncText(id, text) {
    model = setText(model, id, text);
    report();
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  function blockIdOf(node) {
    return node?.closest?.(BLOCK_SELECTOR)?.dataset.id || null;
  }

  docEl.addEventListener('input', (event) => {
    const el = event.target.closest?.(TEXT_SELECTOR);
    if (!el) return;
    const id = blockIdOf(el);
    const text = readText(el);
    const caret = caretOffset(el);
    const wasEmpty = model[indexOfBlock(model, id)]?.text === '';
    if (id === unwritten) unwritten = null;
    syncText(id, text);

    // The first character typed into an empty row is what pins the note (D1):
    // beside the highlight it was made from, else beside what is being read.
    if (wasEmpty && text !== '' && event.inputType === 'insertText') adoptAnchor(id, caret);

    if (TYPING_INPUTS.includes(event.inputType) && applyTypedShortcut(id, text, caret)) return;
    updateSlash(textElFor(id) || el, id, text, caret, event);
  });

  /**
   * Pin what is being written to where it is about (D1), on the first character typed
   * into an empty row. Two rules, and between them they settle every case:
   *
   * - the block pinned is always the row being typed into, never another. A row that
   *   has already been written is never re-pinned and never moved, so no edit can tear
   *   an existing note in two or shuffle the document under the reader.
   * - whether it is pinned at all is {@link opensNote}: an unpinned run, a blank row
   *   above it, or a reader who has moved to another page.
   *
   * Pinning the row that already opens an unpinned note changes no row and no order, so
   * that case skips the re-render and keeps the caret, the composition and the `/`
   * menu exactly where they were.
   */
  function adoptAnchor(id, caret) {
    const anchor = getAnchor();
    if (!anchor) return;
    const at = indexOfBlock(model, id);
    const note = groupNotes(model).find((n) => n.blocks.some((b) => b.id === id));
    if (at < 0 || !note || sameAnchor(note.anchor, anchor)) return;
    const isHead = note.blocks[0].id === id;
    // A pinned note stays pinned where it is, head row included: clearing that row and
    // typing again is an edit to the note, not a new one somewhere else.
    if (note.anchor && (isHead || !opensNote(note.anchor, model[at - 1] || null, anchor))) return;
    const pinned = setAnchor(model, id, anchor);
    const wrap = isHead ? rowFor(id)?.closest(NOTE_SELECTOR) : null;
    if (wrap && sortNotes(pinned) === pinned) {
      model = pinned;
      pinNote(wrap, anchor);
      report();
      onRender();
      return;
    }
    commit(pinned, id, caret);
  }

  /** A markdown prefix fires only at the moment it is completed, never on a later edit. */
  function applyTypedShortcut(id, text, caret) {
    const hit = markdownShortcut(text);
    if (!hit || caret !== text.length - hit.rest.length) return false;
    const next = applyShortcut(model, id, text);
    if (!next) return false;
    menu.close();
    commit(next.blocks, next.focusId, next.caret);
    return true;
  }

  function updateSlash(el, id, text, caret, event) {
    if (isSlashTrigger(event.data) && (slash === null || slash.id !== id)) {
      slash = { id, start: caret - 1 };
    }
    if (slash === null) return;
    if (slash.id !== id || caret <= slash.start || !isSlashTrigger(text[slash.start])) {
      menu.close();
      return;
    }
    const opened = menu.show(el.closest(BLOCK_SELECTOR), text.slice(slash.start + 1, caret));
    if (!opened) slash = null;
  }

  docEl.addEventListener('keydown', (event) => {
    // An input method (Pinyin, Kana …) owns Enter, arrows and Esc while it composes.
    if (event.isComposing || event.keyCode === IME_KEY_CODE) return;
    if (menu.isOpen() && handleMenuKey(event)) return;
    const el = event.target.closest?.(TEXT_SELECTOR);
    if (!el || event.metaKey || event.ctrlKey || event.altKey) return;
    const id = blockIdOf(el);
    const text = readText(el);
    const caret = caretOffset(el);

    if (event.key === 'Escape') {
      menu.close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey || model[indexOfBlock(model, id)]?.type === 'code') {
        commit(setText(model, id, `${text.slice(0, caret)}\n${text.slice(caret)}`), id, caret + 1);
        return;
      }
      const next = splitBlock(model, id, caret);
      commit(next.blocks, next.focusId, next.caret);
      return;
    }
    if (event.key === 'Backspace' && caret === 0 && isCollapsed()) {
      const next = backspaceAtStart(model, id);
      if (!next) return;
      event.preventDefault();
      commit(next.blocks, next.focusId, next.caret);
      return;
    }
    if (event.key === 'ArrowUp' && caret === 0) moveCaret(id, -1, event);
    if (event.key === 'ArrowDown' && caret === text.length) moveCaret(id, 1, event);
  });

  function handleMenuKey(event) {
    const keys = {
      ArrowDown: () => menu.move(1),
      ArrowUp: () => menu.move(-1),
      Enter: () => menu.choose(),
      Tab: () => menu.choose(),
      Escape: () => menu.close(),
    };
    const run = keys[event.key];
    if (!run) return false;
    event.preventDefault();
    run();
    return true;
  }

  /** Step to the neighbouring editable block, skipping dividers. */
  function moveCaret(id, delta, event) {
    const at = indexOfBlock(model, id);
    for (let i = at + delta; i >= 0 && i < model.length; i += delta) {
      if (model[i].type === 'divider') continue;
      const el = textElFor(model[i].id);
      if (!el) return;
      event.preventDefault();
      placeCaret(el, delta > 0 ? 0 : model[i].text.length);
      return;
    }
  }

  // Global shortcuts must not see editor keystrokes. contentEditable already
  // exempts the text areas (layout.isTypingTarget), but the to-do checkboxes and
  // the slash menu are plain elements, so stop everything at the panel — except the
  // ⌘/Ctrl zoom chords, which zoom.js claims on the document (U39) and which no reader
  // shortcut answers (main.js drops every modified key).
  panel.addEventListener('keydown', (event) => {
    if (!isZoomKey(event)) event.stopPropagation();
  });

  docEl.addEventListener('paste', (event) => {
    const el = event.target.closest?.(TEXT_SELECTOR);
    if (!el) return;
    event.preventDefault();   // never let markup in, even when there is no plain text
    const pasted = event.clipboardData?.getData('text/plain') || '';
    if (!pasted) return;
    const id = blockIdOf(el);
    const text = readText(el);
    const caret = caretOffset(el);
    commit(setText(model, id, text.slice(0, caret) + pasted + text.slice(caret)), id, caret + pasted.length);
  });

  docEl.addEventListener('click', (event) => {
    const box = event.target.closest?.('.ne-check');
    if (!box) return;
    const id = box.dataset.id;
    commit(toggleChecked(model, id), id, model[indexOfBlock(model, id)]?.text.length ?? 0);
  });

  // A click on the column's empty space (padding, gaps, below the last block)
  // still lands in the editor. A press beside a row is the mousedown below's (it
  // selects in the row); this catches the rest, and leaves a click that selected alone.
  panel.addEventListener('click', (event) => {
    if (!enabled || event.button !== 0 || event.target.closest?.(NOT_EMPTY_SPACE)) return;
    if (selectsInNote()) return;
    focusAt(event.clientX, event.clientY);
  });

  /**
   * Caret into the text block nearest to (x, y), or at the end of the note. In the margin
   * view only the rows drawn inside the column count: the rest are pinned to pages that
   * have scrolled away, and a caret put there writes into a note the reader cannot see.
   * With none on screen the click opens a note where the reader is instead.
   */
  function focusAt(x, y) {
    const all = [...docEl.querySelectorAll(TEXT_SELECTOR)];
    const shown = view === VIEW_MARGIN ? all.filter(inColumn) : all;
    if (all.length && !shown.length && openNoteHere()) return;
    const texts = shown.length ? shown : all;
    const last = model[model.length - 1];
    const belowAll = !texts.length || y > texts[texts.length - 1].getBoundingClientRect().bottom;
    if (belowAll && (!last || last.type === 'divider')) {
      const next = insertAfter(model, last?.id, [{ text: '' }]);
      commit(next.blocks, next.focusId, 0);
      return;
    }
    const gap = (el) => {
      const r = el.getBoundingClientRect();
      return Math.max(r.top - y, y - r.bottom, 0);
    };
    const nearest = texts.reduce((best, el) => (gap(el) < gap(best) ? el : best));
    placeCaret(nearest, offsetAtPoint(nearest, x, y) ?? readText(nearest).length);
  }

  /** Is `el` drawn inside the column, rather than beside a page scrolled out of it? */
  function inColumn(el) {
    const row = el.getBoundingClientRect();
    const band = docEl.getBoundingClientRect();
    return row.bottom > band.top && row.top < band.bottom;
  }

  /**
   * A new empty note pinned where the reader is (D1), so that it is drawn where they are
   * looking before anything is typed in it. `adoptAnchor` never re-pins the head of a
   * pinned note, so this is the place it keeps. False when there is no page to pin it to.
   */
  function openNoteHere() {
    const anchor = getAnchor();
    if (!anchor) return false;
    const next = insertAfter(model, model[model.length - 1]?.id, [{ text: '', anchor }]);
    unwritten = next.focusId;
    commit(next.blocks, next.focusId, 0);
    return true;
  }

  /**
   * Leaving the row {@link openNoteHere} made without writing in it takes the note away
   * again, so a click that came to nothing does not leave an empty note in the paper.
   * Only its own wrapper goes: focus may be on its way into another note's row, which a
   * re-render would destroy.
   */
  function dropUnwritten(id) {
    if (!id || id !== unwritten) return;
    unwritten = null;
    if (!isEmptyNote(model, id)) return;
    model = model.filter((b) => b.id !== id);
    rowFor(id)?.closest(NOTE_SELECTOR)?.remove();
    report();
    onRender();
  }

  /** The caret position under (x, y) clamped into `el`, or null when the browser cannot say. */
  function rangeAtPoint(el, x, y) {
    const doc = el.ownerDocument || document;
    if (typeof doc.caretRangeFromPoint !== 'function') return null;
    const r = el.getBoundingClientRect();
    const clamp = (value, low, high) => Math.min(Math.max(value, low + 1), high - 1);
    const range = doc.caretRangeFromPoint(clamp(x, r.left, r.right), clamp(y, r.top, r.bottom));
    return range && el.contains(range.startContainer) ? range : null;
  }

  /** The text offset under (x, y) clamped into `el`, or null when the browser cannot say. */
  function offsetAtPoint(el, x, y) {
    const doc = el.ownerDocument || document;
    const range = rangeAtPoint(el, x, y);
    if (!range) return null;
    const upTo = doc.createRange();
    upTo.selectNodeContents(el);
    upTo.setEnd(range.startContainer, range.startOffset);
    return upTo.toString().length;
  }

  /**
   * A drag that starts in the padding beside a row selects in that row. The browser will not:
   * pywebview makes the padding `user-select: none`, so Chromium starts no selection there, and
   * WebKit starts one outside the row (or not at all), which cannot reach into an editable row.
   * So the press puts the selection's start in the row itself and the drag moves its end.
   */
  panel.addEventListener('mousedown', (event) => {
    if (!enabled || event.button !== 0 || event.target.closest?.(NOT_EMPTY_SPACE)) return;
    const el = rowBeside(event.clientY);
    const base = el && rangeAtPoint(el, event.clientX, event.clientY);
    if (!base) return;
    event.preventDefault();
    el.focus();
    const doc = el.ownerDocument;
    const selection = doc.getSelection();
    const select = (at) => {
      const end = rangeAtPoint(el, at.clientX, at.clientY) || base;
      selection.setBaseAndExtent(base.startContainer, base.startOffset, end.startContainer, end.startOffset);
    };
    // A move with the button up means the mouseup went elsewhere (another window): the drag is over.
    const extend = (move) => ((move.buttons & PRIMARY_BUTTON) ? select(move) : stop());
    const stop = () => {
      doc.removeEventListener('mousemove', extend);
      doc.removeEventListener('mouseup', stop);
    };
    select(event);
    doc.addEventListener('mousemove', extend);
    doc.addEventListener('mouseup', stop, { once: true });
  });

  /** The text row drawn in the column at height `y`, if there is one. */
  function rowBeside(y) {
    return [...docEl.querySelectorAll(TEXT_SELECTOR)].find((el) => {
      const r = el.getBoundingClientRect();
      return inColumn(el) && y >= r.top && y <= r.bottom;
    }) || null;
  }

  docEl.addEventListener('focusin', (event) => {
    const row = event.target.closest?.(BLOCK_SELECTOR);
    for (const other of docEl.querySelectorAll(BLOCK_SELECTOR)) other.classList.toggle('is-focused', other === row);
  });

  docEl.addEventListener('focusout', (event) => {
    // Clicking a menu item blurs the block; the menu must survive that.
    if (menu.element.contains(event.relatedTarget)) return;
    const row = event.target.closest?.(BLOCK_SELECTOR);
    row?.classList.remove('is-focused');
    menu.close();
    dropUnwritten(blockIdOf(event.target));
  });

  // ── Slash commands ──────────────────────────────────────────────────────────

  /** Apply the picked command to the block the `/` was typed in. */
  function runCommand(command) {
    const entry = slash;
    slash = null;
    if (!entry) return;
    const at = indexOfBlock(model, entry.id);
    if (at < 0) return;

    const el = textElFor(entry.id);
    const text = el ? readText(el) : model[at].text;
    const caret = el ? caretOffset(el) : text.length;
    const stripped = text.slice(0, entry.start) + text.slice(Math.max(entry.start, caret));
    const cleaned = setText(model, entry.id, stripped);

    if (command.action === 'quote-highlight') {
      quoteHighlight(cleaned, entry.id, entry.start);
      return;
    }
    if (command.type === 'divider') {
      const ruled = convertBlock(cleaned, entry.id, 'divider');
      const next = insertAfter(ruled, entry.id, [{ text: stripped }]);
      commit(next.blocks, next.focusId, 0);
      return;
    }
    commit(convertBlock(cleaned, entry.id, command.type), entry.id, entry.start);
  }

  function quoteHighlight(blocks, id, caret) {
    const quoted = highlightQuoteBlocks(getHighlight());
    if (!quoted) {
      commit(blocks, id, caret);
      onNotify(NO_HIGHLIGHT, 'warn');
      return;
    }
    const next = insertAfter(blocks, id, quoted);
    commit(next.blocks, next.focusId, next.caret);
  }

  // ── Views ───────────────────────────────────────────────────────────────────

  /**
   * "Margin | Sections": a radiogroup with one tab stop (the current option). Arrows move to
   * the other option, Space/Enter pick the focused one; none of them reach the player's keys.
   */
  function buildViewSwitch() {
    const group = document.createElement('div');
    group.className = 'ne-switch';
    group.id = 'notes-view';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Notes layout');
    group.hidden = true;   // nothing to lay out until a paper is open; ui.hideWelcome shows it
    const options = VIEW_OPTIONS.map(({ view: value, label, title: why }) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'ne-switch-opt';
      option.dataset.view = value;
      option.setAttribute('role', 'radio');
      option.title = why;
      option.textContent = label;
      return option;
    });
    group.append(...options);
    group.addEventListener('click', (event) => {
      const option = event.target.closest?.('.ne-switch-opt');
      if (option) setView(option.dataset.view, true);
    });
    group.addEventListener('keydown', (event) => {
      const option = event.target.closest?.('.ne-switch-opt');
      const isArrow = SWITCH_ARROWS.has(event.key);
      if (!option || (!isArrow && !SWITCH_PICKS.has(event.key))) return;
      event.preventDefault();
      event.stopPropagation();
      const target = isArrow ? options.find((o) => o !== option) : option;
      setView(target.dataset.view, true);
      target.focus();
    });
    return group;
  }

  function setView(next, report) {
    view = next === VIEW_SECTIONS ? VIEW_SECTIONS : VIEW_MARGIN;
    panel.classList.toggle('is-sections', view === VIEW_SECTIONS);
    viewSwitch.querySelectorAll('.ne-switch-opt').forEach((option) => {
      const isCurrent = option.dataset.view === view;
      option.setAttribute('aria-checked', String(isCurrent));
      option.tabIndex = isCurrent ? 0 : -1;
    });
    render();
    if (report) onViewChange(view);
  }
  setView(VIEW_MARGIN, false);

  // ── Public surface ──────────────────────────────────────────────────────────

  return {
    /** Load a document's blocks (from the server) without reporting a change back. */
    setBlocks(blocks) {
      model = ensureBlocks(sortNotes(Array.isArray(blocks) ? blocks : []));
      render();
    },
    blocks: () => model,
    /** @param {'margin'|'sections'} next */
    setView(next) { setView(next, false); },
    view: () => view,
    /** The paper's headings, once the script has been built. */
    setSections(list) {
      sections = Array.isArray(list) ? list : [];
      if (view === VIEW_SECTIONS) render();
    },
    /** No paper open → nothing to type into, and a hint saying why. */
    setEnabled(on) {
      enabled = Boolean(on);
      panel.classList.toggle('is-disabled', !enabled);
      docEl.hidden = !enabled;
      hint.hidden = enabled;
      if (!enabled) {
        model = [];
        docEl.textContent = '';
        menu.close();
      }
    },
    isEnabled: () => enabled,
    /** @param {'idle'|'saving'|'saved'|'error'} kind */
    setStatus(kind) {
      const label = STATUS_TEXT[kind] ?? '';
      status.textContent = label;
      status.title = label;
      status.dataset.state = label ? kind : 'idle';
    },
    focus() {
      const first = docEl.querySelector(TEXT_SELECTOR);
      if (first) placeCaret(first, 0);
    },
    element: panel,
    /** The surface the notes are laid out on; what marginnotes.js positions. */
    doc: docEl,
  };
}

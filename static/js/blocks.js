/**
 * blocks.js — the pure block model behind the per-paper notes editor (T7).
 *
 * No DOM, no imports: every function takes a block list and returns a NEW list,
 * so the editor can render from the result and the same functions can be tested
 * in Node. Blocks are frozen; nothing here mutates its argument.
 *
 * A block is `{ id, type, text, checked, anchor }`. `checked` only means anything
 * for `todo`; `divider` carries no text; `anchor` is where in the paper the note
 * this block opens is pinned (U8, see anchors.js) and is null on every block that
 * continues the note above it. The wire shape is the same object, and
 * `kokoro_reader.notes_store` validates it again on the way in.
 */

import { cleanAnchor } from './anchors.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_TYPE = 'p';
export const BLOCK_TYPES = Object.freeze(
  ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'quote', 'code', 'divider'],
);
/** Types that continue themselves when Enter splits them. */
export const LIST_TYPES = Object.freeze(['ul', 'ol', 'todo']);
/** Mirrors notes_store.MAX_BLOCKS / MAX_BLOCK_CHARS; both sides clamp. */
export const MAX_BLOCKS = 2000;
export const MAX_BLOCK_CHARS = 10000;

const ID_RADIX = 36;
const ID_RANDOM_CHARS = 10;

// ── Creation ──────────────────────────────────────────────────────────────────

/** A collision-resistant id that works in a browser and in Node. */
export function newId() {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random.replace(/-/g, '').slice(0, 24);
  return `${Date.now().toString(ID_RADIX)}${Math.random().toString(ID_RADIX).slice(2, 2 + ID_RANDOM_CHARS)}`;
}

/** @param {{id?:string, type?:string, text?:string, checked?:boolean, anchor?:object}} [patch] */
export function createBlock(patch = {}) {
  return Object.freeze({
    id: typeof patch.id === 'string' && patch.id ? patch.id : newId(),
    type: BLOCK_TYPES.includes(patch.type) ? patch.type : DEFAULT_TYPE,
    text: cleanText(patch.text),
    checked: patch.checked === true,
    anchor: cleanAnchor(patch.anchor),
  });
}

function cleanText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_BLOCK_CHARS) : '';
}

/** An editor always has something to type into. */
export function ensureBlocks(blocks) {
  return blocks && blocks.length > 0 ? blocks : [createBlock()];
}

// ── Parsing / serialising ─────────────────────────────────────────────────────

/** Tolerant parse of whatever the server (or an old client) stored. Never throws. */
export function parseBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_BLOCKS) break;
    if (!item || typeof item !== 'object') continue;
    const block = createBlock(item);
    // A duplicate id would make two rows share one caret; re-key the later one.
    out.push(seen.has(block.id) ? createBlock({ ...block, id: newId() }) : block);
    seen.add(block.id);
  }
  return out;
}

/** The plain-object wire form. */
export function serializeBlocks(blocks) {
  return (blocks || []).slice(0, MAX_BLOCKS).map((b) => ({
    id: b.id,
    type: b.type,
    text: b.text,
    checked: b.checked === true,
    anchor: b.anchor ? { ...b.anchor } : null,
  }));
}

/** True when the list holds nothing a user would call a note. */
export function isEmptyDoc(blocks) {
  return !(blocks || []).some((b) => b.type === 'divider' || b.text.trim() !== '');
}

// ── Lookup ────────────────────────────────────────────────────────────────────

export function indexOfBlock(blocks, id) {
  return (blocks || []).findIndex((b) => b.id === id);
}

function replaceAt(blocks, index, block) {
  return blocks.map((current, i) => (i === index ? block : current));
}

// ── Edits (every one returns a new list) ──────────────────────────────────────

export function setText(blocks, id, text) {
  const i = indexOfBlock(blocks, id);
  if (i < 0) return blocks;
  return replaceAt(blocks, i, createBlock({ ...blocks[i], text }));
}

/**
 * Pin block `id` to a place in the paper, so it opens a note there (U8).
 * @param {object|null} anchor see anchors.js
 */
export function setAnchor(blocks, id, anchor) {
  const i = indexOfBlock(blocks, id);
  if (i < 0) return blocks;
  return replaceAt(blocks, i, createBlock({ ...blocks[i], anchor }));
}

export function toggleChecked(blocks, id) {
  const i = indexOfBlock(blocks, id);
  if (i < 0 || blocks[i].type !== 'todo') return blocks;
  return replaceAt(blocks, i, createBlock({ ...blocks[i], checked: !blocks[i].checked }));
}

/**
 * Convert one block's type, keeping its text. A divider keeps no text and a
 * non-todo keeps no checkbox, so both are dropped rather than left stale.
 */
export function convertBlock(blocks, id, type) {
  const i = indexOfBlock(blocks, id);
  if (i < 0 || !BLOCK_TYPES.includes(type)) return blocks;
  const next = createBlock({
    id: blocks[i].id,
    type,
    text: type === 'divider' ? '' : blocks[i].text,
    checked: type === 'todo' && blocks[i].checked,
    // The note is still pinned where it was: what changed is how this row is typed.
    anchor: blocks[i].anchor,
  });
  return replaceAt(blocks, i, next);
}

/**
 * The list with block `at` gone, its anchor kept in the paper: the row below it takes over
 * as the note's head. A note is a run of rows headed by an anchored one (see anchors.js),
 * so dropping the row that carries the anchor hands every row under it to the note above —
 * the whole note silently relocating to a place the reader never put it. A note whose only
 * row this was has nobody to inherit the anchor, and goes with it.
 */
function removeAt(blocks, at) {
  const rest = blocks.filter((_, i) => i !== at);
  const anchor = blocks[at]?.anchor || null;
  const heir = rest[at];
  if (!anchor || !heir || heir.anchor) return rest;
  return replaceAt(rest, at, createBlock({ ...heir, anchor }));
}

export function removeBlock(blocks, id) {
  const i = indexOfBlock(blocks, id);
  if (i < 0) return blocks;
  return ensureBlocks(blocks.filter((_, at) => at !== i));
}

/**
 * Insert blocks after `id` (or at the end when `id` is unknown).
 * @returns {{blocks:Array, focusId:string, caret:number}}
 */
export function insertAfter(blocks, id, added) {
  const inserted = (added || []).map((b) => createBlock(b));
  if (inserted.length === 0) return { blocks, focusId: id, caret: 0 };
  const i = indexOfBlock(blocks, id);
  const at = i < 0 ? blocks.length : i + 1;
  const next = [...blocks.slice(0, at), ...inserted, ...blocks.slice(at)].slice(0, MAX_BLOCKS);
  const last = inserted[inserted.length - 1];
  return { blocks: next, focusId: last.id, caret: last.text.length };
}

/** Enter: what the block created after `type` should be. */
export function typeAfter(type) {
  return LIST_TYPES.includes(type) ? type : DEFAULT_TYPE;
}

/**
 * Enter at `caret` inside block `id`.
 * An empty list item leaves the list instead of extending it (Notion's rule).
 * @returns {{blocks:Array, focusId:string, caret:number}}
 */
export function splitBlock(blocks, id, caret) {
  const i = indexOfBlock(blocks, id);
  if (i < 0) return { blocks, focusId: id, caret: 0 };
  const block = blocks[i];
  if (LIST_TYPES.includes(block.type) && block.text === '') {
    return { blocks: convertBlock(blocks, id, DEFAULT_TYPE), focusId: id, caret: 0 };
  }
  const at = clampCaret(caret, block.text.length);
  const head = createBlock({ ...block, text: block.text.slice(0, at) });
  const tail = createBlock({
    type: typeAfter(block.type),
    text: block.text.slice(at),
    checked: false,
  });
  const next = [...blocks.slice(0, i), head, tail, ...blocks.slice(i + 1)].slice(0, MAX_BLOCKS);
  return { blocks: next, focusId: tail.id, caret: 0 };
}

function clampCaret(caret, length) {
  const n = Number.isFinite(caret) ? Math.trunc(caret) : length;
  return Math.min(length, Math.max(0, n));
}

/**
 * Backspace with the caret at offset 0.
 *   - a typed block (heading, list, quote, code…) becomes a paragraph
 *   - a paragraph swallows the divider above it, or merges into the block above
 * Either way the row that goes hands its anchor to the row below, so a note keeps its
 * place in the paper when the reader deletes the row it was pinned to.
 *   - the very first paragraph does nothing
 * @returns {{blocks:Array, focusId:string, caret:number}|null} null = no change
 */
export function backspaceAtStart(blocks, id) {
  const i = indexOfBlock(blocks, id);
  if (i < 0) return null;
  const block = blocks[i];
  if (block.type !== DEFAULT_TYPE) {
    return { blocks: convertBlock(blocks, id, DEFAULT_TYPE), focusId: id, caret: 0 };
  }
  if (i === 0) return null;
  const previous = blocks[i - 1];
  if (previous.type === 'divider') {
    return { blocks: removeAt(blocks, i - 1), focusId: id, caret: 0 };
  }
  const merged = createBlock({ ...previous, text: previous.text + block.text });
  const next = removeAt(replaceAt(blocks, i - 1, merged), i);
  return { blocks: next, focusId: merged.id, caret: previous.text.length };
}

// ── Markdown shortcuts ────────────────────────────────────────────────────────

/** Prefixes are tried in order, so `## ` cannot be shadowed by `# `. */
const SHORTCUTS = Object.freeze([
  ['### ', 'h3'],
  ['## ', 'h2'],
  ['# ', 'h1'],
  ['- [ ] ', 'todo'],
  ['- [] ', 'todo'],
  ['[ ] ', 'todo'],
  ['[] ', 'todo'],
  ['- ', 'ul'],
  ['* ', 'ul'],
  ['1. ', 'ol'],
  ['> ', 'quote'],
  ['```', 'code'],
  ['---', 'divider'],
]);

/**
 * The block type a freshly typed prefix asks for.
 * @param {string} text the block's full text
 * @returns {{type:string, rest:string}|null}
 */
export function markdownShortcut(text) {
  const value = typeof text === 'string' ? text : '';
  for (const [prefix, type] of SHORTCUTS) {
    if (value.startsWith(prefix)) return { type, rest: value.slice(prefix.length) };
  }
  return null;
}

/**
 * Apply a markdown shortcut typed at the start of block `id`, if there is one.
 * A divider consumes the block and leaves a fresh paragraph to carry on in.
 * @returns {{blocks:Array, focusId:string, caret:number}|null} null = no shortcut
 */
export function applyShortcut(blocks, id, text) {
  const i = indexOfBlock(blocks, id);
  if (i < 0 || blocks[i].type === 'code') return null;
  const hit = markdownShortcut(text);
  if (!hit || hit.type === blocks[i].type) return null;
  if (hit.type === 'divider') {
    const divider = createBlock({ id: blocks[i].id, type: 'divider', anchor: blocks[i].anchor });
    return insertAfter(replaceAt(blocks, i, divider), divider.id, [{ text: hit.rest }]);
  }
  const converted = createBlock({ id: blocks[i].id, type: hit.type, text: hit.rest, anchor: blocks[i].anchor });
  // The prefix was just typed, so the caret sits where it was: in front of the rest.
  return { blocks: replaceAt(blocks, i, converted), focusId: converted.id, caret: 0 };
}

// ── Slash menu ────────────────────────────────────────────────────────────────

/** `type` converts the current block; `action` is handled by the editor. */
export const SLASH_COMMANDS = Object.freeze([
  { id: 'p', type: 'p', label: 'Text', hint: 'Plain paragraph', keywords: 'paragraph body plain' },
  { id: 'h1', type: 'h1', label: 'Heading 1', hint: '# ', keywords: 'title big' },
  { id: 'h2', type: 'h2', label: 'Heading 2', hint: '## ', keywords: 'subtitle' },
  { id: 'h3', type: 'h3', label: 'Heading 3', hint: '### ', keywords: 'subheading small' },
  { id: 'ul', type: 'ul', label: 'Bulleted list', hint: '- ', keywords: 'bullet unordered item' },
  { id: 'ol', type: 'ol', label: 'Numbered list', hint: '1. ', keywords: 'ordered number' },
  { id: 'todo', type: 'todo', label: 'To-do', hint: '[] ', keywords: 'task checkbox check' },
  { id: 'quote', type: 'quote', label: 'Quote', hint: '> ', keywords: 'blockquote cite' },
  { id: 'code', type: 'code', label: 'Code', hint: '```', keywords: 'monospace snippet' },
  { id: 'divider', type: 'divider', label: 'Divider', hint: '---', keywords: 'rule separator line' },
  {
    id: 'highlight',
    action: 'quote-highlight',
    label: 'Quote current highlight',
    hint: 'From the PDF',
    keywords: 'highlight selection pdf citation page',
  },
]);

/**
 * Characters that open the slash menu: `/`, and `、`, which the `/` key types
 * with Chinese punctuation on (Pinyin) — Notion accepts both.
 */
export const SLASH_TRIGGERS = Object.freeze(['/', '、']);
export const isSlashTrigger = (char) => SLASH_TRIGGERS.includes(char);

/** The markdown a command's block is typed as (`#`, `-`, `[]` …), so `/#` finds what the hint shows. */
const syntaxOf = (command) => SHORTCUTS.filter(([, type]) => type === command.type).map(([prefix]) => prefix.trim());

/**
 * Slash-menu filter: an exact markdown match ranks first, then label, id,
 * partial markdown and keyword matches; order within a rank is stable.
 * @param {string} query text typed after the `/`
 */
export function filterCommands(query, commands = SLASH_COMMANDS) {
  const q = String(query || '').trim().toLowerCase().replace(/^\//, '');
  if (!q) return [...commands];
  const rank = (command) => {
    const label = command.label.toLowerCase();
    const syntax = syntaxOf(command);
    if (syntax.includes(q)) return 0;
    if (label.startsWith(q)) return 1;
    if (command.id.startsWith(q)) return 2;
    if (syntax.some((prefix) => prefix.startsWith(q))) return 3;
    if (label.includes(q)) return 4;
    return `${command.keywords} ${command.id}`.includes(q) ? 5 : -1;
  };
  return commands
    .map((command, at) => ({ command, at, rank: rank(command) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((entry) => entry.command);
}

/** Step the slash menu's selection, wrapping at both ends. */
export function stepSelection(index, delta, length) {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

// ── Quoting a highlight ───────────────────────────────────────────────────────

/**
 * The quote block for a PDF highlight: its text, then the page it came from.
 * @param {{text?:string, page?:number}} highlight
 * @returns {Array<object>|null} blocks to insert, or null when there is nothing to quote
 */
export function highlightQuoteBlocks(highlight) {
  const text = String(highlight?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const page = Number(highlight.page) > 0 ? Math.trunc(Number(highlight.page)) : null;
  const body = page === null ? text : `${text}\n— p. ${page}`;
  return [{ type: 'quote', text: body }, { type: DEFAULT_TYPE, text: '' }];
}

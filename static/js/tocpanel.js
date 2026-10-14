/**
 * tocpanel.js — the paper's contents as a folding tree (N7), in the Read tab (R2).
 *
 * Chapters show; their sections fold under a disclosure button. Every entry is a button,
 * and the arrow keys walk the visible entries the way a file tree does (Up/Down, Right
 * unfolds then steps in, Left folds then steps out, Home/End). The entry the reader is in
 * carries aria-current, and the folded chapters above it say they hold it.
 *
 * A click only selects an entry (and folds or unfolds its sections); a double-click or
 * Enter picks it, which moves the voice there (Q-R2). Selection follows the arrow keys.
 *
 * Presentation only: entries come from toc.js, a pick goes back through `onPick`.
 */

import { parentsOf, ancestorsOf } from './toc.js';

const EMPTY_TEXT = 'No outline or headings found in this paper.';
const HEADINGS_NOTE = 'Detected headings (this PDF has no outline).';
const TREE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']);
const PICK_KEY = 'Enter';
const SELECTED_CLASS = 'is-selected';

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Survives a re-render (headings arrive batch by batch): what the reader unfolded stays open. */
const entryKey = (e) => `${e.depth}:${e.page}:${e.title}`;

/**
 * @param {{root: HTMLElement|null, onPick?: (entry: object, pos: number) => void,
 *          pageLabel?: (page: number) => string}} deps
 * @returns {{render: (toc: {source: string, entries: object[]}) => void, markCurrent: (pos: number) => void}}
 */
export function createTocPanel({ root, onPick = () => {}, pageLabel = (page) => String(page) } = {}) {
  let entries = [];
  let parents = [];
  let links = [];
  let current = -1;
  let selected = -1;
  const expanded = new Set();

  const itemOf = (pos) => links[pos]?.parentElement || null;
  const childListOf = (pos) => itemOf(pos)?.querySelector('.toc-children') || null;
  const twistyOf = (pos) => itemOf(pos)?.querySelector('.toc-twisty') || null;
  const isOpen = (pos) => twistyOf(pos)?.getAttribute('aria-expanded') === 'true';
  const isShown = (link) => {
    for (let n = link; n && n !== root; n = n.parentElement) if (n.hidden) return false;
    return true;
  };

  function setOpen(pos, open) {
    const twisty = twistyOf(pos);
    const list = childListOf(pos);
    if (!twisty || !list) return;
    twisty.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
    if (open) expanded.add(entryKey(entries[pos]));
    else expanded.delete(entryKey(entries[pos]));
  }

  function linkFor(entry, pos) {
    const link = make('button', 'toc-link');
    link.type = 'button';
    link.setAttribute('data-pos', String(pos));
    link.append(make('span', 'toc-title', entry.title), make('span', 'toc-page', pageLabel(entry.page)));
    return link;
  }

  function itemFor(entry, pos, hasChildren) {
    const item = make('li', 'toc-item');
    if (hasChildren) {
      const twisty = make('button', 'toc-twisty');
      twisty.type = 'button';
      twisty.setAttribute('aria-expanded', 'false');
      twisty.setAttribute('aria-label', `Sections of ${entry.title}`);
      item.appendChild(twisty);
    }
    const link = linkFor(entry, pos);
    item.appendChild(link);
    if (hasChildren) item.appendChild(Object.assign(make('ul', 'toc-children'), { hidden: true }));
    return { item, link };
  }

  function render(toc) {
    if (!root) return;
    entries = Array.isArray(toc?.entries) ? toc.entries : [];
    parents = parentsOf(entries);
    current = -1;
    selected = -1;
    if (!entries.length) {
      links = [];
      root.replaceChildren(make('p', 'toc-empty', EMPTY_TEXT));
      return;
    }
    const tree = make('ul', 'toc-tree');
    const built = entries.map((entry, pos) => itemFor(entry, pos, parents.includes(pos)));
    built.forEach(({ item }, pos) => {
      const parent = parents[pos];
      (parent >= 0 ? built[parent].item.querySelector('.toc-children') : tree).appendChild(item);
    });
    links = built.map(({ link }) => link);
    const note = toc.source === 'headings' ? [make('p', 'toc-note', HEADINGS_NOTE)] : [];
    root.replaceChildren(...note, tree);
    entries.forEach((entry, pos) => { if (expanded.has(entryKey(entry))) setOpen(pos, true); });
  }

  function markCurrent(pos) {
    if (!root || pos === current) return;
    if (current >= 0) {
      links[current]?.removeAttribute('aria-current');
      ancestorsOf(parents, current).forEach((a) => itemOf(a)?.classList.remove('has-current'));
    }
    current = links[pos] ? pos : -1;
    if (current < 0) return;
    links[current].setAttribute('aria-current', 'location');
    ancestorsOf(parents, current).forEach((a) => itemOf(a)?.classList.add('has-current'));
  }

  function select(pos) {
    links[selected]?.classList.remove(SELECTED_CLASS);
    selected = pos;
    links[pos]?.classList.add(SELECTED_CLASS);
  }

  function moveFocus(pos, key) {
    const shown = links.filter(isShown);
    const at = shown.indexOf(links[pos]);
    const hasChildren = Boolean(childListOf(pos));
    const target = {
      ArrowDown: () => shown[at + 1],
      ArrowUp: () => shown[at - 1],
      Home: () => shown[0],
      End: () => shown[shown.length - 1],
      ArrowRight: () => {
        if (!hasChildren) return null;
        if (isOpen(pos)) return links[pos + 1];
        setOpen(pos, true);
        return null;
      },
      ArrowLeft: () => {
        if (hasChildren && isOpen(pos)) { setOpen(pos, false); return null; }
        return links[parents[pos]];
      },
    }[key]();
    if (!target) return;
    select(links.indexOf(target));
    target.focus();
  }

  /** The entry a click or key landed on, or -1. */
  function posOf(e) {
    const twisty = e.target?.closest?.('.toc-twisty');
    const link = twisty ? twisty.parentElement.querySelector('.toc-link') : e.target?.closest?.('.toc-link');
    const pos = Number(link?.dataset.pos);
    return Number.isInteger(pos) && entries[pos] ? pos : -1;
  }

  function onClick(e) {
    const pos = posOf(e);
    if (pos < 0) return;
    const isTwisty = Boolean(e.target?.closest?.('.toc-twisty'));
    if (!isTwisty) {
      select(pos);
      links[pos].focus();   // Safari gives a clicked button no focus; Enter must find it
      if (e.detail > 1) return;   // the second click of a double-click: leave the fold as the first set it
    }
    if (childListOf(pos)) setOpen(pos, !isOpen(pos));
  }

  function pick(pos) {
    select(pos);
    onPick(entries[pos], pos);
  }

  if (root) {
    root.addEventListener('click', onClick);
    root.addEventListener('dblclick', (e) => {
      const pos = e.target?.closest?.('.toc-link') ? posOf(e) : -1;
      if (pos >= 0) pick(pos);
    });
    root.addEventListener('keydown', (e) => {
      const link = e.target?.closest?.('.toc-link');
      const isTreeKey = TREE_KEYS.has(e.key) || e.key === PICK_KEY;
      if (!link || !isTreeKey || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();    // the transport steps sentences on the arrows; here they walk the tree
      if (e.key === PICK_KEY) pick(Number(link.dataset.pos));   // claimed: the button's own click would only select
      else moveFocus(Number(link.dataset.pos), e.key);
    });
  }

  return { render, markCurrent };
}

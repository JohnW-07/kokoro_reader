/**
 * slashmenu.js — the `/` command popup for the notes editor (T7).
 *
 * It owns nothing but its own popup: the editor tells it what was typed and the
 * menu answers with a command. Keyboard first (↑ ↓ Enter Esc), mouse-usable, and
 * every label is written with `textContent` — no user text ever reaches innerHTML.
 */

import { filterCommands, stepSelection } from './blocks.js';

const MENU_CLASS = 'ne-slash';
const ITEM_CLASS = 'ne-slash-item';
const ABOVE_CLASS = 'is-above';

/**
 * @param {{onPick:(command:object) => void, onClose?:() => void, bounds?:() => DOMRect}} deps
 *   `bounds` is the scrolling box the menu must stay inside (it is also kept inside the window).
 */
export function createSlashMenu({ onPick, onClose = () => {}, bounds = null }) {
  if (typeof onPick !== 'function') throw new TypeError('createSlashMenu: onPick must be a function');

  const menu = document.createElement('div');
  menu.className = MENU_CLASS;
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Insert a block');
  menu.hidden = true;

  let commands = [];
  let selected = 0;
  let open = false;

  function renderItems() {
    menu.textContent = '';
    commands.forEach((command, at) => {
      const item = document.createElement('div');
      item.className = ITEM_CLASS;
      item.setAttribute('role', 'option');
      item.setAttribute('data-command', command.id);
      item.setAttribute('aria-selected', String(at === selected));
      if (at === selected) item.classList.add('is-selected');
      const label = document.createElement('span');
      label.className = 'ne-slash-label';
      label.textContent = command.label;
      const hint = document.createElement('span');
      hint.className = 'ne-slash-hint';
      hint.textContent = command.hint || '';
      item.append(label, hint);
      menu.appendChild(item);
    });
  }

  function syncSelection() {
    [...menu.children].forEach((item, at) => {
      item.classList.toggle('is-selected', at === selected);
      item.setAttribute('aria-selected', String(at === selected));
    });
    menu.children[selected]?.scrollIntoView({ block: 'nearest' });
  }

  // mousedown, not click: a click would first blur the block and lose the caret.
  menu.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const item = event.target.closest?.(`.${ITEM_CLASS}`);
    const at = item ? [...menu.children].indexOf(item) : -1;
    if (at < 0) return;
    selected = at;
    choose();
  });

  /**
   * Show the menu under `anchor` for `query`.
   * @returns {boolean} false when nothing matches, in which case it stays closed
   */
  function show(anchor, query) {
    commands = filterCommands(query);
    if (commands.length === 0) {
      close();
      return false;
    }
    selected = 0;
    renderItems();
    if (menu.parentElement !== anchor) anchor.appendChild(menu);
    menu.hidden = false;
    open = true;
    place(anchor);
    return true;
  }

  /**
   * Below the block when it fits, else on whichever side has more room, and
   * never taller than that room, so every item stays on screen and clickable.
   */
  function place(anchor) {
    menu.classList.remove(ABOVE_CLASS);
    menu.style.maxHeight = '';
    const box = bounds?.() ?? { top: 0, bottom: window.innerHeight };
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, window.innerHeight);
    const row = anchor.getBoundingClientRect();
    const own = menu.getBoundingClientRect();
    const gap = own.top - row.bottom;
    const below = bottom - own.top;
    const above = row.top - gap - top;
    const upward = own.height > below && above > below;
    menu.classList.toggle(ABOVE_CLASS, upward);
    const room = Math.floor(upward ? above : below);
    if (own.height > room) menu.style.maxHeight = `${Math.max(room, 0)}px`;
  }

  function close() {
    if (!open && menu.hidden) return;
    menu.hidden = true;
    open = false;
    menu.remove();
    onClose();
  }

  function move(delta) {
    if (!open) return;
    selected = stepSelection(selected, delta, commands.length);
    syncSelection();
  }

  // onPick runs *before* close(): closing tells the editor to forget where the
  // `/` was typed, and the command needs that spot to know what to replace.
  function choose() {
    if (!open) return false;
    const command = commands[selected];
    if (command) onPick(command);
    close();
    return Boolean(command);
  }

  return {
    show,
    close,
    move,
    choose,
    isOpen: () => open,
    /** For tests and asserts. */
    commands: () => [...commands],
    element: menu,
  };
}

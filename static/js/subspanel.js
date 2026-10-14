/**
 * subspanel.js — the Subs tab (T6): rows of "printed text → say instead", an
 * ignore-case toggle and a delete button per row, and a row for adding one.
 *
 * Editing is live-validated on every keystroke but only *committed* (handed to
 * `onChange`, which saves the prefs and rebuilds the script) when an edit lands:
 * a field's `change` (blur or Enter), a toggle, a delete or an add. Rebuilding on
 * every keystroke would restart playback once per letter.
 *
 * The rules live in subs.js; this file only draws them. No `confirm()`/`alert()`:
 * native modal dialogs freeze the pywebview bridge.
 */

import * as subs from './subs.js';

const EMPTY_DRAFT = Object.freeze({ find: '', replace: '', ignore_case: false });

/** Assigned as DOM properties; everything else becomes an attribute. */
const PROPERTIES = new Set(['value', 'checked', 'type', 'id', 'hidden', 'maxLength', 'placeholder', 'autocomplete', 'spellcheck']);

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (PROPERTIES.has(key)) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}

function showError(node, input, message) {
  node.textContent = message;
  node.hidden = !message;
  input.setAttribute('aria-invalid', String(Boolean(message)));
}

const textInput = (props) => h('input', {
  type: 'text', className: 'sub-input', autocomplete: 'off', spellcheck: false, ...props,
});

/**
 * @param {object}   opts
 * @param {HTMLElement} opts.root     the panel element (#tab-subs)
 * @param {ReadonlyArray<object>} opts.subs  saved rows
 * @param {(rows: ReadonlyArray<object>) => void} opts.onChange  called with every committed list
 */
export function createSubsPanel({ root, subs: initial = [], onChange = () => {} }) {
  let rows = subs.loadSubs(initial);
  let draft = EMPTY_DRAFT;
  let submitted = false;   // an empty find is only an error once the user tried to add it
  let rowViews = [];

  const commit = () => onChange(rows);

  // ── Add row ────────────────────────────────────────────────────────────────
  const addFind = textInput({ id: 'subAddFind', placeholder: 'e.g. GR00T', maxLength: subs.MAX_FIND_CHARS,
    'aria-describedby': 'subAddError' });
  const addSay = textInput({ id: 'subAddSay', placeholder: 'e.g. groot', maxLength: subs.MAX_REPLACE_CHARS });
  const addCase = h('input', { type: 'checkbox', id: 'subAddCase' });
  const addError = h('p', { className: 'sub-error', id: 'subAddError', hidden: true });
  const addForm = h('form', { className: 'sub-add', 'aria-label': 'Add a substitution', novalidate: '' }, [
    h('label', { className: 'sub-field', for: 'subAddFind' }, [h('span', { className: 'label', text: 'Printed text' })]),
    addFind,
    h('label', { className: 'sub-field', for: 'subAddSay' }, [h('span', { className: 'label', text: 'Say instead' })]),
    addSay,
    h('div', { className: 'sub-add-foot' }, [
      h('label', { className: 'sub-case' }, [addCase, h('span', { text: 'Ignore case' })]),
      h('button', { type: 'submit', className: 'sub-add-btn', text: 'Add' }),
    ]),
    addError,
  ]);

  const refreshDraft = () => {
    const message = subs.validateDraft(rows, draft);
    const visible = message === subs.MESSAGES.emptyFind && !submitted ? '' : message;
    showError(addError, addFind, visible);
  };
  const readDraft = () => {
    draft = subs.makeSub({ find: addFind.value, replace: addSay.value, ignore_case: addCase.checked });
    refreshDraft();
  };
  addFind.addEventListener('input', readDraft);
  addSay.addEventListener('input', readDraft);
  addCase.addEventListener('change', readDraft);
  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    readDraft();
    submitted = true;
    if (subs.validateDraft(rows, draft)) {
      refreshDraft();
      addFind.focus();
      return;
    }
    rows = subs.addSub(rows, draft);
    draft = EMPTY_DRAFT;
    submitted = false;
    addFind.value = '';
    addSay.value = '';
    addCase.checked = false;
    renderList();
    refreshDraft();
    addFind.focus();
    commit();
  });

  // ── Rows ───────────────────────────────────────────────────────────────────
  const count = h('span', { className: 'sub-count' });
  const list = h('ul', { className: 'sub-list', 'aria-label': 'Substitutions' });

  const refreshRows = () => {
    const errors = subs.validate(rows);
    rowViews.forEach((view, i) => showError(view.error, view.find, errors[i]));
    refreshDraft();
  };

  const edit = (index, patch) => {
    rows = subs.updateSub(rows, index, patch);
    refreshRows();
  };

  /** Focus moves to the row that took the deleted one's place, else the add field. */
  const removeRow = (index) => {
    rows = subs.removeSub(rows, index);
    renderList();
    const next = rowViews[index] || rowViews[index - 1];
    (next ? next.remove : addFind).focus();
    commit();
  };

  function rowView(row, index) {
    const n = index + 1;
    const errorId = `subError${n}`;
    const label = row.find.trim() || `substitution ${n}`;
    const find = textInput({ value: row.find, maxLength: subs.MAX_FIND_CHARS,
      'aria-label': `Printed text, substitution ${n}`, 'aria-describedby': errorId });
    const say = textInput({ value: row.replace, maxLength: subs.MAX_REPLACE_CHARS,
      'aria-label': `Say instead, substitution ${n}` });
    const ignoreCase = h('input', { type: 'checkbox', checked: row.ignore_case,
      'aria-label': `Ignore case, substitution ${n}` });
    const remove = h('button', { type: 'button', className: 'sub-delete', text: '×',
      'aria-label': `Delete substitution for ${label}`, title: 'Delete' });
    const error = h('p', { className: 'sub-error', id: errorId, hidden: true });

    find.addEventListener('input', () => edit(index, { find: find.value }));
    say.addEventListener('input', () => edit(index, { replace: say.value }));
    find.addEventListener('change', commit);
    say.addEventListener('change', commit);
    ignoreCase.addEventListener('change', () => { edit(index, { ignore_case: ignoreCase.checked }); commit(); });
    remove.addEventListener('click', () => removeRow(index));

    const node = h('li', { className: 'sub-row' }, [
      h('div', { className: 'sub-pair' }, [find, h('span', { className: 'sub-arrow', 'aria-hidden': 'true', text: '→' }), say]),
      h('div', { className: 'sub-row-foot' }, [
        h('label', { className: 'sub-case', title: 'Match GR00T, Gr00t and gr00t alike' },
          [ignoreCase, h('span', { text: 'Ignore case' })]),
        remove,
      ]),
      error,
    ]);
    return { node, find, remove, error };
  }

  function renderList() {
    rowViews = rows.map(rowView);
    list.replaceChildren(...rowViews.map((view) => view.node));
    count.textContent = rows.length ? String(rows.length) : '';
    empty.hidden = rows.length > 0;
    refreshRows();
  }

  const empty = h('p', { className: 'hint sub-empty', text: 'No substitutions yet.' });

  root.replaceChildren(h('div', { className: 'stack sub-panel' }, [
    h('p', { className: 'hint sub-intro',
      text: 'Say something else wherever a word is printed. Matches whole words; the page text is unchanged.' }),
    addForm,
    h('div', { className: 'sub-head' }, [h('span', { className: 'label', text: 'Substitutions' }), count]),
    empty,
    list,
  ]));
  renderList();

  return {
    /** @returns {ReadonlyArray<object>} the rows as currently edited, valid or not */
    rows: () => rows,
  };
}

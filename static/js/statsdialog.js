// ── Stats dialog ─────────────────────────────────────────────────────────────
// Opens the Wrapped page (stats.html) over the reader in a modal <dialog> with an
// iframe: navigating away would unload the open PDF, and pywebview drops
// window.open. The pending listening batch is flushed first so the numbers are
// current, but never waited on for more than FLUSH_TIMEOUT_MS. The page closes
// itself by posting CLOSE_MESSAGE. The open paper's ETA numbers ride in the frame's
// URL for the page's "This paper" section (N11).

import { listenLog } from './listenlog.js';
import * as state from './state.js';
import { currentEta, paperQuery } from './eta.js';

const PAGE_URL = '/static/stats.html?embed=1';
const CLOSE_MESSAGE = 'kokoro-stats-close';
const DIALOG_ID = 'stats-dialog';
/** A stuck stats POST must not keep the dialog shut; the batch still lands later. */
export const FLUSH_TIMEOUT_MS = 2000;

/** Resolves when `promise` settles or after `ms`, whichever is first; never rejects. */
function settledWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve(promise).catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
  });
}

function buildDialog() {
  const dialog = document.createElement('dialog');
  dialog.id = DIALOG_ID;
  dialog.setAttribute('aria-label', 'Reading stats');
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  document.body.append(dialog);
  return dialog;
}

export function initStatsDialog(button = document.getElementById('statsBtn'), {
  flush = () => listenLog().flush(), flushTimeoutMs = FLUSH_TIMEOUT_MS,
  paper = () => paperQuery(state.get().docId, currentEta(state.get())),
} = {}) {
  if (!button) return null;
  let dialog = null;
  let opening = false;

  async function open() {
    if (opening || dialog?.open) return;   // a second showModal() on an open dialog throws
    opening = true;
    try {
      await settledWithin(flush(), flushTimeoutMs);
    } finally {
      opening = false;
    }
    dialog = dialog || buildDialog();
    const frame = document.createElement('iframe');   // a new frame: fresh numbers, no stale flash
    frame.title = 'Reading stats';
    const query = paper();
    frame.src = query ? `${PAGE_URL}&${query}` : PAGE_URL;
    dialog.replaceChildren(frame);
    dialog.addEventListener('close', () => button.focus(), { once: true });
    dialog.showModal();
    frame.focus();
  }

  button.addEventListener('click', open);
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin || ev.data?.type !== CLOSE_MESSAGE) return;
    if (dialog?.open) dialog.close();
  });
  return { open };
}

initStatsDialog();

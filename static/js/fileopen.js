// ── Opening a file ───────────────────────────────────────────────────────────
// The drop zone (click, Enter/Space, drag and drop), the hidden file input and the
// desktop window's native picker all end in `onOpen(bytes, name)`. Only the file
// picked last may open: a slow read of an earlier pick must not land over it.

import { createLoadGate } from './loadgate.js';

/** @param {{ api: object, ui: object, onOpen: (bytes: Uint8Array, name: string) => unknown }} deps */
export function createFileOpen({ api, ui, onOpen }) {
  const pickGate = createLoadGate();

  async function openViaBridge() {
    if (!window.pywebview?.api) {
      ui.el('file-input').click();
      return;
    }
    let isLatest = () => true;              // a superseded pick's failure is not news
    try {
      const name = await window.pywebview.api.select_pdf();
      if (!name) return;
      isLatest = pickGate.begin();
      ui.setStatus(`Loading "${name}"…`, 'loading');
      const bytes = await api.pdfBytes();
      if (isLatest()) await onOpen(bytes, name);
    } catch (err) {
      if (isLatest()) ui.setStatus(`Could not open the file: ${err.message}`, 'error');
    }
  }

  function readFile(file) {
    const isLatest = pickGate.begin();
    const reader = new FileReader();
    reader.onload = () => isLatest() && onOpen(new Uint8Array(reader.result), file.name);
    reader.onerror = () => isLatest() && ui.setStatus(`Could not read "${file.name}".`, 'error');
    reader.readAsArrayBuffer(file);
  }

  function bindDropZone() {
    const zone = ui.el('drop-zone');
    zone.addEventListener('click', openViaBridge);
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViaBridge(); }
    });

    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('hover'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('hover'); }));
    zone.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type === 'application/pdf') readFile(file);
    });

    ui.el('file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) readFile(file);
      e.target.value = '';
    });
  }

  /**
   * A PDF dropped anywhere but #drop-zone is otherwise *navigated to*: the webview
   * replaces the app with the raw PDF and there is no way back without quitting
   * (H6). Cancelling both events on window and document makes the whole app a
   * drop target that does nothing, while #drop-zone's own handlers — which run
   * first, at the target — still open the file.
   */
  function blockStrayDrops() {
    const swallow = (e) => e.preventDefault();
    for (const target of [window, document]) {
      target.addEventListener('dragover', swallow);
      target.addEventListener('drop', swallow);
    }
  }

  return { bindDropZone, blockStrayDrops };
}

// ── Notes export ─────────────────────────────────────────────────────────────
// Markdown or JSON of the open paper's notes: a download in the browser, a native
// save dialog in the desktop window (which drops both window.open and <a download>).

/** Long enough for the download to start before its object URL is released. */
const REVOKE_DELAY_MS = 1000;

const notesJson = (s) => JSON.stringify(s.highlights, null, 2);

/** @param {{ api: object, state: object, ui: object }} deps */
export function createNotesExport({ api, state, ui }) {
  async function markdownExport(docId) {
    const res = await fetch(api.exportUrl(docId));
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    return res.text();
  }

  async function saveViaBridge(s, format, filename) {
    try {
      const text = format === 'md' ? await markdownExport(s.docId) : notesJson(s);
      const saved = await window.pywebview.api.save_export(filename, text);
      if (saved) ui.toast(`Saved "${saved}".`);
    } catch (err) {
      ui.toast(`Could not export notes: ${err.message}`, 'error');
    }
  }

  /** @param {'md'|'json'} format */
  function exportNotes(format) {
    const s = state.get();
    if (!s.docId) return;
    const filename = `${s.docName || 'notes'}.${format}`;
    if (window.pywebview?.api) {
      saveViaBridge(s, format, filename);
      return;
    }
    if (format === 'md') {
      window.open(api.exportUrl(s.docId), '_blank');
      return;
    }
    const blob = new Blob([notesJson(s)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }

  return { exportNotes };
}

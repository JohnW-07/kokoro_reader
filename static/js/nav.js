/**
 * nav.js — getting around a long paper (N7 contents, N8 printed page numbers).
 *
 * Keeps the page labels and the contents tree in step with the open paper, and moves the
 * reader to an entry or a page: while playing, a jump (reading carries on from there);
 * while paused, the page is rendered first, then the cursor moves and the view snaps to
 * it. Where nothing is read (a figure page, the index) the view just scrolls there.
 */

import { choosePageLabels, resolvePageInput } from './pagelabels.js';
import { outlineFromPdf, buildToc, currentEntry } from './toc.js';
import { createTocPanel } from './tocpanel.js';

const GOING_CLASS = 'is-going';

async function pdfPageLabels(doc) {
  try {
    return typeof doc?.getPageLabels === 'function' ? await doc.getPageLabels() : null;
  } catch {
    return null;   // a malformed /PageLabels tree costs the labels, never the paper
  }
}

/**
 * @param {{state: object, ui: object, pdfView: object, player: object, follower: object,
 *          jumpTo: (idx: number) => void}} deps
 * @returns {{goToEntry: (entry: object) => Promise<void>, goToPage: (page: number) => Promise<void>}}
 */
export function createNav({ state, ui, pdfView, player, follower, jumpTo }) {
  let fromPdf = Object.freeze({ labels: null, outline: [] });
  let labels = null;
  let toc = buildToc();
  let generation = 0;
  let prev = state.get();

  const panel = createTocPanel({
    root: ui.el('toc-panel'),
    onPick: (entry) => goToEntry(entry),
    pageLabel: (page) => labels?.[page - 1] || String(page),
  });

  function scrollOnly(page) {
    follower.suspend();
    pdfView.scrollToPage(page);
  }

  async function goToSentence(idx) {
    const { isPlaying, isLoading } = player.state();
    if (isPlaying || isLoading) { jumpTo(idx); return; }
    const page = state.get().sentences[idx]?.page;
    if (!page) return;
    const asked = generation;
    await pdfView.renderPage(page);
    if (asked !== generation) return;   // another paper opened meanwhile
    player.setIndex(idx);
    follower.snap();
  }

  const goToEntry = (entry) => (entry.index >= 0 ? goToSentence(entry.index) : Promise.resolve(scrollOnly(entry.page)));

  function goToPage(page) {
    const idx = state.get().sentences.findIndex((s) => s.page === page);
    return idx >= 0 ? goToSentence(idx) : Promise.resolve(scrollOnly(page));
  }

  function refresh(s) {
    labels = choosePageLabels({ pdfLabels: fromPdf.labels, marks: s.pageMarks, numPages: s.numPages });
    ui.setPageLabels(labels);
    toc = buildToc({ outline: fromPdf.outline, sections: s.sections, sentences: s.sentences });
    panel.render(toc);
    state.set({ tocEntries: toc.entries });
    panel.markCurrent(currentEntry(toc.entries, s.index));
  }

  async function readPdf() {
    const asked = generation;
    const doc = pdfView.pdfDocument?.();
    const [pdfLabels, outline] = await Promise.all([pdfPageLabels(doc), outlineFromPdf(doc)]);
    if (asked !== generation) return;
    fromPdf = Object.freeze({ labels: pdfLabels, outline });
    refresh(state.get());
  }

  state.subscribe((s) => {
    const was = prev;
    prev = s;
    if (s.docId !== was.docId) {
      generation += 1;
      fromPdf = Object.freeze({ labels: null, outline: [] });
      refresh(s);
      if (s.docId) readPdf();
      return;
    }
    const changed = ['numPages', 'sentences', 'sections', 'pageMarks'].some((k) => s[k] !== was[k]);
    if (changed) refresh(s);
    else if (s.index !== was.index) panel.markCurrent(currentEntry(toc.entries, s.index));
  });

  bindPageGo({ ui, pages: () => ({ labels, numPages: state.get().numPages }), goToPage });
  return { goToEntry, goToPage };
}

/** The page pill opens a one-field form: a printed number ("11", "xii") or an index ("#23"). */
function bindPageGo({ ui, pages, goToPage }) {
  const pill = ui.el('page-pill');
  const form = ui.el('page-go');
  const input = ui.el('page-go-input');
  const view = ui.el('view-status');
  if (!pill || !form || !input) return;

  const close = ({ refocus }) => {
    form.hidden = true;
    view?.classList.remove(GOING_CLASS);
    pill.setAttribute('aria-expanded', 'false');
    if (refocus) pill.focus();
  };
  pill.setAttribute('aria-expanded', 'false');
  pill.addEventListener('click', () => {
    form.hidden = false;
    view?.classList.add(GOING_CLASS);
    pill.setAttribute('aria-expanded', 'true');
    input.value = '';
    input.removeAttribute('aria-invalid');
    input.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { labels, numPages } = pages();
    const page = resolvePageInput(input.value, labels, numPages);
    if (page < 0) {
      input.setAttribute('aria-invalid', 'true');
      ui.toast(`This paper has no page “${input.value.trim()}”.`, 'warn');
      return;
    }
    close({ refocus: true });
    goToPage(page);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close({ refocus: true });
  });
  input.addEventListener('blur', () => { if (!form.hidden) close({ refocus: false }); });
}

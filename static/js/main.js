// ── Bootstrap ────────────────────────────────────────────────────────────────
// Wires the independent modules together. This is the only file that knows
// about all of them; each module below it is dependency-free and testable alone.

import * as api from './api.js';
import * as state from './state.js';
import * as ui from './ui.js';
import { createTtsClient } from './ttsclient.js';
import { shapeParams } from './voiceshape.js';
import { createVoiceFx, fxOf } from './voicefx.js';
import { createPlayer, PRELOAD_AHEAD } from './playback.js';
import { createPdfView } from './pdfview.js';
import { createHighlighter } from './highlights.js';
import { createNotesPanel } from './notes.js';
import { createNotesEditor } from './noteseditor.js';
import { parseBlocks } from './blocks.js';
import { anchorFromHighlight, sectionsFromScript, VIEW_MARGIN } from './anchors.js';
import { createMarginLayout, readingAnchor } from './marginnotes.js';
import { createSubsPanel } from './subspanel.js';
import { samePayload, toPayload } from './subs.js';
import { createNoteSync, recordPayload } from './notesync.js';
import { buildScriptBatched } from './scriptbuild.js';
import { createReadMenu, targetFromNode } from './readmenu.js';
import * as layout from './layout.js';
import { createZoom } from './zoom.js';
import { createFollow } from './follow.js';
import { createFollowSwitch } from './followswitch.js';
import { createLoadGate } from './loadgate.js';
import { isAnnounced, isResting, remapIndex } from './transportrules.js';
import { ttsVoice, fallBackToKokoro } from './engineswitch.js';
import { createTransport } from './transport.js';
import { createSettings } from './settings.js';
import { createNotesExport } from './notesexport.js';
import { createFileOpen } from './fileopen.js';
import { listenLog } from './listenlog.js';
import { createBufferBar } from './bufferbar.js';
import { createNav } from './nav.js';
import { createMediaKeys } from './mediakeys.js';
import { createEtaStatus } from './etastatus.js';
import { createSummaryPanel } from './summarypanel.js';
import { spansOf } from './spans.js';
import { resumeIndex } from './resume.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdf.worker.min.js';

const SAVE_DEBOUNCE_MS = 600;
const POSITION_SAVE_EVERY = 5;   // sentences
/** Coalesces a burst of Subs edits (say, three quick deletes) into one rebuild. */
const SUBS_REBUILD_DEBOUNCE_MS = 400;
// A pinch fires a wheel event per frame; persisting the level on each one is a JSON
// serialise plus a synchronous localStorage write inside the gesture. Save once it stops.
const ZOOM_SAVE_DEBOUNCE_MS = 400;
/** Follow and its rail twin light up while following is suspended: the one sign the page stopped moving, and the fix. */
const ATTENTION_IDS = ['followBtn', 'railFollowBtn'];
/** R7: the highlights list mounts wherever an element with this id lives (L2: the right bar). */
const HIGHLIGHTS_ROOT_ID = 'notes-panel';

let pdfView = null;
let player = null;
let tts = null;
let highlighter = null;
let notesPanel = null;
let notesEditor = null;
/** The highlight "/quote current highlight" cites when one was explicitly chosen. */
let activeHighlightId = null;
let fitWidth = null;
let zoomControl = null;
let marginLayout = null;
let follower = null;
let panels = null;
let transport = null;
let mediaKeys = null;
let summaryPanel = null;
let building = false;
let builtSubs = state.get().subs;   // what the current queue was built with
let subsTimer = null;
let zoomSaveTimer = null;
const loadGate = createLoadGate();
/** Settles when the previous load or rebuild has; they run one at a time so pdfView holds one paper. */
let loadTail = Promise.resolve();

// Module-scope so it exists before any load path can run: `loadNow` calls
// `noteSync.reset()` before it reads anything.
const noteSync = createNoteSync({
  debounceMs: SAVE_DEBOUNCE_MS,
  getState: () => state.get(),
  // One payload builder for every writer (editor, highlights, position, options):
  // a whole-record PUT built from stale data is how fields erase each other (T7).
  write: (s) => api.saveNotes(s.docId, recordPayload(s)),
  onStatus: (kind) => notesEditor?.setStatus(kind),
  onError: (err) => {
    console.warn('could not save notes', err);
    ui.toast('Could not save your notes to disk.', 'warn');
  },
});
const fileOpen = createFileOpen({ api, ui, onOpen: loadDocument });
const voicefx = createVoiceFx();
const settings = createSettings({ api, state, ui, clearAudio: () => tts.clear(), applyFx: () => voicefx.apply(fxOf(state.get())) });
/** V1: the voice personalisation every player shares — Kokoro's shape and the effects chain. */
const personal = Object.freeze({ shapeOf: () => shapeParams(state.get()), onAudioElement: (el) => voicefx.track(el) });
const notesExport = createNotesExport({ api, state, ui });

// ── Document loading ─────────────────────────────────────────────────────────

/** Run `task` once every earlier load and rebuild has settled. */
function enqueue(task) {
  const run = loadTail.then(task);
  loadTail = run.catch(() => {});
  return run;
}

/**
 * Opening a paper supersedes any load or rebuild still in flight (A2): its script build
 * is aborted, the rest stops at its next await, and this one starts once it has, so the
 * two never share pdfView's document.
 */
function loadDocument(bytes, name) {
  const isCurrent = loadGate.begin();
  return enqueue(() => (isCurrent() ? loadNow(bytes, name, isCurrent) : undefined));
}

async function loadNow(bytes, name, isCurrent) {
  state.set({ loading: true });
  // Write the outgoing paper's pending edits while its state is still live...
  await persist();
  if (!isCurrent()) return;
  // ...then cancel any save still pending for it: it would fire with the new
  // doc_id and the reset (empty) highlight list, erasing the new file.
  noteSync.reset();
  player?.stop();
  tts?.clear();
  state.resetDocument();
  follower.restore();
  activeHighlightId = null;
  notesEditor.setEnabled(false);   // nothing to type into until its notes are read
  notesEditor.setSections([]);
  notesEditor.setStatus('idle');
  ui.setControlsEnabled(false);
  zoomControl.refresh();          // nothing to zoom until the new paper is laid out
  ui.hideWelcome(true);

  try {
    const { numPages, docId } = await pdfView.load(bytes, name);
    if (!isCurrent()) return;
    state.set({ docId, docName: name, numPages });
    ui.setDocName(name, true);
    ui.setPagePill(1, numPages);
    zoomControl.refresh();
    await fitWidth.fitNow();
    if (!isCurrent()) return;

    if (!(await buildScript(isCurrent))) return;
    await loadNotesFor(docId, isCurrent);
  } catch (err) {
    if (!isCurrent()) return;   // a newer paper tore this one down mid-load
    console.error(err);
    ui.setStatus(`Failed to load "${name}": ${err.message}`, 'error');
    ui.hideWelcome(false);
  } finally {
    if (isCurrent()) state.set({ loading: false });
  }
}

/**
 * Build the script, then catch up with any substitution edited while it ran.
 * @param {(() => boolean) & {signal: AbortSignal}} isCurrent a load-gate token
 * @returns {Promise<{sentences: object[], index: number}|null>} the script and cursor it
 *   replaced, or null when the build was abandoned for a newer paper
 */
async function buildScript(isCurrent) {
  building = true;
  builtSubs = state.get().subs;
  try {
    return await buildScriptNow(isCurrent);
  } finally {
    // Loads and rebuilds run one at a time, so no other build owns the flag yet.
    building = false;
    if (isCurrent() && !samePayload(builtSubs, state.get().subs)) scheduleSubsRebuild();
  }
}

/** Extract geometry, ask the server for a speakable script, populate the queue. */
async function buildScriptNow(isCurrent) {
  const s = state.get();
  ui.setStatus('Reading the document layout…', 'loading');

  // A newer paper aborts this between pages; the rejection ends a superseded load quietly.
  const { pages, stats } = await pdfView.extractGeometry({ signal: isCurrent.signal });
  if (!isCurrent()) return null;

  ui.setStatus(
    s.options.use_llm ? 'Building the script with the local model…' : 'Building the script…',
    'loading',
  );

  // Batched, because the server refuses more than 80 pages per request: a whole
  // book in one POST took a 400 and fell through to `fallbackScript` (H1).
  let result;
  try {
    result = await buildScriptBatched({
      docId: s.docId || '',
      stats,
      pages,
      options: { ...s.options, substitutions: toPayload(s.subs) },
      post: api.buildScript,
      signal: isCurrent.signal,
      onProgress: ({ done, total }) =>
        isCurrent() && ui.setStatus(`Building the script — page ${done} of ${total}…`, 'loading'),
    });
  } catch (err) {
    if (!isCurrent()) return null;   // aborted for a newer paper: not a failure to report
    console.error('script build failed', err);
    ui.toast('Script build failed — falling back to plain text order.', 'warn');
    result = fallbackScript(pages);
  }
  if (!isCurrent()) return null;

  // A batch that failed cost its pages, not the document. Say so rather than
  // letting the gap look like a classifier that silently skipped a chapter.
  if (result.failures?.length) {
    const ranges = result.failures.map((f) => `${f.from}–${f.to}`).join(', ');
    ui.toast(`${result.stats.failed_pages} pages could not be analysed (${ranges}).`, 'warn');
  }

  const sentences = result.sentences || [];
  // The section view files notes under the paper's own headings, which is what the
  // script already knows: join them to the geometry before it goes out of scope.
  const sections = sectionsFromScript(sentences, pages);
  const replaced = { sentences: state.get().sentences, index: state.get().index };
  state.set({ sentences, scriptStats: result.stats || null, sections, pageMarks: result.marks || [] });
  notesEditor.setSections(sections);

  ui.setControlsEnabled(sentences.length > 0);

  if (!sentences.length) {
    ui.setStatus('No readable text found — this PDF may be a scan.', 'warn');
    return replaced;
  }
  ui.setStatus(`Ready — ${sentences.length} sentences across ${state.get().numPages} pages`);
  return replaced;
}

/**
 * Last-resort client-side script: read every line in order. Ugly, but a server
 * error must never leave the user with a document they cannot play at all.
 */
function fallbackScript(pages) {
  const sentences = [];
  for (const page of pages) {
    for (const line of page.lines || []) {
      const text = (line.text || '').trim();
      if (text.length > 12) {
        sentences.push({ text, raw: text, page: page.page, kind: 'body', items: line.items || [] });
      }
    }
  }
  return { sentences, stats: null };
}

// ── Notes & highlights ───────────────────────────────────────────────────────

async function loadNotesFor(docId, isCurrent) {
  let record;
  try {
    record = await api.loadNotes(docId);
  } catch (err) {
    if (!isCurrent()) return;
    // Read failed, so we do not know what is on disk. Leave the document unbound:
    // every later save is refused rather than overwriting good notes with nothing.
    console.warn('could not load notes', err);
    ui.toast(
      'Could not read your saved notes for this document. Saving is off until you reopen it, ' +
      'so nothing on disk will be overwritten.',
      'warn',
    );
    notesEditor.setStatus('error');
    return;
  }
  if (!isCurrent()) return;   // binding now would tie this paper's id to another's state

  const highlights = record.highlights || [];
  state.set({ highlights });
  highlighter.setHighlights(highlights);
  notesPanel?.setHighlights(highlights);

  notesEditor.setEnabled(true);
  notesEditor.setBlocks(parseBlocks(record.blocks));
  state.set({ blocks: notesEditor.blocks() });
  notesEditor.setStatus('idle');

  noteSync.bind(docId);   // only now is it safe to write this document back

  const resumeAt = resumeIndex(state.get().sentences, record);   // N4: the same sentence, not the same number
  if (resumeAt > 0) {
    player.setIndex(resumeAt);
    follower.restore(state.get().sentences[state.get().index]?.page, isCurrent);
    ui.toast(`Resuming at sentence ${resumeAt + 1}.`);
  }
}

function onHighlightsChanged(highlights) {
  state.set({ highlights });
  notesPanel?.setHighlights(highlights);
  scheduleSave();
}

/** What "/quote current highlight" cites: the chosen one, else the most recent. */
function currentHighlight() {
  const list = state.get().highlights || [];
  const stamp = (h) => h.updated_at || h.created_at || '';
  return list.find((h) => h.id === activeHighlightId)
    || list.reduce((newest, h) => (!newest || stamp(h) >= stamp(newest) ? h : newest), null);
}

/**
 * Where a note written right now belongs (D1): beside the highlight the reader just
 * made or clicked, and otherwise beside what they are reading. A highlight left behind
 * on another page is not what this note is about, so the reading position wins there.
 */
function noteAnchor() {
  const reading = readingAnchor(ui.el('content-area'), pdfView);
  const recent = highlighter?.recent?.();
  if (recent && (!reading || recent.page === reading.page)) return anchorFromHighlight(recent);
  return reading;
}

function onEditorChange(blocks) {
  state.set({ blocks });
  scheduleSave();
}

function scheduleSave() {
  noteSync.schedule();
}

function persist() {
  return noteSync.flush();
}

// ── Player callbacks ─────────────────────────────────────────────────────────

/** Whether the voice is reading (or fetching the sentence it is about to read). */
function isReading() {
  const { isPlaying, isLoading } = player?.state() ?? {};
  return Boolean(isPlaying || isLoading);
}

function onIndex(idx, sentence) {
  state.set({ index: idx });
  if (sentence) {
    pdfView.highlightSpans(spansOf(sentence));   // N4: both pages of a sentence over a page turn
    ui.setPagePill(sentence.page, state.get().numPages);
    if (isReading()) follower.follow();   // setIndex moves the cursor, not the view
  }
  if (idx % POSITION_SAVE_EVERY === 0) scheduleSave();
}

function onStatus({ state: phase, message, level }) {
  ui.setPlayIcon(phase === 'playing');
  mediaKeys?.sync(phase);
  if (phase === 'loading' || phase === 'playing') summaryPanel?.pause();   // never two voices at once
  ui.setStatus(message, level || (phase === 'loading' ? 'loading' : 'info'),
    { announce: isAnnounced({ state: phase, level }) });
  // A pause is where a quit usually follows: the every-Nth-sentence save alone loses up to N-1.
  if (isResting(phase)) scheduleSave();
  const recover = ui.el('recoverBtn');
  if (recover) recover.classList.toggle('attention', phase === 'recovering');
  if (level === 'warn') ui.toast(message, 'warn');
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

/**
 * Rebuild the open paper's script, queued behind any load or rebuild in flight.
 * @param {() => boolean} [isNeeded] re-asked when its turn comes; false skips it
 */
function rebuild(isNeeded = () => true) {
  // Joins the open paper's generation; a paper opened meanwhile makes this stale.
  const isCurrent = loadGate.current();
  return enqueue(() => (isCurrent() && isNeeded() ? rebuildNow(isCurrent) : undefined));
}

async function rebuildNow(isCurrent) {
  if (!state.get().docId) return;
  player.stop();
  tts.clear();
  const replaced = await buildScript(isCurrent);
  if (!replaced) return;
  // The new script numbers its sentences differently: keep the place the reader is at
  // as it lands, not the number, nor where it stood when the build began (A4).
  const at = remapIndex(replaced.sentences, replaced.index, state.get().sentences);
  if (at < 0) return;
  player.setIndex(at);
  scheduleSave();
}

// ── Substitutions (T6) ───────────────────────────────────────────────────────

function onSubsChange(rows) {
  state.set({ subs: rows });
  state.savePrefs();
  scheduleSubsRebuild();
}

function scheduleSubsRebuild() {
  clearTimeout(subsTimer);
  subsTimer = setTimeout(() => {
    // A build in flight re-checks when it ends; without a document there is nothing to redo.
    const isStale = () => !samePayload(builtSubs, state.get().subs);
    if (building || !state.get().docId || !isStale()) return;
    rebuild(isStale);   // a load queued ahead of it may build these subs first
  }, SUBS_REBUILD_DEBOUNCE_MS);
}

// ── Panel collapse ───────────────────────────────────────────────────────────

function bindLayout() {
  panels = layout.createPanels({ state });   // folds both in a narrow window (N13)
  ui.el('collapseBtn').addEventListener('click', () => panels.setSidebarCollapsed(true));
  const notesToggle = ui.el('notesToggleBtn');
  // The press must not take the caret out of the editor before the collapse can see where it
  // was: Safari gives a clicked button no focus and blurs the editor anyway, Chrome focuses
  // the button. Neither is the answer here — the panels (layout.js) decide where focus lands.
  notesToggle.addEventListener('mousedown', (e) => e.preventDefault());
  notesToggle.addEventListener('click', () => panels.toggleNotes());
  layout.bindRail({
    onExpand: () => panels.setSidebarCollapsed(false),
    getSpeed: () => state.get().speed,
  });
  const scroller = ui.el('content-area');
  fitWidth = layout.createFitWidth({
    scroller,
    pdfView,
    maxScale: pdfView.scale(),
    getZoom: () => state.get().zoom,
  });
  marginLayout = createMarginLayout({
    docEl: notesEditor.doc,
    scroller,
    pages: ui.el('pdf-pages'),
    pdfView,
    // The editor's own view: it places the notes as it renders, before it reports the switch.
    isMargin: () => notesEditor.view() === VIEW_MARGIN,
  });
  zoomControl = createZoom({
    scroller,
    getZoom: () => state.get().zoom,
    hasDocument: () => state.get().numPages > 0,
    onZoom: (zoom, anchor) => {
      state.set({ zoom });
      clearTimeout(zoomSaveTimer);
      zoomSaveTimer = setTimeout(state.savePrefs, ZOOM_SAVE_DEBOUNCE_MS);
      fitWidth.zoomTo(anchor);
    },
  });
}

/** R7: the highlights list, or null when the page has no element to hold it (the list is optional chrome). */
function mountHighlightsPanel(root) {
  if (!root) return null;
  return createNotesPanel({
    root,
    collapsed: state.get().highlightsCollapsed,
    onToggle: (collapsed) => { state.set({ highlightsCollapsed: collapsed }); state.savePrefs(); },
    onJump: (h) => {
      activeHighlightId = h.id;
      follower.suspend();   // the reader went to look at a note; the next sentence must not pull them back
      highlighter.focus(h.id);
      pdfView.scrollToPage(h.page);
    },
    onUpdate: (id, patch) => highlighter.update(id, patch),
    onDelete: (id) => highlighter.remove(id),
    onExport: (format) => notesExport.exportNotes(format),
  });
}

function init() {
  state.loadPrefs();
  const s = state.get();

  ui.initTabs();
  settings.applyPrefs();

  pdfView = createPdfView({
    container: ui.el('pdf-pages'),
    onPageChange: (n) => ui.setPagePill(n, state.get().numPages),
    onProgress: ({ done, total, phase }) =>
      ui.setStatus(`${phase} — page ${done} of ${total}…`, 'loading'),
  });

  follower = createFollow({
    scroller: ui.el('content-area'),
    pdfView,
    notes: ui.el('notes-column'),
    isMargin: () => notesEditor.view() === VIEW_MARGIN,
    onChange: (active) => {
      ATTENTION_IDS.forEach((id) => ui.el(id)?.classList.toggle('attention', !active));
      const pill = ui.el('follow-pill');
      if (pill) pill.hidden = active || !isReading();   // F1: say so while the voice reads on unseen
    },
    isEnabled: () => state.get().followEnabled,
    isSmooth: () => state.get().smoothScroll,
    isPlaying: isReading,
  });
  const followSwitch = createFollowSwitch({ state, ui, follower });
  ui.el('follow-pill')?.addEventListener('click', followSwitch.toggle);

  tts = createTtsClient({ endpoint: '/api/tts', shapeOf: personal.shapeOf });
  // R6: macOS removed the Siri voice — read on in Kokoro rather than skip every sentence.
  const onVoiceUnavailable = () => fallBackToKokoro({ state, ui, onSwitch: () => tts.clear() });

  const eta = createEtaStatus({ root: ui.el('eta-pill'), state });
  player = createPlayer({
    tts,
    getSentences: () => state.get().sentences,
    getVoice: () => ttsVoice(state.get()),
    getSpeed: () => state.get().speed,
    onVoiceUnavailable,
    onAudioElement: personal.onAudioElement,
    onIndex,
    onStatus,
    onListen: (ev) => { listenLog().add(ev); eta.listen(ev); },
    onEnded: () => {
      ui.setStatus('Finished reading the document ✓');
      persist();
    },
  });

  createBufferBar({ root: ui.el('bufferbar'), tts, health: api.health, ahead: PRELOAD_AHEAD, state, voiceOf: ttsVoice,
    ring: ui.el('railPpBtn') });

  transport = createTransport({
    player,
    follower,
    state,
    ui,
    onRebuild: () => rebuild(),
    toggleSidebar: () => panels.toggleSidebar(),
    toggleNotes: () => panels.toggleNotes(),
    toggleFollow: followSwitch.toggle,
    hasActiveHighlight: () => highlighter?.hasActive(),
  });
  createNav({ state, ui, pdfView, player, follower, jumpTo: transport.jumpTo });
  mediaKeys = createMediaKeys({ actions: transport.mediaActions, state });

  highlighter = createHighlighter({
    pdfView,
    onChange: onHighlightsChanged,
    onReadFrom: (page, _text, _rect, startNode) =>
      transport.readFrom(targetFromNode(startNode, pdfView) || { page, item: null }),
  });
  highlighter.attach();
  createReadMenu({ pdfView, onRead: transport.readFrom }).attach();

  notesEditor = createNotesEditor({
    root: ui.el('notes-column'),
    onChange: onEditorChange,
    getHighlight: currentHighlight,
    getAnchor: noteAnchor,
    onViewChange: (view) => { state.set({ notesView: view }); state.savePrefs(); },
    onRender: () => marginLayout?.now(),
    onNotify: (message, level) => ui.toast(message, level),
  });
  notesEditor.setView(s.notesView);
  notesEditor.setEnabled(false);
  notesEditor.setStatus('idle');

  notesPanel = mountHighlightsPanel(ui.el(HIGHLIGHTS_ROOT_ID));

  createSubsPanel({ root: ui.el('tab-subs'), subs: s.subs, onChange: onSubsChange });
  summaryPanel = createSummaryPanel({ root: ui.el('tab-summary'), state, post: api.summarize, mainPlayer: player, voiceOf: ttsVoice, onVoiceUnavailable, viewedPage: () => pdfView.currentPage(), personal });

  fileOpen.blockStrayDrops();
  bindLayout();
  fileOpen.bindDropZone();
  transport.bindButtons();
  settings.bind();
  transport.bindKeys();
  settings.probeLlm();
  settings.loadVoices();

  window.addEventListener('beforeunload', persist);
}

// Expose a handle for debugging in the pywebview console; harmless in production.
window.kokoro = { state, voicefx, get player() { return player; }, get tts() { return tts; }, get pdfView() { return pdfView; } };

init();

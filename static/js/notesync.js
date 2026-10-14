// ── Note persistence gate ────────────────────────────────────────────────────
// One job: make it impossible to write a notes file we did not first read.
//
// Two reproduced data-loss bugs motivate every line here:
//
//   1. A debounced save armed while document A was open fired after document B
//      had loaded. The writer read live state at fire time, so it PUT B's id
//      with A's (already reset) empty highlight list, silently destroying B.
//   2. A transient GET failure left highlights empty. Pressing Play scheduled a
//      position save, which wrote that empty list over the good file on disk.
//
// Both are the same mistake: writing on behalf of a document whose notes were
// never loaded. `bind` is called only after a successful read, and `flush`
// refuses to write unless the live document still matches what was bound.
//
// T7 adds a third: a PUT replaces the whole record, so two writers holding
// separate copies of it (the notes editor and the resume-position save) would
// each erase the other's field. `recordPayload` is the fix — every writer goes
// through it and it reads *live* state, so there is only ever one copy.

import { serializeBlocks } from './blocks.js';
import { resumeMark } from './resume.js';

/**
 * The whole record, built from live state at write time.
 * @param {object} s app state
 */
export function recordPayload(s) {
    return {
        doc_id: s.docId,
        title: s.docName,
        highlights: s.highlights,
        last_index: s.index,
        last_sentence: resumeMark(s.sentences?.[s.index]),   // N4: survives a renumbering rebuild
        options: s.options,
        blocks: serializeBlocks(s.blocks),
    };
}

/**
 * @param {object}   deps
 * @param {(state:object) => Promise<void>} deps.write      performs the PUT
 * @param {() => object}                    deps.getState   live app state (must expose `docId`)
 * @param {(err:Error) => void}            [deps.onError]   called when `write` rejects
 * @param {(kind:'saving'|'saved'|'error') => void} [deps.onStatus]  for the visible save state
 * @param {number}                         [deps.debounceMs]
 * @param {typeof setTimeout}              [deps.setTimer]  injectable for tests
 * @param {typeof clearTimeout}            [deps.clearTimer]
 */
export function createNoteSync({
    write,
    getState,
    onError = () => {},
    onStatus = () => {},
    debounceMs = 600,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    if (typeof write !== 'function') throw new TypeError('createNoteSync: write must be a function');
    if (typeof getState !== 'function') throw new TypeError('createNoteSync: getState must be a function');

    let timer = null;
    let boundId = null;

    /** Forget the current document and cancel any pending write. Call before every load. */
    function reset() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        boundId = null;
    }

    /** Declare that this document's notes are safely in memory and may be written back. */
    function bind(docId) {
        boundId = typeof docId === 'string' && docId ? docId : null;
    }

    /** Debounce a write. A no-op in effect while nothing is bound -- `flush` still guards. */
    function schedule() {
        if (timer !== null) clearTimer(timer);
        if (boundId !== null) onStatus('saving');
        timer = setTimer(() => {
            timer = null;
            void flush();
        }, debounceMs);
    }

    /**
     * Write now if and only if the live document is the one we loaded notes for.
     * @returns {Promise<boolean>} true when bytes were actually written
     */
    async function flush() {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
        const s = getState();
        if (!s || !s.docId || s.docId !== boundId) return false;
        try {
            onStatus('saving');
            await write(s);
            onStatus('saved');
            return true;
        } catch (err) {
            onStatus('error');
            onError(err);
            return false;
        }
    }

    /** @returns {string|null} the document currently safe to write, for tests and asserts. */
    function boundDocId() {
        return boundId;
    }

    return { reset, bind, schedule, flush, boundDocId };
}

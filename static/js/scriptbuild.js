/**
 * scriptbuild.js — send page geometry to `/api/script/build` in server-sized
 * batches and merge the responses back into one script.
 *
 * `kokoro_reader/routes/script.py` refuses more than `MAX_PAGES_PER_REQUEST = 80`
 * pages in a single POST, so a whole book took a 400 and fell through to the
 * naive fallback splitter in `main.js` — the exact defect this project exists to
 * fix, on exactly the documents that need it most.
 *
 * Batching is only equivalent to one big request while every batch is classified
 * against the SAME document-wide `stats`: the repeated-line set, the modal body
 * size and the bibliography span are all whole-document geometry. Measured over a
 * synthetic 203-page document with the real pipeline, whole-document and
 * 60-page-batched runs produce identical sentences and blocks.
 *
 * N4 joins a sentence over a page turn, so a batch seam could cut one. Each batch is
 * sent with its neighbours as read-only context and `own_from`/`own_to`; the server
 * builds them all and returns only sentences that start on the owned pages, so a seam
 * sentence is built once, whole, by the batch it starts in, exactly as in one build.
 *
 * Imports nothing; the HTTP call arrives as the `post` option, so this unit-tests
 * in plain Node with no fetch and no DOM.
 */

/** Pages per request. Below the server's 80 so a future page-splitting change has headroom. */
export const MAX_PAGES_PER_BATCH = 60;

/**
 * N4 context pages either side of a batch. A join spans at most two pages, but whether the
 * page before a batch ends on a sentence still free to join depends on the page before
 * that, hence two before and one after.
 */
export const CONTEXT_PAGES_BEFORE = 2;
export const CONTEXT_PAGES_AFTER = 1;

/** Margin kinds that can print a page number (N8): kept, as `{page, text, kind}`, for pagelabels.js. */
const MARK_KINDS = new Set(['pagenum', 'header', 'footer']);
/** A running header is short; a paragraph mislabelled as a footer is cut to this. */
export const MAX_MARK_CHARS = 120;

/** The page-number-bearing margin lines of one response, and nothing else of its blocks. */
const marksOf = (blocks) => (blocks || [])
    .filter((b) => MARK_KINDS.has(b?.kind))
    .map((b) => ({ page: b.page, text: String(b.text || '').trim().slice(0, MAX_MARK_CHARS), kind: b.kind }));

const zeroReport = () => ({ blocks: 0, sentences: 0, skipped: {}, skipped_total: 0, llm_used: 0 });

const count = (v) => (Number.isFinite(v) ? v : 0);

/** Sum two skip-counter maps into a new object. */
function mergeCounts(a, b) {
    const out = { ...a };
    for (const [kind, n] of Object.entries(b || {})) out[kind] = count(out[kind]) + count(n);
    return out;
}

/**
 * Split pages into consecutive batches of at most `size`. Pure; the batches are
 * new arrays, so no caller can reach the input through them.
 * @param {object[]} pages @param {number} [size] @returns {object[][]}
 */
export function batchPages(pages, size = MAX_PAGES_PER_BATCH) {
    const list = Array.isArray(pages) ? pages : [];
    const step = Math.max(1, Math.floor(size) || MAX_PAGES_PER_BATCH);
    const out = [];
    for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
    return out;
}

/**
 * Fold per-batch `stats` reports into one document-wide report.
 * @param {Array<object|null>} reports @returns {object}
 */
export function mergeReports(reports) {
    return (reports || []).reduce((acc, r) => (r ? {
        blocks: acc.blocks + count(r.blocks),
        sentences: acc.sentences + count(r.sentences),
        skipped: mergeCounts(acc.skipped, r.skipped),
        skipped_total: acc.skipped_total + count(r.skipped_total),
        llm_used: acc.llm_used + count(r.llm_used),
    } : acc), zeroReport());
}

/** First/last page number of a batch, falling back to its ordinal position. */
function span(batch, offset) {
    const first = Number(batch[0]?.page);
    const last = Number(batch[batch.length - 1]?.page);
    return {
        from: Number.isFinite(first) ? first : offset + 1,
        to: Number.isFinite(last) ? last : offset + batch.length,
    };
}

const isPage = (n) => Number.isInteger(n) && n >= 1;

/**
 * The pages to POST for the batch at `offset`, and the page range it owns (N4). Pages
 * without real numbers cannot name a range, so they are sent bare, as before.
 * @returns {{pages:object[], own:{from:number, to:number}|null}}
 */
function requestFor(pages, batch, offset) {
    const from = batch[0]?.page;
    const to = batch[batch.length - 1]?.page;
    if (!isPage(from) || !isPage(to)) return { pages: batch, own: null };
    const start = Math.max(0, offset - CONTEXT_PAGES_BEFORE);
    return { pages: pages.slice(start, offset + batch.length + CONTEXT_PAGES_AFTER), own: { from, to } };
}

/** Does `page` belong to the owned range? Also guards against a server that ignores it. */
const isOwned = (own, page) => !own || (page >= own.from && page <= own.to);

/** `promise`, or a rejection with the signal's reason as soon as it aborts. */
function untilAborted(promise, signal) {
    if (!signal) return promise;
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/**
 * Build the whole script by POSTing the document one batch of pages at a time.
 *
 * Batches are sent sequentially: the server classifies on its threadpool and has
 * no work budget yet (M10), so parallel batches would only queue against each
 * other while making progress non-monotonic.
 *
 * A failed batch is recorded and skipped — the pages that did build are kept, in
 * page order, with a hole where the failure was. Only a document where *every*
 * batch failed rejects, which is what sends `main.js` to its fallback splitter.
 *
 * @param {object}   opts
 * @param {string}   opts.docId
 * @param {object[]} opts.pages   document-wide page geometry, in page order
 * @param {object}   opts.stats   document-wide DocStats, sent unchanged with every batch
 * @param {object}   opts.options read options
 * @param {(payload:object)=>Promise<object>} opts.post  the `/api/script/build` call
 * @param {(p:{done:number,total:number,batch:number,batches:number})=>void} [opts.onProgress]
 * @param {number}   [opts.batchSize]
 * @param {AbortSignal} [opts.signal] aborting rejects at once with an AbortError and
 *   posts no further batch; it is also passed to `post` as `{ signal }`
 * @returns {Promise<{doc_id:string, sentences:object[], stats:object, failures:object[],
 *   marks:Array<{page:number, text:string, kind:string}>}>}
 */
export async function buildScriptBatched({
    docId = '', pages, stats, options, post,
    onProgress = () => {}, batchSize = MAX_PAGES_PER_BATCH, signal,
} = {}) {
    if (typeof post !== 'function') throw new TypeError('buildScriptBatched: post is required');
    const all = Array.isArray(pages) ? pages : [];
    const batches = batchPages(all, batchSize);
    if (!batches.length) throw new Error('buildScriptBatched: no pages to build');

    const sentences = [];
    const marks = [];
    const reports = [];
    const failures = [];
    const total = batches.reduce((n, b) => n + b.length, 0);
    let done = 0;
    let offset = 0;

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const { from, to } = span(batch, offset);
        signal?.throwIfAborted();
        try {
            const req = requestFor(all, batch, offset);
            const owned = req.own ? { own_from: req.own.from, own_to: req.own.to } : {};
            const payload = { doc_id: docId, stats, pages: req.pages, options, ...owned };
            const res = await untilAborted(post(payload, { signal }), signal);
            // `blocks` is deliberately not accumulated: nothing renders it (M12),
            // and on a 400-page book it is the largest thing in the response.
            // Only its margin lines are, trimmed: they carry the printed page numbers (N8).
            for (const sentence of res?.sentences || []) if (isOwned(req.own, sentence?.page)) sentences.push(sentence);
            for (const mark of marksOf(res?.blocks)) if (isOwned(req.own, mark.page)) marks.push(mark);
            reports.push(res?.stats || null);
        } catch (err) {
            if (signal?.aborted) throw signal.reason;
            failures.push({ from, to, pages: batch.length, message: err?.message || String(err) });
            console.warn(`[scriptbuild] pages ${from}–${to} failed:`, err);
        }
        done += batch.length;
        offset += batch.length;
        try {
            onProgress({ done, total, batch: i + 1, batches: batches.length });
        } catch (err) {
            console.warn('[scriptbuild] onProgress', err);
        }
    }

    if (failures.length === batches.length) {
        throw new Error(
            `Script build failed for all ${batches.length} page batches: ${failures[0].message}`,
        );
    }

    return {
        doc_id: docId,
        sentences,
        stats: {
            ...mergeReports(reports),
            failed_batches: failures.length,
            failed_pages: failures.reduce((n, f) => n + f.pages, 0),
        },
        failures,
        marks,
    };
}

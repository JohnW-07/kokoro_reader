// Harness for H1: page batching for /api/script/build.
//
// The server refuses more than MAX_PAGES_PER_REQUEST = 80 pages in one POST
// (kokoro_reader/routes/script.py). Reproduced against the real route:
//     81 pages -> 400 {'detail': 'Too many pages in one request (max 80)'}
// main.js POSTed the whole document, so every book/thesis took the 400 and fell
// through to the naive fallback splitter in main.js.
//
// The server pipeline is per-page pure given document-wide DocStats — measured
// with kokoro_reader.textpipe.pipeline over a synthetic 203-page document:
// whole-document and 60-page-batched runs produced byte-identical sentences
// (198) and blocks (797). So batching is only correct while every batch is sent
// the SAME document-wide stats; the tests below pin that.
//
// No DOM, no fetch: the fake server below emulates the route's contract.

import {
    MAX_MARK_CHARS,
    MAX_PAGES_PER_BATCH, batchPages, mergeReports, buildScriptBatched,
    CONTEXT_PAGES_BEFORE, CONTEXT_PAGES_AFTER,
} from '../../static/js/scriptbuild.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Fixtures ──────────────────────────────────────────────────────────────────
const N_PAGES = 203;
const SERVER_MAX_PAGES = 80;            // routes/script.py MAX_PAGES_PER_REQUEST
const REFERENCE_PAGE = 199;

/** Three body lines plus a running head, with per-page item indices. */
function makePage(n) {
    const lines = [
        { idx: 0, text: '# Preprint. Under review.', items: [0, 1, 2] },
        { idx: 1, text: `Page ${n} opens with a claim about estimators`, items: [3, 4, 5] },
        { idx: 2, text: `Page ${n} then supports it with a measurement`, items: [6, 7, 8] },
    ];
    return { page: n, width: 612, height: 792, lines };
}

const PAGES = Object.freeze(Array.from({ length: N_PAGES }, (_, i) => makePage(i + 1)));
const STATS = Object.freeze({
    body_size: 9.9, num_pages: N_PAGES, repeated: ['preprint under review'],
    repeated_y: [], reference_page: REFERENCE_PAGE, reference_y: 100, reference_end_page: N_PAGES,
});
const OPTIONS = Object.freeze({ read_headings: true, use_llm: false });

/**
 * Emulates POST /api/script/build: rejects over-large batches exactly as the
 * route does, and classifies using the DOCUMENT-WIDE stats it was handed — so a
 * batch sent the wrong stats produces visibly wrong output.
 */
/** Skip counters by kind for the blocks a batch owns. */
function skippedOwned(blocks) {
    const out = {};
    for (const b of blocks) if (!b.speak) out[b.kind] = (out[b.kind] || 0) + 1;
    return out;
}

function fakeServer({ cap = SERVER_MAX_PAGES, failPages = new Set() } = {}) {
    const seen = [];
    async function post(payload) {
        seen.push(payload);
        if (payload.pages.length > cap) {
            const err = new Error(`Too many pages in one request (max ${cap})`);
            err.kind = 'http'; err.status = 400;
            throw err;
        }
        if (payload.pages.some((p) => failPages.has(p.page))) throw new Error('classifier exploded');

        const sentences = [], blocks = [];
        for (const page of payload.pages) {
            const isRef = page.page >= (payload.stats.reference_page ?? Infinity);
            for (const line of page.lines) {
                const kind = isRef ? 'reference' : line.text.startsWith('#') ? 'header' : 'body';
                blocks.push({ kind, page: page.page, items: line.items, speak: kind === 'body' });
                if (kind !== 'body') continue;
                sentences.push({
                    text: line.text, raw: line.text, page: page.page,
                    kind, items: line.items, source: 'rules',
                });
            }
        }
        // The route's N4 contract: pages outside own_from..own_to are context, not output.
        const owned = (x) => payload.own_from === undefined
            || (x.page >= payload.own_from && x.page <= payload.own_to);
        return {
            doc_id: payload.doc_id,
            sentences: sentences.filter(owned),
            blocks: blocks.filter(owned),
            stats: {
                blocks: blocks.filter(owned).length, sentences: sentences.filter(owned).length,
                skipped: skippedOwned(blocks.filter(owned)),
                skipped_total: blocks.filter(owned).filter((b) => !b.speak).length, llm_used: 0,
            },
        };
    }
    return { post, seen };
}

const run = (server, over = {}) => buildScriptBatched({
    docId: 'deadbeef', pages: PAGES, stats: STATS, options: OPTIONS, post: server.post, ...over,
});

// ── 1. the defect itself ──────────────────────────────────────────────────────
console.log('\n1. a >80-page document no longer trips the server cap');
ok('   batch size plus its context stays under the server cap',
    MAX_PAGES_PER_BATCH + CONTEXT_PAGES_BEFORE + CONTEXT_PAGES_AFTER <= SERVER_MAX_PAGES,
    `${MAX_PAGES_PER_BATCH} vs ${SERVER_MAX_PAGES}`);

const unbatched = fakeServer();
let rejected = null;
await unbatched.post({ doc_id: 'x', stats: STATS, pages: PAGES, options: OPTIONS })
    .catch((e) => { rejected = e; });
ok('   one whole-document POST is refused by the server (the bug)',
    rejected !== null && rejected.status === 400, String(rejected));

const server = fakeServer();
const result = await run(server);
ok('   every request stayed within the cap',
    server.seen.every((p) => p.pages.length <= SERVER_MAX_PAGES),
    `max=${Math.max(...server.seen.map((p) => p.pages.length))}`);
ok('   every page is owned by exactly one batch, in order',
    eq(server.seen.flatMap((p) => PAGES.slice(p.own_from - 1, p.own_to).map((g) => g.page)),
        PAGES.map((p) => p.page)));
ok('   each batch carries 2 pages before and 1 after as context (N4)',
    server.seen.every((p) => p.pages[0].page === Math.max(1, p.own_from - CONTEXT_PAGES_BEFORE)
        && p.pages.at(-1).page === Math.min(N_PAGES, p.own_to + CONTEXT_PAGES_AFTER)),
    JSON.stringify(server.seen.map((p) => [p.pages[0].page, p.own_from, p.own_to, p.pages.at(-1).page])));

// ── 2. merged == what one request would have produced ─────────────────────────
console.log('\n2. the merged script equals a single un-capped request');
const uncapped = fakeServer({ cap: Infinity });
const whole = await uncapped.post({ doc_id: 'deadbeef', stats: STATS, pages: PAGES, options: OPTIONS });
ok('   sentence lists are identical', eq(result.sentences, whole.sentences),
    `${result.sentences.length} vs ${whole.sentences.length}`);
console.log(`        ${whole.sentences.length} sentences over ${N_PAGES} pages, ` +
    `${server.seen.length} batches of ≤${MAX_PAGES_PER_BATCH}`);
ok('   merged report equals the whole-document report',
    eq({ ...result.stats, failed_batches: undefined, failed_pages: undefined },
        { ...whole.stats, failed_batches: undefined, failed_pages: undefined }),
    JSON.stringify(result.stats));

// ── 3. the seam ───────────────────────────────────────────────────────────────
console.log('\n3. indices, pages and items line up across every batch seam');
const pageSeq = result.sentences.map((s) => s.page);
ok('   page numbers never go backwards', pageSeq.every((p, i) => i === 0 || p >= pageSeq[i - 1]));
const seamPage = MAX_PAGES_PER_BATCH + 1;
const firstOfSecond = result.sentences.findIndex((s) => s.page === seamPage);
const lastOfFirst = firstOfSecond - 1;
ok('   the sentence before the seam is the last of the previous page',
    result.sentences[lastOfFirst].page === MAX_PAGES_PER_BATCH,
    String(result.sentences[lastOfFirst].page));
ok('   the seam sentence keeps its own page and per-page item indices',
    eq(result.sentences[firstOfSecond],
        { text: `Page ${seamPage} opens with a claim about estimators`,
            raw: `Page ${seamPage} opens with a claim about estimators`,
            page: seamPage, kind: 'body', items: [3, 4, 5], source: 'rules' }),
    JSON.stringify(result.sentences[firstOfSecond]));
ok('   the merged index of a sentence equals its whole-document index',
    whole.sentences[firstOfSecond].page === seamPage
    && eq(whole.sentences[firstOfSecond], result.sentences[firstOfSecond]));

// ── 4. document-wide stats survive batching ───────────────────────────────────
console.log('\n4. document-wide stats reach every batch unchanged');
ok('   every batch carried the identical stats object',
    server.seen.every((p) => eq(p.stats, STATS)));
ok('   num_pages stayed the document total, not the batch size',
    server.seen.every((p) => p.stats.num_pages === N_PAGES));
const refSentences = result.sentences.filter((s) => s.page >= REFERENCE_PAGE);
ok('   the bibliography (document-wide stat) was still skipped in the last batch',
    refSentences.length === 0, `${refSentences.length} leaked`);
ok('   doc_id and options are forwarded on every batch',
    server.seen.every((p) => p.doc_id === 'deadbeef' && eq(p.options, OPTIONS)));

// ── 5. progress ───────────────────────────────────────────────────────────────
console.log('\n5. progress is reported per batch');
const seenProgress = [];
const p2 = fakeServer();
await run(p2, { onProgress: (x) => seenProgress.push(x) });
ok('   one progress event per batch', seenProgress.length === p2.seen.length,
    `${seenProgress.length} vs ${p2.seen.length}`);
ok('   done climbs monotonically to the page total',
    seenProgress.every((x, i) => i === 0 || x.done >= seenProgress[i - 1].done)
    && seenProgress.at(-1).done === N_PAGES && seenProgress.at(-1).total === N_PAGES,
    JSON.stringify(seenProgress.at(-1)));

// ── 6. one failed batch must not discard the others ───────────────────────────
console.log('\n6. a failed batch keeps the batches that succeeded');
const flaky = fakeServer({ failPages: new Set([MAX_PAGES_PER_BATCH + 5]) });
const partial = await run(flaky);
ok('   sentences from the surviving batches are kept',
    partial.sentences.length > 0 && partial.sentences.length < whole.sentences.length,
    `${partial.sentences.length} of ${whole.sentences.length}`);
ok('   the failed page range is reported, not swallowed',
    partial.failures.length === 1
    && partial.failures[0].from === MAX_PAGES_PER_BATCH + 1
    && partial.failures[0].to === MAX_PAGES_PER_BATCH * 2
    && /exploded/.test(partial.failures[0].message),
    JSON.stringify(partial.failures));
ok('   surviving pages are still in ascending order across the hole',
    partial.sentences.every((s, i) => i === 0 || s.page >= partial.sentences[i - 1].page));
ok('   the hole is exactly the failed batch',
    partial.sentences.every((s) => s.page <= MAX_PAGES_PER_BATCH || s.page > MAX_PAGES_PER_BATCH * 2));
ok('   the merged report counts the failure',
    partial.stats.failed_batches === 1 && partial.stats.failed_pages === MAX_PAGES_PER_BATCH,
    JSON.stringify(partial.stats));

console.log('\n7. a total failure still surfaces as an error (main.js then falls back)');
const dead = { post: async () => { throw new Error('server down'); }, seen: [] };
let thrown = null;
await buildScriptBatched({ docId: 'x', pages: PAGES, stats: STATS, options: OPTIONS, post: dead.post })
    .catch((e) => { thrown = e; });
ok('   every batch failing rejects', thrown instanceof Error, String(thrown));
ok('   the message names the failure', /server down/.test(thrown.message), thrown.message);

// ── 8. pure helpers ───────────────────────────────────────────────────────────
console.log('\n8. pure helpers');
const chunks = batchPages(PAGES, MAX_PAGES_PER_BATCH);
ok('   203 pages split into ceil(203/size) batches',
    chunks.length === Math.ceil(N_PAGES / MAX_PAGES_PER_BATCH), String(chunks.length));
ok('   no batch exceeds the size', chunks.every((c) => c.length <= MAX_PAGES_PER_BATCH));
ok('   batches concatenate back to the input', eq(chunks.flat(), PAGES));
ok('   an empty document yields no batches', batchPages([], 10).length === 0);
ok('   a short document is one batch', batchPages(PAGES.slice(0, 3), 10).length === 1);

const merged = mergeReports([
    { blocks: 2, sentences: 1, skipped: { header: 2 }, skipped_total: 2, llm_used: 1 },
    { blocks: 3, sentences: 2, skipped: { header: 1, table: 4 }, skipped_total: 5, llm_used: 0 },
]);
ok('   reports sum and skip counters merge',
    eq(merged, { blocks: 5, sentences: 3, skipped: { header: 3, table: 4 }, skipped_total: 7, llm_used: 1 }),
    JSON.stringify(merged));
ok('   merging nothing yields a zeroed report',
    eq(mergeReports([]), { blocks: 0, sentences: 0, skipped: {}, skipped_total: 0, llm_used: 0 }));

console.log('\n9. inputs are never mutated');
ok('   the caller\'s pages array is untouched', PAGES.length === N_PAGES && PAGES[0].page === 1);
ok('   the caller\'s stats object is untouched', eq(STATS, {
    body_size: 9.9, num_pages: N_PAGES, repeated: ['preprint under review'],
    repeated_y: [], reference_page: REFERENCE_PAGE, reference_y: 100, reference_end_page: N_PAGES,
}));
ok('   batches are new arrays, not views onto the input', chunks[0] !== PAGES);

// ── 10. a superseded build stops (U21 round 2) ───────────────────────────────
console.log('\n10. an aborted build posts nothing more and settles at once');
const posted = [];
const progress = [];
const hanging = [];
const controller = new AbortController();
const stalled = buildScriptBatched({
    docId: 'doc', pages: PAGES, stats: STATS, options: OPTIONS, batchSize: 60,
    signal: controller.signal,
    onProgress: (p) => progress.push(p.batch),
    post: (payload, init) => {
        posted.push(payload);
        if (posted.length === 1) return Promise.resolve({ sentences: [], stats: null });
        return new Promise((_, reject) => hanging.push({ reject, signal: init?.signal }));   // never answers
    },
});
await new Promise((r) => setTimeout(r, 5));
ok('   (control) the second batch is in flight', posted.length === 2 && progress.length === 1, `${posted.length} posted`);
ok('   the in-flight post is handed the signal, so a transport can cancel it',
    hanging[0]?.signal === controller.signal);
controller.abort();
const outcome = await Promise.race([
    stalled.then(() => 'resolved', (err) => err?.name),
    new Promise((r) => setTimeout(() => r('still waiting'), 50)),
]);
ok('   the build rejects with an AbortError without waiting for the post', outcome === 'AbortError', outcome);
hanging[0]?.reject(new Error('late failure'));
await new Promise((r) => setTimeout(r, 5));
ok('   no later batch is posted', posted.length === 2, `${posted.length} posted`);
ok('   no progress is reported after the abort', progress.length === 1, progress.join());

const already = new AbortController();
already.abort();
let postedAfterAbort = 0;
const early = await buildScriptBatched({
    docId: 'doc', pages: PAGES, stats: STATS, options: OPTIONS,
    signal: already.signal, post: async () => { postedAfterAbort += 1; return { sentences: [] }; },
}).then(() => 'resolved', (err) => err?.name);
ok('   an already-aborted build posts nothing', early === 'AbortError' && postedAfterAbort === 0, `${early} ${postedAfterAbort}`);

// ── N8: the margin lines that print page numbers survive the merge ──────────
console.log('\nN8. page-number marks are kept, nothing else of the blocks');
const marked = await buildScriptBatched({
    docId: 'doc', pages: PAGES.slice(0, 3), stats: STATS, options: OPTIONS, batchSize: 2,
    post: async (payload) => ({
        sentences: [],
        stats: null,
        blocks: payload.pages.flatMap((p) => [
            { kind: 'header', page: p.page, items: [0], text: `  ${p.page + 10} Chapter 1  `, speak: false },
            { kind: 'pagenum', page: p.page, items: [1], text: String(p.page), speak: false },
            { kind: 'footer', page: p.page, items: [2], text: 'x'.repeat(500), speak: false },
            { kind: 'table', page: p.page, items: [3], text: '12 34', speak: false },
            { kind: 'body', page: p.page, items: [4], text: '7 lines of prose', speak: true },
        ]),
    }),
});
ok('   only pagenum, header and footer blocks become marks, in page order',
    eq(marked.marks.map((m) => `${m.page}${m.kind[0]}`), ['1h', '1p', '1f', '2h', '2p', '2f', '3h', '3p', '3f']),
    JSON.stringify(marked.marks.map((m) => m.kind)));
ok('   a mark is just {page, text, kind}, trimmed', eq(marked.marks[0], { page: 1, text: '11 Chapter 1', kind: 'header' }),
    JSON.stringify(marked.marks[0]));
ok('   a long margin line is capped, so a mislabelled paragraph costs little',
    marked.marks[2].text.length <= MAX_MARK_CHARS, String(marked.marks[2].text.length));
ok('   a response with no blocks has no marks', eq(result.marks.filter((m) => m.kind === 'pagenum'), []));


// ── N4: a sentence over a batch seam is built once, whole ────────────────────
console.log('\nN4. a sentence that crosses a batch seam joins exactly as in one build');
/**
 * A fake that joins a page's last line to the next page's first when it has no full stop,
 * at most once per sentence -- the pipeline's page-turn rule -- and honours own_from/own_to.
 */
function joiningServer() {
    const seen = [];
    async function post(payload) {
        seen.push(payload);
        const out = [];
        for (const page of payload.pages) {
            const line = page.lines[0];
            const prev = out.at(-1);
            if (prev && !prev.spans && prev.page === page.page - 1 && !prev.text.endsWith('.')) {
                out[out.length - 1] = { ...prev, text: `${prev.text} ${line.text}`,
                    spans: [{ page: prev.page, items: prev.items }, { page: page.page, items: line.items }] };
            } else {
                out.push({ text: line.text, page: page.page, kind: 'body', items: line.items });
            }
        }
        const owned = (x) => payload.own_from === undefined
            || (x.page >= payload.own_from && x.page <= payload.own_to);
        return { sentences: out.filter(owned), blocks: [], stats: null };
    }
    return { post, seen };
}
const SEAM_PAGES = Array.from({ length: 7 }, (_, i) => ({
    page: i + 1,
    lines: [{ idx: 0, text: [3, 4, 5].includes(i + 1) ? `page ${i + 1} runs on and` : `page ${i + 1} ends.`,
        items: [i] }],
}));
const seamWhole = await joiningServer().post({ pages: SEAM_PAGES });
const seamServer = joiningServer();
const seamBatched = await buildScriptBatched({
    docId: 'doc', pages: SEAM_PAGES, stats: STATS, options: OPTIONS, batchSize: 3, post: seamServer.post,
});
ok('   (control) the whole build joins page 3 into 4, and 5 into 6',
    eq(seamWhole.sentences.filter((x) => x.spans).map((x) => x.spans.map((p) => p.page)), [[3, 4], [5, 6]]));
ok('   3-page batches give exactly the whole build', eq(seamBatched.sentences, seamWhole.sentences),
    JSON.stringify(seamBatched.sentences.map((x) => x.text)));
ok('   the seam sentence (pages 3|4) appears once, owned by the batch it starts in',
    seamBatched.sentences.filter((x) => x.text.startsWith('page 3')).length === 1
    && !seamBatched.sentences.some((x) => x.text.startsWith('page 4')));
ok('   a server that ignores own_from/own_to still yields no duplicates',
    eq((await buildScriptBatched({ docId: 'doc', pages: SEAM_PAGES, stats: STATS, options: OPTIONS, batchSize: 3,
        post: (payload) => joiningServer().post({ pages: payload.pages }) })).sentences.map((x) => x.page),
    seamWhole.sentences.map((x) => x.page)));
ok('   pages without numbers are sent bare, as before',
    eq((await (async () => { const sv = joiningServer();
        await buildScriptBatched({ docId: 'doc', pages: [{ lines: SEAM_PAGES[0].lines }], stats: STATS,
            options: OPTIONS, post: sv.post });
        return sv.seen.map((p) => [p.pages.length, p.own_from]); })()), [[1, undefined]]));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

// H1: the defect was that a document over MAX_PAGES_PER_REQUEST went to a naive
// fallback splitter. No sample PDF is that long, so build one: real geometry from a
// real paper, repeated until the document is 400 pages.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PDFJS_DIR || '/tmp/pdfjs'}/`);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
const root = require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, '');
const view = await import(new URL('../../static/js/pdfview.js', import.meta.url).href);
const sb = await import(new URL('../../static/js/scriptbuild.js', import.meta.url).href);
const BASE = 'http://127.0.0.1:8000';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${x}`)); };
const post = async (payload) => {
    const res = await fetch(`${BASE}/api/script/build`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
};

const DIR = process.env.PAPERS_DIR;
if (!DIR) {
    console.error('PAPERS_DIR is not set. Point it at a directory of real PDFs — see tests/live/README.md.');
    process.exit(2);
}
const PAPER = process.env.PAPERS_FILE || 'PiZero.pdf';
const data = new Uint8Array(readFileSync(`${DIR}/${PAPER}`));
const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false,
    standardFontDataUrl: `${root}standard_fonts/`, cMapUrl: `${root}cmaps/`, cMapPacked: true }).promise;
const raw = [];
for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n);
    const vp = p.getViewport({ scale: 1 });
    raw.push({ n, w: vp.width, h: vp.height, items: (await p.getTextContent()).items });
}
// The document decides the column layout, not the page (J6) — same two passes as the app.
const hint = view.consensusSplit(raw.map(r => view.splitCandidate(r.items, r.w, r.h)));
const base = raw.map(r => view.buildPageGeometry(r.items, r.n, r.w, r.h, hint));
const TARGET = 400;
const pages = [];
for (let i = 0; i < TARGET; i++) pages.push({ ...base[i % base.length], page: i + 1 });
const stats = view.computeDocStats(pages); stats.num_pages = TARGET;
console.log(`\nsynthetic book: ${TARGET} pages, ${pages.reduce((n, p) => n + p.lines.length, 0)} lines`);

console.log('\n1. the old behaviour — one request for the whole document');
let rejected = null;
try { await post({ doc_id: 'e'.repeat(40), stats, pages, options: {} }); }
catch (err) { rejected = err.message; }
ok('   the server refuses it (this is what silently fell back before)', rejected !== null, 'it was accepted');
console.log('        ' + (rejected || '').slice(0, 120));

console.log('\n2. the batched path');
const t0 = Date.now();
const seen = [];
const res = await sb.buildScriptBatched({ doc_id: 'e'.repeat(40), pages, stats, options: {}, post,
    onProgress: (p) => seen.push(p) });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
ok('   it succeeds', Array.isArray(res.sentences) && res.sentences.length > 0, String(res.sentences?.length));
ok('   no batch failed', (res.failures || []).length === 0, JSON.stringify(res.failures || []));
ok('   progress was reported for every batch', seen.length === Math.ceil(TARGET / 60), `${seen.length} events`);
ok('   the last progress event covers every page', seen.at(-1)?.done === TARGET, JSON.stringify(seen.at(-1)));
ok('   page numbers span the whole book', res.sentences.at(-1).page > TARGET - 20,
    `last page ${res.sentences.at(-1).page}`);
let backwards = 0;
for (let i = 1; i < res.sentences.length; i++) if (res.sentences[i].page < res.sentences[i - 1].page) backwards++;
ok('   reading order holds across all seams', backwards === 0, `${backwards} regressions`);
console.log(`        ${res.sentences.length} sentences, ${res.stats.skipped_total} skipped, ${secs}s`);

console.log('\n3. a failing batch costs its pages, not the document');
let calls = 0;
const flaky = async (payload) => { calls++; if (calls === 2) throw new Error('simulated batch failure'); return post(payload); };
const partial = await sb.buildScriptBatched({ pages, stats, options: {}, post: flaky, batchSize: 60 });
ok('   the other batches still produced sentences', partial.sentences.length > 0, String(partial.sentences.length));
ok('   the failure is reported, not swallowed', partial.failures.length === 1, JSON.stringify(partial.failures));
ok('   it names the page range', /^\d+$/.test(String(partial.failures[0].from)), JSON.stringify(partial.failures[0]));
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);

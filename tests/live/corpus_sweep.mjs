// Full-corpus end-to-end: real pdf.js -> real pdfview.js -> real scriptbuild.js -> live server.
// This is the app's own path; only the DOM is absent.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.PDFJS_DIR || '/tmp/pdfjs'}/`);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
const root = require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, '');

const view = await import(new URL('../../static/js/pdfview.js', import.meta.url).href);
const sb = await import(new URL('../../static/js/scriptbuild.js', import.meta.url).href);

const DIR = process.env.PAPERS_DIR;
if (!DIR) {
    console.error('PAPERS_DIR is not set. Point it at a directory of real PDFs — see tests/live/README.md.');
    process.exit(2);
}
const files = readdirSync(DIR).filter(f => f.endsWith('.pdf')).sort();
const BASE = 'http://127.0.0.1:8000';

const post = async (payload) => {
    const res = await fetch(`${BASE}/api/script/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
};

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const rows = [];
for (const f of files) {
    const t0 = Date.now();
    const data = new Uint8Array(readFileSync(`${DIR}/${f}`));
    const doc = await pdfjsLib.getDocument({
        data, useSystemFonts: false,
        standardFontDataUrl: `${root}standard_fonts/`, cMapUrl: `${root}cmaps/`, cMapPacked: true,
    }).promise;
    const raw = [];
    for (let n = 1; n <= doc.numPages; n++) {
        const p = await doc.getPage(n);
        const vp = p.getViewport({ scale: 1 });
        raw.push({ n, w: vp.width, h: vp.height, items: (await p.getTextContent()).items });
    }
    // The document decides the column layout, not the page (J6) — same two passes as the app.
    const hint = view.consensusSplit(raw.map(r => view.splitCandidate(r.items, r.w, r.h)));
    const pages = raw.map(r => view.buildPageGeometry(r.items, r.n, r.w, r.h, hint));
    const stats = view.computeDocStats(pages);
    stats.num_pages = doc.numPages;

    const result = await sb.buildScriptBatched({
        docId: 'f'.repeat(40), stats, pages, options: {}, post,
        onProgress: () => {},
    });
    const sents = result.sentences || [];

    // ── assertions ──
    const problems = [];
    // 1. reading order: page numbers never go backwards
    for (let i = 1; i < sents.length; i++) {
        if (sents[i].page < sents[i - 1].page) {
            problems.push(`order: sentence ${i} on p${sents[i].page} follows p${sents[i - 1].page}`);
            break;
        }
    }
    // 2. no running head / footer text reached the voice
    const repeated = new Set((stats.repeated || []).map(norm));
    let headLeak = 0;
    for (const s of sents) if (repeated.has(norm(s.text || ''))) headLeak++;
    // 3. no bibliography leaked
    let refLeak = 0;
    if (stats.reference_page) {
        const end = stats.reference_end_page || 1e9;
        for (const s of sents) {
            if (s.page > stats.reference_page && s.page < end && /\b(19|20)\d\d[a-z]?\.\s*$|\bpp\.\s*\d|arXiv:\d/.test(s.text || '')) refLeak++;
        }
    }
    rows.push({
        file: f.slice(0, 34), pages: doc.numPages, lines: pages.reduce((n, p) => n + p.lines.length, 0),
        batches: Math.ceil(doc.numPages / 60), sentences: sents.length,
        skipped: result.stats?.skipped_total ?? 0, failed: result.stats?.failed_pages ?? 0,
        headLeak, refLeak, refPage: stats.reference_page ?? '-',
        secs: ((Date.now() - t0) / 1000).toFixed(1), problems,
    });
    console.log(`done ${f}`);
}

console.log('\n' + 'file'.padEnd(35) + 'pg  lines  bat  sents  skip  fail  head  ref  refP   s');
for (const r of rows) {
    console.log(r.file.padEnd(35) +
        String(r.pages).padStart(3) + String(r.lines).padStart(7) + String(r.batches).padStart(5) +
        String(r.sentences).padStart(7) + String(r.skipped).padStart(6) + String(r.failed).padStart(6) +
        String(r.headLeak).padStart(6) + String(r.refLeak).padStart(5) + String(r.refPage).padStart(6) +
        r.secs.padStart(6));
    for (const p of r.problems) console.log('      !! ' + p);
}
const bad = rows.filter(r => r.problems.length || r.failed || r.headLeak || r.refLeak);
console.log(`\n${bad.length === 0 ? 'ALL CLEAN' : bad.length + ' DOCUMENTS WITH FINDINGS'}`);

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
const BASE = 'http://127.0.0.1:8000';
const post = async (payload) => {
    const res = await fetch(`${BASE}/api/script/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
};
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${x}`)); };

async function geometry(file) {
    const data = new Uint8Array(readFileSync(`${DIR}/${file}`));
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
    const pages = raw.map(r => view.buildPageGeometry(r.items, r.n, r.w, r.h, hint));
    const stats = view.computeDocStats(pages); stats.num_pages = doc.numPages;
    return { pages, stats, numPages: doc.numPages };
}

// ── 1. batching equivalence ───────────────────────────────────────────────────
console.log('\n1. a batched build equals an unbatched one');
for (const f of ['MaskViT.pdf', 'PiZero.pdf', 'InContextLimitation.pdf']) {
    const { pages, stats } = await geometry(f);
    const whole = await sb.buildScriptBatched({ pages, stats, options: {}, post, batchSize: 1000 });
    const split = await sb.buildScriptBatched({ pages, stats, options: {}, post, batchSize: 3 });
    const a = whole.sentences.map(s => `${s.page}|${s.text}`);
    const b = split.sentences.map(s => `${s.page}|${s.text}`);
    const firstDiff = a.findIndex((x, i) => x !== b[i]);
    ok(`   ${f}: same sentences (${a.length})`, a.length === b.length && firstDiff === -1,
        firstDiff >= 0 ? `first diff at ${firstDiff}:\n        whole=${a[firstDiff]}\n        split=${b[firstDiff]}` : `${a.length} vs ${b.length}`);
}

// ── 2. per-document integrity ─────────────────────────────────────────────────
console.log('\n2. highlight indices, seams, and the bibliography');
const files = readdirSync(DIR).filter(f => f.endsWith('.pdf')).sort();
let badIdx = 0, dupes = 0, refSpoken = 0, docsWithRef = 0;
const details = [];
for (const f of files) {
    const { pages, stats } = await geometry(f);
    const res = await sb.buildScriptBatched({ pages, stats, options: {}, post, batchSize: 60 });
    const byPage = new Map(pages.map(p => [p.page, p]));
    let bi = 0;
    for (const s of res.sentences) {
        const pg = byPage.get(s.page);
        if (!pg) { bi++; continue; }
        const maxItem = Math.max(-1, ...pg.lines.flatMap(l => l.items || []));
        for (const it of s.items || []) if (!Number.isInteger(it) || it < 0 || it > maxItem) { bi++; break; }
    }
    badIdx += bi;
    // consecutive identical sentences on the same page = a seam duplicate
    let dp = 0;
    for (let i = 1; i < res.sentences.length; i++) {
        const a = res.sentences[i - 1], b = res.sentences[i];
        if (a.page === b.page && a.text === b.text && (a.items || []).join() === (b.items || []).join()) dp++;
    }
    dupes += dp;
    let rs = 0;
    if (stats.reference_page) {
        docsWithRef++;
        const end = stats.reference_end_page || 1e9;
        rs = res.sentences.filter(s => s.page > stats.reference_page && s.page < end).length;
    }
    refSpoken += rs;
    if (bi || dp || rs > 5) details.push(`${f}: badIdx=${bi} dup=${dp} spokenInBiblio=${rs}`);
}
ok(`   every highlight index exists on its page`, badIdx === 0, `${badIdx} bad`);
ok(`   no duplicated sentence at a batch seam`, dupes === 0, `${dupes} dupes`);
ok(`   bibliography pages are silent (${docsWithRef} docs have one)`, refSpoken === 0, `${refSpoken} sentences spoken inside a bibliography`);
for (const d of details) console.log('        ' + d);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);

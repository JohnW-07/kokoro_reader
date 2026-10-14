// Ground truth: real pdf.js text items from a real paper -> real pdfview.js geometry
// -> real /api/script/build. The only thing missing versus the app is the DOM.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// pdfjs-dist is a dev-only dependency for this script; install it wherever you like and
// point PDFJS_DIR at that directory (it must contain node_modules/pdfjs-dist).
const require = createRequire(`${process.env.PDFJS_DIR || process.cwd()}/`);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');

const view = await import(new URL('../../static/js/pdfview.js', import.meta.url).href);

const [file, firstArg, lastArg, showArg] = process.argv.slice(2);
const first = Number(firstArg || 1), last = Number(lastArg || 8), show = Number(showArg || 16);

const data = new Uint8Array(readFileSync(file));
// Without the standard-font and CMap data, pdf.js cannot decode fonts that rely on them
// and the text layer comes back as glyph soup -- a harness artefact that reads exactly
// like a real extraction bug. Point it at the installed package's own copies.
const pdfjsRoot = require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, '');
const doc = await pdfjsLib.getDocument({
  data,
  useSystemFonts: false,
  standardFontDataUrl: `${pdfjsRoot}standard_fonts/`,
  cMapUrl: `${pdfjsRoot}cmaps/`,
  cMapPacked: true,
}).promise;

// Two passes, exactly as `extractGeometry` does it: every page votes on the gutter, the
// document decides, then every page is laid out under that one verdict (J6).
const raw = [];
for (let n = first; n <= Math.min(last, doc.numPages); n++) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  raw.push({ n, w: vp.width, h: vp.height, items: (await page.getTextContent()).items });
}
const candidates = raw.map(r => view.splitCandidate(r.items, r.w, r.h));
const hint = view.consensusSplit(candidates);
const pages = raw.map(r => view.buildPageGeometry(r.items, r.n, r.w, r.h, hint));
const stats = view.computeDocStats(pages);
stats.num_pages = doc.numPages;

console.log(`columns: per-page ${JSON.stringify(candidates.map(c => c === null ? null : Math.round(c)))}`
          + ` -> document ${hint === undefined ? 'undecided (too few pages)' : hint}`);
console.log(`FILE ${file.split('/').pop()}  pages ${first}-${Math.min(last, doc.numPages)} of ${doc.numPages}`);
console.log(`geometry: ${pages.reduce((n,p)=>n+p.lines.length,0)} lines | body_size=${stats.body_size} `
          + `repeated=${stats.repeated.length} ref_page=${stats.reference_page}`);

const res = await fetch('http://127.0.0.1:8000/api/script/build', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ doc_id: 'f'.repeat(40), stats, pages, options: {} }),
});
if (!res.ok) { console.error('HTTP', res.status, (await res.text()).slice(0,300)); process.exit(1); }
const out = await res.json();
console.log('pipeline:', JSON.stringify(out.stats));

console.log('\n--- SKIPPED (up to 3 per kind) ---');
const seen = {};
for (const b of out.blocks.filter(b => !b.speak)) {
  seen[b.kind] = (seen[b.kind] || 0) + 1;
  if (seen[b.kind] > 3) continue;
  console.log(`  [${b.kind.padEnd(9)}] ${b.reason.slice(0,38).padEnd(38)} | ${b.text.replace(/\s+/g,' ').slice(0,60)}`);
}
console.log(`\n--- SPOKEN (first ${show}) ---`);
for (const s of out.sentences.slice(0, show))
  console.log(`  p${s.page} [${s.kind.padEnd(8)}] ${s.text.slice(0, 108)}`);

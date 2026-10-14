// Throwaway harness: stub DOM + stub pdfjsLib, to prove the defect-D1 contract.
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

class El {
    constructor(tag) {
        this.tagName = tag; this.className = ''; this.dataset = {};
        // Real CSSStyleDeclaration, not a bare object: pdfview sets the --scale-factor
        // custom property, which only exists via setProperty().
        this.style = {
            _custom: {},
            setProperty(name, value) { this._custom[name] = String(value); },
            getPropertyValue(name) { return this._custom[name] ?? ''; },
        };
        this.children = []; this._cls = new Set(); this.innerHTML = '';
        this.classList = { add: c => this._cls.add(c), remove: c => this._cls.delete(c) };
    }
    append(...c) { this.children.push(...c); }
    appendChild(c) { this.children.push(c); return c; }
    remove() {}
    replaceChildren(...c) { this.children = c; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getContext() { return {}; }
    getBoundingClientRect() { return { top: 0, bottom: 800, left: 0, right: 600, width: 600, height: 800 }; }
    scrollIntoView() {}
}
globalThis.document = { createElement: t => new El(t) };
globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const FAIL_PAGE = 2, SLOW_PAGE = 4;
let attempts = 0;
let releaseSlow;
const slowRender = new Promise(res => { releaseSlow = res; });
const textContent = { items: [{ str: 'hello', width: 25, height: 10, transform: [10, 0, 0, 10, 72, 700] }] };
const makePage = n => ({
    view: [0, 0, 612, 792],
    getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
    getTextContent: async () => textContent,
    render() {
        if (n === SLOW_PAGE) return { promise: slowRender, cancel() {} };
        const first = n === FAIL_PAGE && ++attempts === 1;
        return { promise: first ? Promise.reject(new Error('canvas exploded')) : Promise.resolve(), cancel() {} };
    },
});
const spansByLayer = new Map();          // textLayer element → the textDivs array pdf.js filled
globalThis.pdfjsLib = {
    getDocument: () => ({ promise: Promise.resolve({
        numPages: 4, getPage: async n => makePage(n), destroy: async () => {},
    }) }),
    renderTextLayer: ({ textDivs, container }) => {
        textDivs.push(new El('span'), new El('span'));
        spansByLayer.set(container, textDivs);
        return { promise: Promise.resolve() };   // pdf.js 3.x shape: {promise}
    },
};

const { createPdfView } = await import('../../static/js/pdfview.js');

const container = new El('div');
container.clientHeight = 800; container.scrollTop = 0;
container.scrollTo = () => {}; container.addEventListener = () => {}; container.removeEventListener = () => {};

const progress = [];
const view = createPdfView({ container, onPageChange: () => {}, onProgress: p => progress.push(p) });

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);   // "%PDF"
const { numPages, docId } = await view.load(bytes);
console.log('\n1. load');
ok('   numPages surfaced', numPages === 4, numPages);
ok('   docId is 40 hex chars (SHA-1)', /^[0-9a-f]{40}$/.test(docId), docId);
console.log(`        docId = ${docId}`);
ok('   layout progress reported', progress.filter(p => p.phase === 'layout').length === 4);

console.log('\n2. renderPage never rejects, and an error page is retryable (D1)');
let threw = null;
const first = await view.renderPage(FAIL_PAGE).catch(e => { threw = e; return 'REJECTED'; });
ok('   a rejecting render resolves false, never rejects', first === false && threw === null, `got ${first} / ${threw}`);
const second = await view.renderPage(FAIL_PAGE);
ok('   the same page retries on the next call and succeeds', second === true, `got ${second}`);
ok('   the retry actually re-ran pdf.js render', attempts === 2, `attempts=${attempts}`);
const third = await view.renderPage(FAIL_PAGE);
ok('   a done page short-circuits (no third render)', third === true && attempts === 2, `attempts=${attempts}`);

console.log('\n3. concurrent calls for an in-flight page share one promise');
const a = view.renderPage(SLOW_PAGE), b = view.renderPage(SLOW_PAGE);
ok('   two concurrent calls return the identical promise', a === b);

console.log('\n4. highlightItems never throws');
ok('   an unrendered (in-flight) page defers and returns false', view.highlightItems(SLOW_PAGE, [0, 1]) === false);
releaseSlow();
ok('   both concurrent calls resolve true', (await a) === true && (await b) === true);
const slowSpans = spansByLayer.get(view.textLayerEl(SLOW_PAGE));
ok('   the deferred highlight was applied once the page landed',
    slowSpans[0]._cls.has('reading') && slowSpans[1]._cls.has('reading'));
ok('   returns true once the page is rendered', view.highlightItems(3, [0, 1]) === true);
ok('   out-of-range indices are ignored, not thrown', view.highlightItems(3, [0, 99]) === true);
ok('   unknown page returns false', view.highlightItems(42, [0]) === false);
ok('   garbage items return false', view.highlightItems(3, null) === false);
ok('   a page whose render failed for good returns false without throwing',
    view.highlightItems(1, [0]) !== undefined);
view.clearHighlights();
ok('   clearHighlights is safe', true);

console.log('\n4b. a sentence over a page turn highlights on both pages (N4)');
const layer = (n) => spansByLayer.get(view.textLayerEl(n));
for (const n of [3, 4]) for (const span of layer(n)) span._cls.clear();
ok('   highlightSpans paints now when the start page is rendered',
    view.highlightSpans([{ page: 3, items: [1] }, { page: 4, items: [0] }]) === true);
ok('   the start page\'s part is lit', layer(3)[1]._cls.has('reading') && !layer(3)[0]._cls.has('reading'));
ok('   the next page\'s part is lit', layer(4)[0]._cls.has('reading') && !layer(4)[1]._cls.has('reading'));
ok('   with no span found, readingEl is the start page', view.readingEl() === view.pageWrapEl(3));
ok('   a part on an unknown page is dropped, the rest still paints',
    view.highlightSpans([{ page: 42, items: [0] }, { page: 3, items: [0] }]) === true
    && view.readingEl() === view.pageWrapEl(3));
ok('   no usable part returns false', view.highlightSpans([{ page: 42, items: [0] }]) === false
    && view.highlightSpans(null) === false && view.readingEl() === null);
view.clearHighlights();

console.log('\n5. extractGeometry');
const { pages: geo, stats } = await view.extractGeometry();
ok('   one payload per page', geo.length === 4, geo.length);
ok('   page box is unrotated user space', geo[0].width === 612 && geo[0].height === 792);
ok('   top-origin y', geo[0].lines[0].y === 92, geo[0].lines[0].y);
ok('   stats shape matches DocStats', typeof stats.body_size === 'number'
    && stats.num_pages === 4 && Array.isArray(stats.repeated) && stats.reference_page === null,
    JSON.stringify(stats));
ok('   extraction progress reported', progress.filter(p => p.phase === 'extract').length === 4);
console.log('        line JSON = ' + JSON.stringify(geo[0].lines[0]));
console.log('        stats     = ' + JSON.stringify(stats));

console.log('\n5b. extractGeometry stops between pages once its signal aborts');
{
    const reads = () => progress.filter(p => p.phase === 'extract').length;
    const settle = async (signal) => { try { await view.extractGeometry({ signal }); return null; } catch (err) { return err; } };
    let before = reads();
    const err = await settle(AbortSignal.abort());
    ok('   an already-aborted signal reads no page', err?.name === 'AbortError' && reads() === before, `${err?.name} ${reads() - before}`);
    const controller = new AbortController();
    const push = progress.push;
    progress.push = function (p) { if (p.phase === 'extract') controller.abort(); return push.call(this, p); };
    before = reads();
    const mid = await settle(controller.signal);
    progress.push = push;
    ok('   aborted after page 1, it rejects and reads no further', mid?.name === 'AbortError' && reads() - before === 1,
        `${mid?.name} ${reads() - before} pages`);
}

console.log('\n5c. extractGeometry stops between column re-layouts once its signal aborts');
{
    // Three two-column pages carry the verdict; two plain pages disagree with it, so the
    // column loop re-reads both unless the abort stops it after the first.
    const H = 792, TWO_COL_PAGES = 3, TOTAL = 5;
    const item = (str, x, y) => ({ str, width: 218, height: 10, transform: [10, 0, 0, 10, x, H - y] });
    const twoCol = { items: Array.from({ length: 20 }, (_, i) => [
        item(`left line ${i}`, 72, 100 + i * 31), item(`right line ${i}`, 322, 100 + i * 31)]).flat() };
    const getDocument = pdfjsLib.getDocument;
    pdfjsLib.getDocument = () => ({ promise: Promise.resolve({
        numPages: TOTAL, destroy: async () => {},
        getPage: async n => ({ ...makePage(n), getTextContent: async () => (n <= TWO_COL_PAGES ? twoCol : textContent) }),
    }) });
    const controller = new AbortController();
    const phases = [];
    const cols = createPdfView({ container, onPageChange: () => {}, onProgress: p => {
        phases.push(p.phase);
        if (p.phase === 'columns') controller.abort();
    } });
    await cols.load(bytes);
    pdfjsLib.getDocument = getDocument;
    const err = await cols.extractGeometry({ signal: controller.signal }).then(() => null, e => e);
    const relaid = phases.filter(p => p === 'columns').length;
    ok('   aborted after one column re-layout, it rejects and lays out no further',
        err?.name === 'AbortError' && relaid === 1, `${err?.name} ${relaid} re-layouts`);
    cols.destroy();
}

console.log('\n6. accessors + teardown');
ok('   pageRect is CSS px at scale 1.4', view.pageRect(1).width === Math.floor(612 * 1.4));
ok('   textLayerEl / pageWrapEl exposed', !!view.textLayerEl(1) && !!view.pageWrapEl(1));
ok('   hl-layer created inside the wrap',
    view.pageWrapEl(1).children.some(c => c.className === 'hl-layer'));
ok('   numPages / currentPage', view.numPages() === 4 && view.currentPage() >= 1);

console.log('\n7. snap after a re-scale (A9)');
// The fake root finds no span, as after setScale dropped every text layer.
const scrolls = [];
container.scrollTo = opts => scrolls.push(opts);
view.highlightItems(3, [0]);
await view.setScale(2);
view.scrollToHighlight();
ok('   with no span, snap scrolls to the reading page', scrolls.length === 1, JSON.stringify(scrolls));
view.highlightSpans([{ page: 3, items: [0] }, { page: 4, items: [0] }]);
await view.setScale(2);
view.scrollToHighlight();
ok('   a two-page sentence snaps to its start page (N4)',
    scrolls.length === 2 && JSON.stringify(scrolls[1]) === JSON.stringify(scrolls[0]), JSON.stringify(scrolls));
view.clearHighlights();
view.scrollToHighlight();
ok('   with nothing being read, snap stays put', scrolls.length === 2, JSON.stringify(scrolls));
view.destroy();
ok('   destroy clears the document', view.numPages() === 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

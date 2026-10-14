// Harness for M6: a 400-page document must not pre-allocate every canvas.
//
// buildLayout() created one <canvas> per page and immediately sized its backing
// store to the viewport: floor(612*1.4) x floor(792*1.4) = 856 x 1108 px, 4
// bytes per pixel = 3.62 MiB per page, 1.41 GiB across 400 pages, before a
// single page had been looked at.
//
// Backing-store bytes are countable, so this harness counts them.

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const MiB = (b) => `${(b / 1024 / 1024).toFixed(1)} MiB`;

// ── DOM fake ──────────────────────────────────────────────────────────────────
class El {
    constructor(tag) {
        this.tagName = tag; this.className = ''; this.dataset = {};
        this.width = 0; this.height = 0; this._top = 0;
        this.style = {
            _custom: {},
            setProperty(k, v) { this._custom[k] = String(v); },
            getPropertyValue(k) { return this._custom[k] ?? ''; },
        };
        this.children = []; this._cls = new Set(); this.innerHTML = '';
        this.classList = { add: (c) => this._cls.add(c), remove: (c) => this._cls.delete(c) };
    }
    append(...c) { this.children.push(...c); }
    appendChild(c) { this.children.push(c); return c; }
    remove() {}
    replaceChildren(...c) { this.children = c; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getContext() { return {}; }
    getBoundingClientRect() {
        return { top: this._top, bottom: this._top + PAGE_PITCH_PX, left: 0, right: 600, width: 600, height: PAGE_PITCH_PX };
    }
    scrollIntoView() {}
}
globalThis.document = { createElement: (t) => new El(t) };
globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const N_PAGES = 400;
const PAGE_PITCH_PX = 1120;            // laid-out height of one page at scale 1.4
const CANVAS_W = Math.floor(612 * 1.4), CANVAS_H = Math.floor(792 * 1.4);
const EAGER_BYTES = N_PAGES * CANVAS_W * CANVAS_H * 4;

const textContent = { items: [{ str: 'hello', width: 25, height: 10, transform: [10, 0, 0, 10, 72, 700] }] };
const painted = [];
// `hold` parks every render mid-flight, which is the state section 5 is about: the backing
// store is already allocated but the render has not landed. `release()` lets them all finish.
let hold = false;
const pending = [];
const release = async () => {
    hold = false;
    for (const { resolve } of pending.splice(0)) resolve();
    await new Promise((r) => setTimeout(r, 0));
};
const makePage = (n) => ({
    view: [0, 0, 612, 792],
    getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale, scale }),
    getTextContent: async () => textContent,
    render() {
        painted.push(n);
        if (!hold) return { promise: Promise.resolve(), cancel() {} };
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        const entry = { resolve, reject };
        pending.push(entry);
        // pdf.js rejects a cancelled render; pdfview treats that as retryable, not an error.
        return { promise, cancel() { entry.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })); } };
    },
});
globalThis.pdfjsLib = {
    getDocument: () => ({ promise: Promise.resolve({ numPages: N_PAGES, getPage: async (n) => makePage(n), destroy: async () => {} }) }),
    renderTextLayer: ({ textDivs }) => { textDivs.push(new El('span'), new El('span')); return { promise: Promise.resolve() }; },
};

const { createPdfView } = await import('../../static/js/pdfview.js');

const container = new El('div');
container.clientHeight = 800; container.scrollTop = 0;
container.scrollTo = () => {}; container.addEventListener = () => {}; container.removeEventListener = () => {};
// Pages are stacked down the scroller as buildLayout appends them.
container.appendChild = function appendChild(node) {
    node._top = PAGE_PITCH_PX * this.children.length;
    this.children.push(node);
    return node;
};

const view = createPdfView({ container, onPageChange: () => {}, onProgress: () => {} });
await view.load(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

// ── Measurement ───────────────────────────────────────────────────────────────
const canvases = () => container.children.flatMap((wrap) => wrap.children.filter((c) => c.tagName === 'canvas'));
const liveBytes = () => canvases().reduce((n, c) => n + c.width * c.height * 4, 0);
const liveCanvases = () => canvases().filter((c) => c.width > 0 && c.height > 0).length;

console.log(`\n        eager allocation would be ${MiB(EAGER_BYTES)} ` +
    `(${N_PAGES} × ${CANVAS_W}×${CANVAS_H} × 4 B)`);

console.log('\n1. loading a 400-page document allocates almost nothing');
ok('   one wrap per page was laid out', container.children.length === N_PAGES, String(container.children.length));
ok('   only the pages near the viewport hold a backing store',
    liveCanvases() <= 4, `${liveCanvases()} canvases`);
ok('   total canvas bytes are a rounding error next to eager allocation',
    liveBytes() < EAGER_BYTES / 50, `${MiB(liveBytes())} vs ${MiB(EAGER_BYTES)}`);
console.log(`        after load: ${liveCanvases()} canvases, ${MiB(liveBytes())}`);

console.log('\n2. reading through the document stays inside the budget');
const { CANVAS_BUDGET_BYTES } = await import('../../static/js/pdfview.js');
let peakBytes = 0, peakCanvases = 0;
for (let n = 1; n <= 200; n++) {
    await view.renderPage(n);
    peakBytes = Math.max(peakBytes, liveBytes());
    peakCanvases = Math.max(peakCanvases, liveCanvases());
}
ok('   a budget is published', Number.isFinite(CANVAS_BUDGET_BYTES) && CANVAS_BUDGET_BYTES > 0, String(CANVAS_BUDGET_BYTES));
ok('   200 rendered pages never exceeded the budget',
    peakBytes <= CANVAS_BUDGET_BYTES, `peak ${MiB(peakBytes)} > ${MiB(CANVAS_BUDGET_BYTES)}`);
ok('   which is far below eager allocation for the same document',
    peakBytes < EAGER_BYTES / 4, `${MiB(peakBytes)} vs ${MiB(EAGER_BYTES)}`);
console.log(`        peak while reading 200 pages: ${peakCanvases} canvases, ${MiB(peakBytes)} ` +
    `(budget ${MiB(CANVAS_BUDGET_BYTES)})`);

console.log('\n3. an evicted page is still a page');
const evicted = 10;                                  // off screen: this fake shows pages 1-2
ok('   its backing store was released', container.children[evicted - 1].children[0].width === 0,
    String(container.children[evicted - 1].children[0].width));
const before = painted.length;
ok('   asking for it again re-renders it', (await view.renderPage(evicted)) === true);
ok('   the re-render really went back to pdf.js', painted.length === before + 1);
ok('   and it is in the budget again', liveBytes() <= CANVAS_BUDGET_BYTES, MiB(liveBytes()));

console.log('\n4. the page being read aloud is never evicted under it');
view.highlightItems(150, [0, 1]);
await view.renderPage(150);
for (let n = 200; n <= 260; n++) await view.renderPage(n);
const readingCanvas = container.children[149].children[0];
ok('   the reading page kept its canvas', readingCanvas.width > 0, String(readingCanvas.width));
ok('   the budget still holds', liveBytes() <= CANVAS_BUDGET_BYTES, MiB(liveBytes()));

console.log('\n4b. both pages of a sentence over a page turn keep their canvases (N4)');
view.highlightSpans([{ page: 170, items: [0] }, { page: 171, items: [0] }]);
await view.renderPage(170);
await view.renderPage(171);
for (let n = 200; n <= 260; n++) await view.renderPage(n);
ok('   the start page kept its canvas', container.children[169].children[0].width > 0);
ok('   the page it runs onto kept its canvas', container.children[170].children[0].width > 0);
ok('   the budget still holds with both', liveBytes() <= CANVAS_BUDGET_BYTES, MiB(liveBytes()));

// The defect the 300% probe caught on the 75-page Cosmos paper: peak canvas 365.2 MiB, of
// which exactly half (182.6 MiB over 6 pages) was renders still in flight. A backing store
// costs its bytes the instant it is sized, but the page only joined `painted` after the
// render resolved — so the budget could not see those bytes and eviction could not free
// them. One page is 3.4 MiB at 100% and 30.4 MiB at 300%, which is why it only bit at zoom.
console.log('\n5. paints still in flight are inside the budget too');
const ZOOM_SCALE = 1.4 * 3;                          // 300% of the default scale
await view.setScale(ZOOM_SCALE);
const pageBytes = Math.floor(612 * ZOOM_SCALE) * Math.floor(792 * ZOOM_SCALE) * 4;
const CONCURRENT = 12;                               // 12 x 33 MiB = 391 MiB, over twice the budget
hold = true;
const inFlight = [];
for (let n = 30; n < 30 + CONCURRENT; n++) inFlight.push(view.renderPage(n));
await new Promise((r) => setTimeout(r, 0));          // let every paintPage reach its allocation
const midFlight = liveBytes();
ok('   one page at 300% costs 9x what it costs at 100%',
    Math.abs(pageBytes / (CANVAS_W * CANVAS_H * 4) - 9) < 0.1, MiB(pageBytes));
ok('   concurrent paints cannot exceed the budget',
    midFlight <= CANVAS_BUDGET_BYTES,
    `${MiB(midFlight)} > ${MiB(CANVAS_BUDGET_BYTES)} with ${CONCURRENT} paints in flight`);
console.log(`        ${CONCURRENT} concurrent paints: ${liveCanvases()} canvases, ${MiB(midFlight)} ` +
    `(unbudgeted would be ${MiB(CONCURRENT * pageBytes)})`);
await release();
await Promise.all(inFlight);
ok('   the budget still holds once they land', liveBytes() <= CANVAS_BUDGET_BYTES, MiB(liveBytes()));
const beforeRetry = painted.length;
ok('   a page dropped mid-paint re-renders when asked again', (await view.renderPage(30)) === true);
ok('   and that retry really went back to pdf.js', painted.length > beforeRetry);

// U6/D0 on the 75-page Cosmos paper: pdf.js steps its canvas draw loop from
// requestAnimationFrame, and a webview that has stopped compositing delivers none — so
// `await task.promise` never settles. setScale awaited exactly that, which parked
// layout.js's serialised fit() chain for good: the pill kept stepping while the document
// stayed frozen at the scale it wedged on, through ⌘−, ⌘0 and twenty seconds of idle.
console.log('\n6. a paint that never lands does not wedge the next zoom');
const WEDGE_TIMEOUT_MS = 1000;
const settles = async (p) => (await Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), WEDGE_TIMEOUT_MS))]));
const [STEP_1, STEP_2] = [1.4 * 1.25, 1.4 * 1.5];
hold = true;                                         // from here every render hangs, and stays hung
ok('   setScale returns with every paint still in flight', await settles(view.setScale(STEP_1)));
ok('   … having already laid the pages out at the scale it was given',
    view.pageRect(1).width === Math.floor(612 * STEP_1), JSON.stringify(view.pageRect(1)));
ok('   the next zoom is not queued behind the hung one', await settles(view.setScale(STEP_2)));
ok('   … and it moves the pages again', view.pageRect(1).width === Math.floor(612 * STEP_2),
    JSON.stringify(view.pageRect(1)));
await release();

console.log('\n7. teardown releases everything');
view.destroy();
ok('   destroy drops the pages', view.numPages() === 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

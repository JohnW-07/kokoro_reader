/**
 * pdfview.js — pdf.js rendering and lazy page layout.
 * Imports only the pure helpers (pagegeom.js, docstats.js), re-exported below for
 * existing importers: `pdfjsLib` is a global and every collaborator arrives through
 * `createPdfView` options, so those helpers unit-test in plain Node without a DOM.
 * `renderPage` NEVER rejects and `highlightSpans` / `highlightItems` NEVER throw — a page-render failure
 * degrades highlighting only, it must never block playback (defect D1).
 */
import { buildPageGeometry, consensusSplit, splitCandidate } from './pagegeom.js';
import { computeDocStats } from './docstats.js';

export {
    modalValue, itemGeometry, joinItemTexts, clusterLines, detectColumnSplit,
    splitCandidate, consensusSplit, orderPageLines, buildPageGeometry,
} from './pagegeom.js';
export {
    BIBLIOGRAPHY_RE, APPENDIX_RE, normaliseRepeatKey, computeRepeated, findReferencePage,
    findReferenceSpan, computeRepeatedY, computeDocStats,
} from './docstats.js';

// ── Tunables ──────────────────────────────────────────────────────────────────
const DEFAULT_SCALE = 1.4;
const VISIBLE_MARGIN_PX = 800;
/**
 * Ceiling on live canvas backing stores (M6).
 *
 * A canvas costs width*height*4 bytes the moment its backing store is sized. At the
 * default 1.4 scale a Letter page is 856x1108 = 3.62 MiB, so a 400-page book that
 * allocated every canvas up front cost 1.41 GiB before a single page was looked at.
 * 192 MiB is ~53 pages of that size: two orders of magnitude more than any viewport
 * shows, so LRU eviction only ever reaches pages long out of sight.
 */
export const CANVAS_BUDGET_BYTES = 192 * 1024 * 1024;
const LAZY_ROOT_MARGIN = `${VISIBLE_MARGIN_PX}px 0px ${VISIBLE_MARGIN_PX}px 0px`;
const PAGE_ANCHOR_RATIO = 0.35;                    // "current page" anchor line
const HL_CLASS = 'reading';                        // must match .textLayer > span.reading in document.css

// ── DOM helpers ───────────────────────────────────────────────────────────────
function makeEl(tag, className, styles = {}) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    Object.assign(el.style, styles);
    return el;
}

/** Nearest scrolling ancestor: callers may hand us a non-scrolling pages wrapper. */
function scrollRootOf(el) {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(n).overflowY)) return n;
    }
    return el;
}

async function sha1Hex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = await crypto.subtle.digest('SHA-1', u8.slice().buffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Factory ───────────────────────────────────────────────────────────────────
/**
 * @param {HTMLElement} opts.container the scrolling element pages live in
 * @param {(page:number)=>void} [opts.onPageChange]
 * @param {(p:{done:number,total:number,phase:string})=>void} [opts.onProgress]
 */
export function createPdfView({ container, onPageChange = () => {}, onProgress = () => {},
                                scale = DEFAULT_SCALE } = {}) {
    if (!container) throw new Error('createPdfView: container is required');
    const scroller = scrollRootOf(container);   // IntersectionObserver root + scroll owner

    let pdfDoc = null;
    let root = null;                       // the .pdf-pages element we own
    let pageEls = new Map();               // page → {wrap, canvas, textLayer, hlLayer, viewport}
    let states = new Map();                // page → {status, promise}
    let textDivs = new Map();              // page → HTMLElement[] from renderTextLayer
    let tasks = new Map();                 // page → live pdf.js RenderTask
    let observer = null;
    let reading = null;                    // [{page, items}, …] current reading highlight, start page first (N4)
    let painted = new Set();               // pages holding a backing store, least-recent first
    let current = 1;
    let layouts = 0;                       // finished re-layouts: a zoom and back is two, not none
    let scrollRaf = 0;

    const warn = (what, err) => console.warn(`[pdfview] ${what}:`, err);
    const notify = (phase, done, total) => {
        try { onProgress({ done, total, phase }); } catch (err) { warn('onProgress', err); }
    };

    // ── Layout ────────────────────────────────────────────────────────────────
    function makePageEl(n, viewport) {
        const w = Math.floor(viewport.width), h = Math.floor(viewport.height);
        const box = { width: w + 'px', height: h + 'px' };
        const wrap = makeEl('div', 'pdf-page-wrap', box);
        wrap.dataset.page = String(n);
        // pdf.js 3.x writes `font-size: calc(var(--scale-factor) * Npx)` into every text
        // span and then applies a scaleX correction computed for that size. Leave the
        // variable unset and the calc() is invalid, spans inherit the body font, and the
        // invisible selection layer no longer lines up with the glyphs you can see —
        // which silently breaks text selection, and with it highlighting and notes.
        wrap.style.setProperty('--scale-factor', String(viewport.scale));
        // The CSS box is set, but the *backing store* stays 0x0 until the page is
        // actually painted -- that allocation is the 1.41 GiB in CANVAS_BUDGET_BYTES.
        const canvas = makeEl('canvas', '', box);
        const hlLayer = makeEl('div', 'hl-layer',
            { position: 'absolute', top: '0', left: '0', zIndex: '2', pointerEvents: 'none', ...box });
        const textLayer = makeEl('div', 'textLayer', box);
        // canvas → user highlights → text spans, so the reading highlight paints on top.
        wrap.append(canvas, hlLayer, textLayer);
        return { wrap, canvas, textLayer, hlLayer, viewport };
    }

    function resizePage(n, viewport) {
        const p = pageEls.get(n);
        if (!p) return;
        const w = Math.floor(viewport.width), h = Math.floor(viewport.height);
        p.viewport = viewport;
        p.wrap.style.setProperty('--scale-factor', String(viewport.scale));
        for (const el of [p.wrap, p.canvas, p.textLayer, p.hlLayer]) {
            el.style.width = w + 'px';
            el.style.height = h + 'px';
        }
        p.textLayer.innerHTML = '';
        textDivs.delete(n);
    }

    async function buildLayout() {
        // `container` is #pdf-pages, which already carries the column layout and gap.
        // Wrapping the pages in an unstyled child threw both away.
        root = container;
        for (let n = 1; n <= pdfDoc.numPages; n++) {
            const page = await pdfDoc.getPage(n);
            const entry = makePageEl(n, page.getViewport({ scale }));
            pageEls.set(n, entry);
            states.set(n, { status: 'idle', promise: null });
            root.appendChild(entry.wrap);
            notify('layout', n, pdfDoc.numPages);
        }
    }

    function observePages() {
        observer = new IntersectionObserver(entries => {
            for (const e of entries) if (e.isIntersecting) renderPage(+e.target.dataset.page);
        }, { root: scroller, rootMargin: LAZY_ROOT_MARGIN, threshold: 0.01 });
        for (const { wrap } of pageEls.values()) observer.observe(wrap);
    }

    function visiblePages() {
        const cr = scroller.getBoundingClientRect();
        const out = [];
        for (const [n, p] of pageEls) {
            const r = p.wrap.getBoundingClientRect();
            const near = r.bottom >= cr.top - VISIBLE_MARGIN_PX
                && r.top <= cr.bottom + VISIBLE_MARGIN_PX;
            if (near) out.push(n);
        }
        return out;
    }

    // ── Canvas budget (M6) ────────────────────────────────────────────────────
    function canvasBytes(n) {
        const p = pageEls.get(n);
        return p ? p.canvas.width * p.canvas.height * 4 : 0;
    }

    function liveCanvasBytes() {
        let total = 0;
        for (const n of painted) total += canvasBytes(n);
        return total;
    }

    /** Drop one page's backing store. It stays laid out and re-renders on demand. */
    function releaseCanvas(n) {
        const p = pageEls.get(n);
        painted.delete(n);
        cancelTasks(n);   // an evicted page must stop drawing into a canvas it no longer owns
        if (!p) return;
        p.canvas.width = 0;
        p.canvas.height = 0;
        p.textLayer.innerHTML = '';
        textDivs.delete(n);
        // A fresh state object orphans any in-flight render for this page.
        states.set(n, { status: 'idle', promise: null });
    }

    /**
     * Evict least-recently-painted pages until the live canvases fit the budget.
     * Never evicted: the page just painted; the page being read aloud, or the highlight
     * would point at blank paper; and the visible band, which the IntersectionObserver
     * re-fires only on ENTRY, so a page dropped inside it has nothing left to repaint it.
     * On 1440x900 that band is 900+2*800 = 2500px: 3 pages (10.1 MiB) at 100%, and at 300%
     * a 3359px page means at most 2 (60.8 MiB). It can never starve the 192 MiB budget.
     */
    function enforceCanvasBudget(justPainted) {
        const keep = new Set([justPainted, ...readingPages(), ...visiblePages()].filter(n => n != null));
        for (const n of [...painted]) {
            if (liveCanvasBytes() <= CANVAS_BUDGET_BYTES) return;
            if (!keep.has(n)) releaseCanvas(n);
        }
    }

    // ── Rendering (never rejects) ─────────────────────────────────────────────
    async function paintPage(n) {
        const p = pageEls.get(n);
        const page = await pdfDoc.getPage(n);
        const drawnAt = scale;
        const viewport = page.getViewport({ scale });
        p.canvas.width = Math.floor(viewport.width);
        p.canvas.height = Math.floor(viewport.height);
        // Count the backing store from the moment it EXISTS, not when the render lands:
        // bytes the budget cannot see are bytes eviction cannot reach, and at 3x the
        // paints in flight while scrolling are 30 MiB each — they doubled the live total.
        painted.delete(n); painted.add(n);      // re-insert: Set iterates least-recent first
        enforceCanvasBudget(n);
        const task = page.render({ canvasContext: p.canvas.getContext('2d'), viewport });
        tasks.set(n, task);
        await task.promise;
        tasks.delete(n);
        // pdf.js 3.x requires `textContent`, not `textContentStream`, and returns either
        // {promise} or a bare promise depending on the build — handle both.
        const textContent = await page.getTextContent();
        // A re-scale landed after the canvas drew: setScale has already released this page,
        // and spans laid out for the old scale would sit off the glyphs a later paint draws.
        if (drawnAt !== scale) return false;
        const divs = [];
        p.textLayer.innerHTML = '';
        const layerTask = pdfjsLib.renderTextLayer({
            textContent,
            container: p.textLayer,
            viewport,
            textDivs: divs,
        });
        await (layerTask && layerTask.promise ? layerTask.promise : layerTask);
        textDivs.set(n, divs);
        return true;
    }

    /**
     * Render page `n`. Resolves `true`/`false` and NEVER rejects; a failed page stays
     * retryable on the next call (defect D1). Concurrent calls share one promise.
     * @returns {Promise<boolean>}
     */
    function renderPage(n) {
        const st = states.get(n);
        if (!st || !pdfDoc) return Promise.resolve(false);
        if (st.status === 'done') return Promise.resolve(true);
        if (st.status === 'rendering' && st.promise) return st.promise;

        st.status = 'rendering';
        st.promise = paintPage(n).then(
            () => { st.status = 'done'; applyReading(n); return true; },
            err => {
                if (err?.name !== 'RenderingCancelledException') warn(`page ${n} render failed (retryable)`, err);   // setScale cancels on purpose
                tasks.delete(n);
                releaseCanvas(n);
                st.status = 'error'; st.promise = null;   // next call retries from scratch
                return false;
            },
        );
        return st.promise;
    }

    /** Cancel page `n`'s render, or with no argument every live one. Each rejects into
     *  renderPage's retryable path, so a cancelled page repaints when next asked for. */
    function cancelTasks(n) {
        for (const page of n === undefined ? [...tasks.keys()] : [n]) {
            const task = tasks.get(page);
            if (!task) continue;
            tasks.delete(page);
            try { task.cancel(); } catch (err) { warn('render cancel', err); }
        }
    }

    // ── Reading highlight ─────────────────────────────────────────────────────
    const readingPages = () => (reading || []).map(part => part.page);

    function applyReading(n) {
        const divs = textDivs.get(n);
        if (!divs) return;
        for (const part of reading || []) {
            if (part.page !== n) continue;
            for (const i of part.items) if (divs[i]) divs[i].classList.add(HL_CLASS);
        }
    }

    /** Remove the reading highlight from every page. Safe to call at any time. */
    function clearHighlights() {
        reading = null;
        if (!root) return;
        for (const el of root.querySelectorAll(`.textLayer .${HL_CLASS}`)) el.classList.remove(HL_CLASS);
    }

    /**
     * Paint the reading highlight on each part's page at its `items` -- a sentence over a
     * page turn has two (N4) -- remembering the request so it survives a later render or a
     * scale change. Parts with no items or an unknown page are dropped. NEVER throws.
     * @param {Array<{page:number, items:number[]}>} spans start page first
     * @returns {boolean} true when the start page's spans were painted now
     */
    function highlightSpans(spans) {
        try {
            clearHighlights();
            const parts = (Array.isArray(spans) ? spans : [])
                .filter(part => Array.isArray(part?.items) && part.items.length && states.has(part.page));
            if (!parts.length) return false;
            reading = parts.map(part => ({ page: part.page, items: [...part.items] }));
            return reading.map(part => paintOrDefer(part.page))[0];
        } catch (err) {
            warn('highlightSpans', err);
            return false;
        }
    }

    /** One page's reading highlight: painted now (true), or when its render lands. */
    function paintOrDefer(page) {
        if (states.get(page).status === 'error') return false;
        // renderPage never rejects; applyReading runs when it lands.
        if (!textDivs.has(page)) { renderPage(page); return false; }
        applyReading(page);
        return true;
    }

    /** `highlightSpans` for a one-page sentence. */
    const highlightItems = (page, items) => highlightSpans([{ page, items }]);

    // ── Scrolling / current page ──────────────────────────────────────────────
    function offsetOf(n) {
        const p = pageEls.get(n);
        if (!p) return 0;
        return p.wrap.getBoundingClientRect().top
            - scroller.getBoundingClientRect().top + scroller.scrollTop;
    }

    function scrollToPage(n, behavior = 'smooth') {
        if (!pageEls.has(n)) return;
        scroller.scrollTo({ top: Math.max(0, offsetOf(n) - 8), behavior });
    }

    const highlightSpan = () => root && root.querySelector(`.textLayer .${HL_CLASS}`);

    /** The reading highlight's first span, else its page while those spans paint. */
    function readingEl() {
        return highlightSpan() || (reading && pageEls.get(reading[0].page)?.wrap) || null;
    }

    function scrollToHighlight(behavior = 'smooth') {
        const first = highlightSpan();
        if (first) first.scrollIntoView({ behavior, block: 'center' });
        else if (reading) scrollToPage(reading[0].page, behavior);   // setScale dropped its spans; the observer repaints it
    }

    function updateCurrentPage() {
        if (!pdfDoc) return;
        const mark = scroller.getBoundingClientRect().top
            + scroller.clientHeight * PAGE_ANCHOR_RATIO;
        for (const [n, p] of pageEls) {
            const r = p.wrap.getBoundingClientRect();
            if (r.top <= mark && r.bottom > mark && n !== current) {
                current = n;
                try { onPageChange(n); } catch (err) { warn('onPageChange', err); }
                return;
            }
        }
    }

    const onScroll = () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrentPage(); });
    };

    // ── Public: load / extract / scale / destroy ──────────────────────────────
    function teardownDoc() {
        cancelTasks();
        if (observer) { observer.disconnect(); observer = null; }
        // `root` IS the caller's container, so empty it rather than removing it —
        // removing it would delete #pdf-pages and no later document could render.
        if (root) { root.replaceChildren(); root = null; }
        pageEls = new Map(); states = new Map(); textDivs = new Map();
        painted = new Set(); reading = null; current = 1;
        if (pdfDoc) { pdfDoc.destroy().catch(err => warn('destroy', err)); pdfDoc = null; }
    }

    /**
     * Parse the PDF, lay out a placeholder per page, start lazy rendering. Rejects only when
     * the bytes are not a readable PDF.
     * @param {Uint8Array|ArrayBuffer} bytes  @returns {Promise<{numPages:number,docId:string}>}
     */
    async function load(bytes) {
        const docId = await sha1Hex(bytes);      // hash first: getDocument detaches the buffer
        teardownDoc();
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        try {
            pdfDoc = await pdfjsLib.getDocument({ data: u8.slice() }).promise;
        } catch (err) {
            warn('getDocument', err);
            throw new Error('Failed to parse PDF — is this a valid PDF file?');
        }
        await buildLayout();
        observePages();
        scroller.addEventListener('scroll', onScroll, { passive: true });
        visiblePages().forEach(renderPage);
        updateCurrentPage();
        return { numPages: pdfDoc.numPages, docId };
    }

    /** One page's raw text items in item space (the unrotated MediaBox). */
    async function pageContent(n) {
        const page = await pdfDoc.getPage(n);
        const box = page.view;
        return { items: (await page.getTextContent()).items, width: box[2] - box[0], height: box[3] - box[1] };
    }

    /**
     * Walk every page's text content → the `/api/script/build` geometry payload.
     * @param {{signal?: AbortSignal}} [opts] aborting stops the walk before its next page
     *   and rejects with the signal's reason (a newer paper superseded this one)
     */
    async function extractGeometry({ signal } = {}) {
        if (!pdfDoc) return { pages: [], stats: computeDocStats([]) };
        const total = pdfDoc.numPages;
        const pages = [], candidates = [];
        for (let n = 1; n <= total; n++) {
            signal?.throwIfAborted();                      // outside the try: a bad page is caught, an abort is not
            try {
                const { items, width, height } = await pageContent(n);
                const own = splitCandidate(items, width, height);
                candidates.push(own);
                pages.push(buildPageGeometry(items, n, width, height, own));
            } catch (err) {
                warn(`geometry for page ${n}`, err);       // one bad page must not stop the rest
                candidates.push(null);                     // ... and casts no vote on the layout
                pages.push({ page: n, width: 612, height: 792, lines: [] });
            }
            notify('extract', n, total);
        }
        // The document decides the column layout, not the page (J6). Only pages that disagree
        // with the verdict are laid out again -- 4 of 17 on PiZero, 7 of 75 on Cosmos -- so the
        // second `getTextContent` is paid for a handful of pages, never for a whole document.
        const hint = consensusSplit(candidates);
        const stale = hint === undefined ? [] : candidates.flatMap((own, i) => (own === hint ? [] : [i + 1]));
        for (const [done, n] of stale.entries()) {
            signal?.throwIfAborted();
            try {
                const { items, width, height } = await pageContent(n);
                pages[n - 1] = buildPageGeometry(items, n, width, height, hint);
            } catch (err) {
                warn(`column re-layout for page ${n}`, err);   // keep the per-page layout we have
            }
            notify('columns', done + 1, stale.length);
        }
        notify('stats', total, total);
        return { pages, stats: computeDocStats(pages) };
    }

    /** Re-lay out at a new scale and re-render what is on screen. layout.js keeps the scroll
     *  position: it anchors the page under the reader's eye, which a snap here would fight. */
    async function setScale(next) {
        if (!pdfDoc || !(next > 0) || next === scale) return;
        scale = next;
        cancelTasks();
        for (let n = 1; n <= pdfDoc.numPages; n++) {
            const page = await pdfDoc.getPage(n);
            // A resize blanks the backing store anyway, and keeping it would cost
            // (scale/oldScale)^2 bytes -- 1.7 GiB at 3x; renderPage re-paints what shows.
            releaseCanvas(n);      // also drops the text layer and orphans stale renders
            resizePage(n, page.getViewport({ scale }));
        }
        layouts += 1;
        // The observer fires on entry only, and the caller re-anchors the scroll after this
        // returns: a page in the band before and after would get no event and stay blank.
        // Observed afresh, every page is reported at the geometry the next frame shows.
        observer?.disconnect();
        for (const { wrap } of pageEls.values()) observer?.observe(wrap);
        // Kicked, not awaited. Everything a caller measures after a re-scale is CSS geometry
        // resizePage has already written; the paint is not part of the layout. pdf.js steps
        // its canvas draw loop from requestAnimationFrame, and a webview that has stopped
        // compositing delivers none -- macOS display sleep is the case we reproduced, and it
        // is not under the app's control -- so awaiting the paint hands a promise that may
        // never settle to layout.js's serialised chain and wedges every later zoom behind it.
        // Kicking instead lets the pixels land whenever frames resume.
        visiblePages().forEach(renderPage);   // renderPage handles its own failures; never rejects
    }

    function destroy() {
        scroller.removeEventListener('scroll', onScroll);
        if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
        teardownDoc();
    }

    const pageOf = n => pageEls.get(n) || null;
    const pageRectOf = p => (p
        ? { width: Math.floor(p.viewport.width), height: Math.floor(p.viewport.height) }
        : { width: 0, height: 0 });

    return {
        load, renderPage, extractGeometry, highlightSpans, highlightItems, clearHighlights,
        // pdf.js item index of a text-layer span (spans for empty items are never inserted, so DOM order is not it).
        itemIndexOf: (n, span) => (textDivs.get(n) || []).indexOf(span),
        textLayerEl: n => (pageOf(n) ? pageOf(n).textLayer : null),
        pageWrapEl: n => (pageOf(n) ? pageOf(n).wrap : null),
        pageRect: n => pageRectOf(pageOf(n)),
        scrollToPage,
        scrollToHighlight,
        readingEl,
        currentPage: () => current,
        numPages: () => (pdfDoc ? pdfDoc.numPages : 0),
        // The pdf.js document itself, for its page labels and outline (nav.js); null before a load.
        pdfDocument: () => pdfDoc,
        scale: () => scale,
        layoutGeneration: () => layouts,
        setScale,
        destroy,
    };
}

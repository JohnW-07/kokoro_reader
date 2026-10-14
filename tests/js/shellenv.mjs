// The browser the app shell runs in, faked for Node: a hand-written DOM, pdf.js serving a
// 203-page book, and a fetch that answers like the FastAPI routes. Importing it installs the
// globals, so each harness that boots main.js imports this first. Each harness runs in its
// own process (run.mjs), so they never share this state.

// ── DOM fake ──────────────────────────────────────────────────────────────────
const allEls = [];

/** Taken out of the page, as a real removal does: `document` stops finding it, and a focus
 *  inside it falls back to <body>. Never-attached nodes (a fake text layer's spans) are not. */
function detach(node) {
    if (!node?.tagName) return;
    if (node.contains(globalThis.document?.activeElement)) globalThis.document.activeElement = globalThis.document.body;
    node.parentElement = null;
    node._removed = true;
}
const isLive = (node) => { for (let n = node; n; n = n.parentElement) if (n._removed) return false; return true; };

/** `.a.b`, `#id`, `tag`, `[data-x]`; descendant selectors match on the last part. */
function matchesSimple(node, sel) {
    if (!node || !node.tagName) return false;
    const part = sel.trim().split(/\s+/).pop();
    return part.split(/(?=[.#[])/).every((token) => {
        if (token.startsWith('.')) return node._cls.has(token.slice(1));
        if (token.startsWith('#')) return node.id === token.slice(1);
        if (token.startsWith('[')) {
            const [name, raw] = token.slice(1, -1).split('=');
            const have = node.attrs[name];
            if (have === undefined) return false;
            return raw === undefined || have === raw.replace(/^["']|["']$/g, '');
        }
        return node.tagName === token.toUpperCase();
    });
}

class El {
    constructor(tag = 'div') {
        this.tagName = String(tag).toUpperCase();
        this.id = ''; this.dataset = {}; this.attrs = {}; this.children = [];
        this.parentElement = null; this._cls = new Set(); this._text = '';
        this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
        this.innerHTML = ''; this.files = null; this.isContentEditable = false;
        // <audio> surface: audionode.js builds its element with createElement.
        this.src = ''; this.currentTime = 0; this.paused = true; this.ended = false;
        this.readyState = 4; this.playbackRate = 1;
        this._on = new Map();
        this.style = {
            _custom: {},
            setProperty(k, v) { this._custom[k] = String(v); },
            getPropertyValue(k) { return this._custom[k] ?? ''; },
        };
        allEls.push(this);
    }
    get className() { return [...this._cls].join(' '); }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get classList() {
        return {
            add: (...c) => c.forEach((x) => this._cls.add(x)),
            remove: (...c) => c.forEach((x) => this._cls.delete(x)),
            contains: (c) => this._cls.has(c),
            toggle: (c, on) => (on === undefined
                ? (this._cls.has(c) ? this._cls.delete(c) : this._cls.add(c))
                : (on ? this._cls.add(c) : this._cls.delete(c))),
        };
    }
    get textContent() {
        return this._text + this.children.map((c) => c.textContent ?? '').join('');
    }
    set textContent(v) { this.children.forEach(detach); this.children = []; this._text = String(v); }
    get innerHTML() { return this._html; }
    /** Markup becomes one flat child per classed element, so `querySelector('.x')` finds it. */
    set innerHTML(v) {
        this._html = String(v);
        const parsed = [...this._html.matchAll(/<(\w+)[^>]*?class="([^"]*)"/g)];
        this.replaceChildren(...parsed.map(([, tag, cls]) => Object.assign(new El(tag), { className: cls })));
    }
    get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
    setAttribute(k, v) {
        this.attrs[k] = String(v);
        if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
    }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this.src = ''; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    appendChild(node) {
        if (node && node.tagName === '#FRAGMENT') { node.children.forEach((c) => this.appendChild(c)); return node; }
        if (node && node.tagName) Object.assign(node, { parentElement: this, _removed: false });
        this.children.push(node);
        return node;
    }
    append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
    replaceChildren(...nodes) { this.children.forEach(detach); this.children = []; nodes.forEach((n) => this.appendChild(n)); }
    remove() {
        const kids = this.parentElement?.children;
        if (kids) kids.splice(kids.indexOf(this), 1);
        detach(this);
    }
    descendants() { return this.children.flatMap((c) => (c.descendants ? [c, ...c.descendants()] : [])); }
    querySelectorAll(sel) { return this.descendants().filter((n) => matchesSimple(n, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(type, fn) { this._on.set(type, [...(this._on.get(type) || []), fn]); }
    removeEventListener(type, fn) { this._on.set(type, (this._on.get(type) || []).filter((f) => f !== fn)); }
    dispatch(type, event = {}) {
        const ev = { type, target: this, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, defaultPrevented: false, ...event };
        (this._on.get(type) || []).forEach((fn) => fn(ev));
        return ev;
    }
    getContext() { return {}; }
    getBoundingClientRect() { return { top: 0, bottom: 800, left: 0, right: 600, width: 600, height: 800 }; }
    scrollIntoView() {}
    scrollTo() {}
    focus() { globalThis.document.activeElement = this; }
    blur() {}
    closest(sel) {
        const parts = sel.split(',');
        for (let n = this; n; n = n.parentElement) if (parts.some((part) => matchesSimple(n, part))) return n;
        return null;
    }
    contains(node) {
        for (let n = node; n; n = n.parentElement) if (n === this) return true;
        return false;
    }
    /**
     * Bubbles to ancestors, like a real click, so delegated listeners see it, and
     * honours stopPropagation. With `bubbles: true` it goes on to `document`, as a
     * key event from any element of a real page would.
     */
    dispatchEvent(event) {
        let stopped = false;
        // One `defaultPrevented` for the whole trip, so `document` sees what the target did.
        const shared = {
            ...event, target: this, stopPropagation() { stopped = true; },
            preventDefault() { shared.defaultPrevented = true; }, defaultPrevented: false,
        };
        const deliver = (fns) => (fns || []).forEach((fn) => fn(shared));
        for (let n = this; n && !stopped; n = n.parentElement) deliver(n._on.get(event.type));
        if (event.bubbles && !stopped) deliver(listeners.get(event.type));
        return true;
    }
    click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
}

const byId = new Map();
const body = new El('body');
function mk(tag, id, extra = {}) {
    const node = new El(tag);
    node.id = id;
    Object.assign(node, extra);
    byId.set(id, node);
    return node;
}

/** The ids and classes index.html actually declares. */
// 'notes-panel' is the highlights list's mount point: out of the sidebar (R7), into the notes column (R3).
const IDS = ['status-bar', 'toast', 'toc-section', 'llm-hint',
    'prevBtn', 'ppBtn', 'nextBtn', 'recoverBtn', 'rebuildBtn', 'speedSlider',
    'speedVal', 'drop-zone', 'page-pill', 'welcome', 'pdf-pages', 'notes-panel', 'read-options',
    'sidebar', 'collapseBtn', 'content-area', 'notes-column', 'bufferbar', 'toc-panel', 'view-status', 'page-go',
    'status-field'];
IDS.forEach((id) => mk('div', id));
// R3: the Highlights list heads the notes column; R4: the meter shares the status field.
byId.get('notes-column').appendChild(byId.get('notes-panel'));
byId.get('status-field').append(byId.get('status-bar'), byId.get('bufferbar'));
byId.get('toc-section').hidden = true;   // as index.html ships it: no paper, no contents
mk('button', 'followBtn');
mk('input', 'smoothScrollBox', { checked: true });
mk('button', 'notesToggleBtn');
byId.get('content-area').appendChild(byId.get('pdf-pages'));
// The rail: expand, then one proxy per sidebar control, then the speed stepper.
const rail = mk('nav', 'rail');
const railButton = (id, data) => {
    const b = mk('button', id);
    Object.entries(data).forEach(([k, v]) => b.setAttribute(`data-${k}`, v));
    rail.appendChild(b);
    return b;
};
railButton('expandBtn', { action: 'expand' });
railButton('railPpBtn', { proxy: 'ppBtn' });
railButton('railPrevBtn', { proxy: 'prevBtn' });
railButton('railNextBtn', { proxy: 'nextBtn' });
railButton('railSpeedBtn', { action: 'speed' });
railButton('railFollowBtn', { proxy: 'followBtn' });
mk('input', 'file-input');
mk('input', 'page-go-input');
const voiceSelect = mk('select', 'voiceSelect');
const llmRow = mk('label', 'llm-row');
llmRow.appendChild(new El('input'));
['af_aoede', 'af_alloy', 'af_heart', 'af_bella', 'am_puck', 'bf_alice', 'bm_george'].forEach((v) => {
    const opt = new El('option');
    opt.value = v; opt.textContent = `${v} — a voice`;
    voiceSelect.appendChild(opt);
});
['read_headings', 'read_equations', 'read_captions', 'read_tables', 'read_footnotes',
    'read_references', 'use_llm'].forEach((name) => {
    const box = new El('input');
    box.setAttribute('data-opt', name);
    byId.get('read-options').appendChild(box);
});
['read', 'subs', 'summary', 'settings'].forEach((name) => {
    const tab = new El('button');
    tab.className = 'tab';
    tab.setAttribute('data-tab', name);
    const panel = mk('section', `tab-${name}`);
    panel.className = 'tab-panel';
    body.append(tab, panel);
});

const listeners = new Map();
const on = (map, type, fn) => map.set(type, [...(map.get(type) || []), fn]);

globalThis.document = {
    body,
    createElement: (t) => new El(t),
    createDocumentFragment: () => new El('#fragment'),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [] }),
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (sel) => allEls.filter((n) => matchesSimple(n, sel) && isLive(n)),
    querySelector: (sel) => allEls.find((n) => matchesSimple(n, sel) && isLive(n)) || null,
    addEventListener: (t, fn) => on(listeners, t, fn),
    removeEventListener: () => {},
};
document.dispatch = (type, event = {}) => {
    const ev = { type, target: body, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, defaultPrevented: false, ...event };
    (listeners.get(type) || []).forEach((fn) => fn(ev));
    return ev;
};

// Browsers escape selector values with CSS.escape; the fake ids need no escaping.
globalThis.CSS = { escape: (value) => String(value) };

const windowListeners = new Map();
globalThis.window = {
    innerWidth: 1280, innerHeight: 900,
    getSelection: () => null,
    addEventListener: (t, fn) => on(windowListeners, t, fn),
    removeEventListener: () => {},
    open: () => {},
};
window.dispatch = (type, event = {}) => {
    const ev = { type, target: window, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, defaultPrevented: false, ...event };
    (windowListeners.get(type) || []).forEach((fn) => fn(ev));
    return ev;
};

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
/** One list per media query, unmatched (a wide window) until a harness resizes across it. */
const mediaLists = new Map();
globalThis.matchMedia = (query) => {
    if (!mediaLists.has(query)) {
        const fns = [];
        mediaLists.set(query, { matches: false, media: query, addEventListener: (t, fn) => { if (t === 'change') fns.push(fn); }, fns });
    }
    return mediaLists.get(query);
};
/** Resize the window across `query`'s edge, as a drag to half the screen would. */
const resizeAcross = (query, matches) => {
    const list = globalThis.matchMedia(query);
    list.matches = matches;
    list.fns.forEach((fn) => fn({ matches, media: query }));
};
globalThis.getComputedStyle = () => ({ overflowY: 'visible' });
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => {};

/** Reads a file in `file._readMs` (default: next task), so a harness can make one read slow. */
/** Reads `file._bytes` after `file._readMs`; a `file._readError` fails the read instead. */
class FakeFileReader {
    readAsArrayBuffer(file) {
        this.result = file._readError ? null : file._bytes.buffer;
        setTimeout(() => (file._readError ? this.onerror : this.onload)?.({ target: this }), file._readMs);
    }
}
globalThis.FileReader = FakeFileReader;

// ── pdf.js fake: a 203-page book ──────────────────────────────────────────────
const N_PAGES = 203;
/** A hook that can hold every page's text extraction, to park a build inside pdf.js. */
export const pdf = { beforeText: null };
const textContent = { items: [{ str: 'Estimators converge under the stated assumptions', width: 200, height: 10, transform: [10, 0, 0, 10, 72, 700] }] };
const makePage = () => ({
    view: [0, 0, 612, 792],
    getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale, scale }),
    getTextContent: async () => {
        if (pdf.beforeText) await pdf.beforeText();
        return textContent;
    },
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
});
globalThis.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({ numPages: N_PAGES, getPage: async () => makePage(), destroy: async () => {} }) }),
    renderTextLayer: ({ textDivs }) => { textDivs.push(new El('span')); return { promise: Promise.resolve() }; },
};

// ── fetch fake ────────────────────────────────────────────────────────────────
const ALL_VOICES = [
    'af_aoede', 'af_alloy', 'af_heart', 'af_bella', 'am_puck', 'bf_alice', 'bm_george',
    'ef_dora', 'em_alex', 'ff_siwis', 'hf_alpha', 'hm_omega', 'if_sara',
    'jf_alpha', 'jm_kumo', 'pf_dora', 'pm_santa', 'zf_xiaobei', 'zm_yunjian',
];
const SERVER_MAX_PAGES = 80;           // routes/script.py MAX_PAGES_PER_REQUEST
const scriptCalls = [];
let savedNotes = [];
/** Knobs a harness turns on the fake server: a page it leaves out, a hook that can hold a build. */
export const server = { skipPage: 0, beforeBuild: null };

const json = (body) => ({ ok: true, status: 200, json: async () => body });
/** The pages a build owns (N4): the rest are context, built but not returned, as in the route. */
const ownedPages = (payload) => (payload.own_from == null ? payload.pages
    : payload.pages.filter((p) => p.page >= payload.own_from && p.page <= payload.own_to));

const fetchLog = [];
globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    fetchLog.push(path);
    if (path.startsWith('/api/health')) return json({ ok: true, tts_ready: true, llm_available: false, llm_model: '' });
    if (path.startsWith('/api/voices')) return json({ voices: ALL_VOICES });
    if (path.startsWith('/api/script/build')) {
        const payload = JSON.parse(init.body);
        scriptCalls.push(payload);
        if (server.beforeBuild) await server.beforeBuild(payload, init);
        if (payload.pages.length > SERVER_MAX_PAGES) {
            return { ok: false, status: 400, json: async () => ({ detail: `Too many pages in one request (max ${SERVER_MAX_PAGES})` }) };
        }
        const sentences = ownedPages(payload).filter((p) => p.page !== server.skipPage).map((p) => ({
            text: `Page ${p.page} says something.`, raw: 'raw', page: p.page, kind: 'body', items: [0], source: 'rules',
        }));
        // The route always returns `blocks`; the client must not retain them (M12).
        const blocks = ownedPages(payload).map((p) => ({
            kind: 'table', speak: false, page: p.page, items: [0],
            text: 'x'.repeat(400), spoken: '', reason: '3 aligned columns',
        }));
        return json({ doc_id: payload.doc_id, sentences, blocks, stats: { blocks: blocks.length, sentences: sentences.length, skipped: { table: blocks.length }, skipped_total: blocks.length, llm_used: 0 } });
    }
    if (/\/api\/notes\//.test(path) && init.method === 'PUT') {
        savedNotes.push(JSON.parse(init.body));
        return json(JSON.parse(init.body));
    }
    if (/\/api\/notes\//.test(path)) return json({ doc_id: 'x', title: '', highlights: [], last_index: 0, options: {} });
    return json({});
};

export {
    El, byId, body, listeners, rail, voiceSelect, N_PAGES, SERVER_MAX_PAGES, makePage,
    scriptCalls, fetchLog, savedNotes, resizeAcross, ownedPages,
};

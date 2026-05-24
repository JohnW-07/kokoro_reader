import os
import uuid
import threading
import uvicorn
import webview
from fastapi import FastAPI, Response, HTTPException
from fastapi.responses import HTMLResponse
from kokoro_mlx import KokoroTTS

app = FastAPI()

print("🚀 Loading native Kokoro-MLX model weights onto Apple Silicon...")
tts = KokoroTTS.from_pretrained("mlx-community/Kokoro-82M-bf16")


@app.get("/tts")
async def get_tts(text: str, voice: str, speed: float = 1.0):
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    temp_filename = f"stream_{uuid.uuid4().hex}.wav"
    try:
        tts.save(text, temp_filename, voice=voice, speed=speed)
        with open(temp_filename, "rb") as f:
            audio_bytes = f.read()
        return Response(content=audio_bytes, media_type="audio/wav")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_filename):
            os.remove(temp_filename)


@app.get("/", response_class=HTMLResponse)
async def get_ui():
    return HTML_PAGE


HTML_PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kokoro Space Reader</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <style>
        :root {
            --bg:           #0f0f11;
            --panel:        #16161a;
            --border:       #252530;
            --input-bg:     #1e1e25;
            --text:         #e2e8f0;
            --text-muted:   #7a849a;
            --accent:       #4f8ef7;
            --accent-hover: #3b7af0;
            --accent-dim:   rgba(79,142,247,0.12);
            --success:      #22c55e;
            --danger:       #ef4444;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: var(--bg);
            color: var(--text);
            display: flex;
            height: 100vh;
            overflow: hidden;
        }

        /* ── Sidebar ─────────────────────────────────────────── */
        #sidebar {
            width: 300px;
            min-width: 300px;
            background: var(--panel);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        #sidebar-top {
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            border-bottom: 1px solid var(--border);
        }

        #app-title {
            font-size: 1rem;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .pill {
            font-size: 0.58rem;
            font-weight: 700;
            background: var(--accent);
            color: #fff;
            padding: 2px 6px;
            border-radius: 10px;
            text-transform: uppercase;
            letter-spacing: 0.06em;
        }

        #drop-zone {
            border: 1.5px dashed var(--border);
            border-radius: 7px;
            padding: 12px 10px;
            text-align: center;
            cursor: pointer;
            transition: all 0.15s;
            font-size: 0.82rem;
            color: var(--text-muted);
            -webkit-app-region: no-drag !important;
        }
        #drop-zone:hover, #drop-zone.hover {
            border-color: var(--accent);
            background: var(--accent-dim);
            color: var(--accent);
        }
        #drop-zone.loaded {
            border-color: var(--success);
            border-style: solid;
            background: rgba(34,197,94,0.07);
            color: var(--success);
        }
        #file-input { display: none; }

        #status-bar {
            background: var(--input-bg);
            border-radius: 6px;
            padding: 7px 10px;
            font-size: 0.78rem;
            color: var(--text-muted);
            min-height: 32px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        #status-bar.loading { color: var(--accent); }
        #status-bar.error   { color: var(--danger); }

        .spinner {
            width: 11px; height: 11px;
            border: 2px solid rgba(79,142,247,0.25);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.65s linear infinite;
            flex-shrink: 0;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .label {
            font-size: 0.68rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--text-muted);
        }

        select {
            width: 100%;
            padding: 8px 10px;
            background: var(--input-bg);
            border: 1px solid var(--border);
            color: var(--text);
            border-radius: 6px;
            font-size: 0.83rem;
            cursor: pointer;
            -webkit-app-region: no-drag !important;
        }
        select:focus { outline: none; border-color: var(--accent); }

        .speed-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        input[type="range"] {
            flex: 1;
            appearance: none;
            height: 3px;
            background: var(--border);
            border-radius: 2px;
            -webkit-app-region: no-drag !important;
        }
        input[type="range"]::-webkit-slider-thumb {
            appearance: none;
            width: 13px; height: 13px;
            border-radius: 50%;
            background: var(--accent);
            cursor: pointer;
        }
        #speedVal {
            font-size: 0.8rem;
            min-width: 34px;
            text-align: right;
            color: var(--text-muted);
        }

        #transport { display: flex; gap: 6px; }
        .t-btn {
            flex: 1;
            padding: 9px 0;
            background: var(--input-bg);
            border: 1px solid var(--border);
            color: var(--text);
            border-radius: 7px;
            cursor: pointer;
            font-size: 0.95rem;
            transition: all 0.12s;
            -webkit-app-region: no-drag !important;
        }
        .t-btn:hover:not(:disabled) { background: #2a2a35; border-color: var(--accent); }
        .t-btn:disabled { opacity: 0.28; cursor: not-allowed; }
        #playPauseBtn {
            flex: 1.5;
            background: var(--accent);
            border-color: transparent;
            color: #fff;
            font-size: 1.1rem;
        }
        #playPauseBtn:hover:not(:disabled) { background: var(--accent-hover); }

        #kbd-hints {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            font-size: 0.7rem;
            color: var(--text-muted);
        }
        .kbd {
            background: var(--input-bg);
            border: 1px solid var(--border);
            border-radius: 3px;
            padding: 1px 4px;
            font-family: monospace;
            font-size: 0.68rem;
        }

        /* Feed */
        #feed-section {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding: 10px 14px 14px;
        }
        #feed-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        #feed-count { font-size: 0.72rem; color: var(--text-muted); }
        #sentence-feed {
            flex: 1;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 3px;
        }
        #sentence-feed::-webkit-scrollbar { width: 3px; }
        #sentence-feed::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

        .feed-item {
            padding: 7px 9px;
            border-radius: 5px;
            cursor: pointer;
            border-left: 2px solid transparent;
            color: var(--text-muted);
            font-size: 0.8rem;
            line-height: 1.45;
            transition: all 0.1s;
        }
        .feed-item:hover { background: var(--input-bg); color: var(--text); }
        .feed-item.active {
            background: var(--accent-dim);
            border-left-color: var(--accent);
            color: var(--text);
        }
        .feed-pg {
            font-size: 0.67rem;
            font-weight: 700;
            color: var(--accent);
            margin-right: 4px;
        }

        /* ── Content area ────────────────────────────────────── */
        #content-area {
            flex: 1;
            background: #18181d;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20px 20px 40px;
            position: relative;
        }
        #content-area::-webkit-scrollbar { width: 5px; }
        #content-area::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

        #page-pill {
            position: sticky;
            top: 6px;
            align-self: flex-end;
            background: rgba(22,22,26,0.88);
            backdrop-filter: blur(10px);
            border: 1px solid var(--border);
            border-radius: 20px;
            padding: 4px 12px;
            font-size: 0.75rem;
            color: var(--text-muted);
            z-index: 20;
            pointer-events: none;
            display: none;
        }

        #welcome {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 14px;
            flex: 1;
            color: var(--text-muted);
            text-align: center;
            padding: 40px;
        }
        #welcome .icon { font-size: 2.8rem; }
        #welcome h2 { font-size: 1.2rem; color: var(--text); font-weight: 600; }
        #welcome p { font-size: 0.82rem; line-height: 1.65; max-width: 280px; }

        #pdf-pages {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 18px;
            width: 100%;
            max-width: 880px;
        }

        .pdf-page-wrap {
            position: relative;
            background: white;
            border-radius: 3px;
            box-shadow: 0 6px 28px rgba(0,0,0,0.55);
            flex-shrink: 0;
            overflow: hidden;
        }

        .pdf-page-wrap canvas {
            display: block;
            position: absolute;
            top: 0; left: 0;
            z-index: 1;
        }

        .textLayer {
            position: absolute;
            top: 0; left: 0;
            z-index: 2;
            overflow: hidden;
            pointer-events: none;
        }

        .textLayer span {
            color: transparent;
            position: absolute;
            white-space: pre;
            transform-origin: 0% 0%;
            border-radius: 2px;
            transition: background 0.08s ease;
        }

        .textLayer .hl {
            background: rgba(79,142,247,0.38) !important;
            box-shadow: 0 0 0 1px rgba(79,142,247,0.25);
        }
    </style>
</head>
<body>
    <div id="sidebar">
        <div id="sidebar-top">
            <div id="app-title">🎙 Kokoro Space <span class="pill">MLX</span></div>

            <div id="drop-zone" onclick="document.getElementById('file-input').click()">
                📄 Drop a PDF here or click to browse
            </div>
            <input type="file" id="file-input" accept="application/pdf">

            <div id="status-bar">No document loaded</div>

            <div style="display:flex;flex-direction:column;gap:4px;">
                <span class="label">Voice</span>
                <select id="voiceSelect" onchange="onVoiceChange()">
                    <option value="af_heart">af_heart — Female · US · Warm</option>
                    <option value="af_bella">af_bella — Female · US · Expressive</option>
                    <option value="af_sarah">af_sarah — Female · US · Clear</option>
                    <option value="am_fenrir">am_fenrir — Male · US · Clean</option>
                    <option value="am_puck">am_puck — Male · US · Dynamic</option>
                    <option value="bf_alice">bf_alice — Female · UK · Professional</option>
                    <option value="bm_daniel">bm_daniel — Male · UK · Deep</option>
                    <option value="bm_george">bm_george — Male · UK · Formal</option>
                </select>
            </div>

            <div style="display:flex;flex-direction:column;gap:4px;">
                <span class="label">Speed</span>
                <div class="speed-row">
                    <input type="range" id="speedSlider" min="0.5" max="2.0" step="0.05" value="1.0">
                    <span id="speedVal">1.0×</span>
                </div>
            </div>

            <div id="transport">
                <button class="t-btn" id="prevBtn"      onclick="prevSentence()" disabled title="Previous (←)">⏮</button>
                <button class="t-btn" id="playPauseBtn" onclick="togglePlay()"   disabled title="Play / Pause (Space)">▶</button>
                <button class="t-btn" id="nextBtn"      onclick="nextSentence()" disabled title="Next (→)">⏭</button>
                <button class="t-btn" id="snapBtn"      onclick="snapToActive()" disabled title="Snap to sentence (S)" style="font-size:0.8rem;">🎯</button>
            </div>

            <div id="kbd-hints">
                <span><span class="kbd">Space</span> Play/Pause</span>
                <span><span class="kbd">←</span><span class="kbd">→</span> Prev / Next</span>
                <span><span class="kbd">S</span> Snap</span>
            </div>
        </div>

        <div id="feed-section">
            <div id="feed-header">
                <span class="label">Sentence Queue</span>
                <span id="feed-count"></span>
            </div>
            <div id="sentence-feed"></div>
        </div>
    </div>

    <div id="content-area">
        <div id="page-pill">Page — / —</div>
        <div id="welcome">
            <div class="icon">📚</div>
            <h2>Kokoro Space Reader</h2>
            <p>Drop a research PDF in the sidebar. The AI will read it aloud and highlight each sentence as it goes.</p>
        </div>
        <div id="pdf-pages"></div>
    </div>

    <audio id="audioPlayer" style="display:none;"></audio>

    <script>
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        // ── State ────────────────────────────────────────────────
        let pdfDoc          = null;
        let sentences       = [];
        let currentIndex    = 0;
        let pageRenderState = {};
        let pageTextDivs    = {};   // pageNum → span[] parallel to tc.items
        let audioCache      = {};
        let iObserver       = null;
        let isPlaying       = false;
        let isLoading       = false;
        const PRELOAD       = 3;

        // ── DOM refs ─────────────────────────────────────────────
        const audio       = document.getElementById('audioPlayer');
        const speedSlider = document.getElementById('speedSlider');
        const dropZone    = document.getElementById('drop-zone');
        const contentArea = document.getElementById('content-area');
        const pdfPages    = document.getElementById('pdf-pages');
        const statusBar   = document.getElementById('status-bar');
        const pagePill    = document.getElementById('page-pill');
        const welcome     = document.getElementById('welcome');
        const prevBtn     = document.getElementById('prevBtn');
        const nextBtn     = document.getElementById('nextBtn');
        const ppBtn       = document.getElementById('playPauseBtn');
        const snapBtn     = document.getElementById('snapBtn');

        // ── File input ───────────────────────────────────────────
        document.getElementById('file-input').addEventListener('change', e => {
            const f = e.target.files[0];
            if (f) readFile(f);
            e.target.value = '';  // allow re-selecting the same file
        });

        ['dragenter', 'dragover'].forEach(ev =>
            dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('hover'); })
        );
        ['dragleave', 'drop'].forEach(ev =>
            dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('hover'); })
        );
        dropZone.addEventListener('drop', e => {
            const f = e.dataTransfer.files[0];
            if (f && f.type === 'application/pdf') readFile(f);
        });

        function readFile(file) {
            const reader = new FileReader();
            reader.onload = function() { loadPDF(new Uint8Array(this.result), file.name); };
            reader.readAsArrayBuffer(file);
        }

        // ── Status ───────────────────────────────────────────────
        function setStatus(msg, type = '') {
            statusBar.className = type;
            statusBar.innerHTML = type === 'loading'
                ? `<div class="spinner"></div> ${msg}`
                : msg;
        }

        // ── Voice change ─────────────────────────────────────────
        function onVoiceChange() {
            clearCache();
            setStatus('Voice changed — audio cache cleared');
        }

        // ── Text cleaning ────────────────────────────────────────
        function cleanText(raw) {
            let t = raw;
            t = t.replace(/\[[^\]]{0,20}\]/g, '');
            t = t.replace(/\([^)]{0,60}\b\d{4}[^)]{0,20}\)/g, '');
            const abbrevs = [
                [/et\s+al\.\s*/gi,   'et al '],
                [/i\.e\./gi,          'that is,'],
                [/e\.g\./gi,          'for example,'],
                [/Fig\.\s*/gi,        'Figure '],
                [/Eq\.\s*/gi,         'Equation '],
                [/vs\.\s*/gi,         'versus '],
                [/approx\.\s*/gi,     'approximately '],
                [/Sec\.\s*/gi,        'Section '],
                [/Ref\.\s*/gi,        'Reference '],
            ];
            abbrevs.forEach(([re, rep]) => { t = t.replace(re, rep); });
            return t.trim().replace(/\s+/g, ' ');
        }

        // ── Load PDF ─────────────────────────────────────────────
        async function loadPDF(data, name = 'document') {
            setStatus(`Parsing "${name}"…`, 'loading');
            clearCache();
            resetPlayer();

            if (iObserver) iObserver.disconnect();
            sentences       = [];
            pageRenderState = {};
            pageTextDivs    = {};
            pdfPages.innerHTML = '';
            welcome.style.display = 'none';
            pagePill.style.display = '';

            try {
                pdfDoc = await pdfjsLib.getDocument({ data }).promise;
            } catch {
                setStatus('Failed to parse PDF — is this a valid PDF file?', 'error');
                return;
            }

            const SCALE = 1.4;

            // Build a placeholder container per page (each with its true dimensions)
            for (let i = 1; i <= pdfDoc.numPages; i++) {
                const page = await pdfDoc.getPage(i);
                const vp   = page.getViewport({ scale: SCALE });
                const w    = Math.floor(vp.width), h = Math.floor(vp.height);

                const wrap = document.createElement('div');
                wrap.className = 'pdf-page-wrap';
                wrap.id        = `wrap-${i}`;
                wrap.dataset.page = i;
                wrap.style.width  = w + 'px';
                wrap.style.height = h + 'px';

                const canvas = document.createElement('canvas');
                canvas.id = `canvas-${i}`;
                canvas.width = w; canvas.height = h;
                canvas.style.width = w + 'px'; canvas.style.height = h + 'px';

                const tl = document.createElement('div');
                tl.id = `tl-${i}`;
                tl.className = 'textLayer';
                tl.style.width = w + 'px'; tl.style.height = h + 'px';

                wrap.appendChild(canvas);
                wrap.appendChild(tl);
                pdfPages.appendChild(wrap);

                pageRenderState[i] = { status: 'idle', promise: null };
            }

            setupLazyRender();

            setStatus('Extracting sentences…', 'loading');
            for (let i = 1; i <= pdfDoc.numPages; i++) {
                const page = await pdfDoc.getPage(i);
                const tc   = await page.getTextContent();
                extractSentences(tc, i);
            }

            renderFeed();
            setControlsEnabled(true);
            dropZone.textContent = `📄 ${name}`;
            dropZone.className = 'loaded';
            setStatus(`Ready — ${sentences.length} sentences across ${pdfDoc.numPages} pages`);
            updatePagePill();
            playSentence(0, true);
        }

        // ── Sentence extraction ───────────────────────────────────
        function extractSentences(tc, pageNum) {
            let buf = '', startIdx = -1;

            tc.items.forEach((item, idx) => {
                if (!item.str.trim()) return;
                if (startIdx === -1) startIdx = idx;
                buf += item.str + ' ';

                const ends = /[.!?]$/.test(item.str.trim());
                const last = idx === tc.items.length - 1;

                if (ends || last) {
                    const raw   = buf.trim().replace(/\s+/g, ' ');
                    const clean = cleanText(raw);
                    if (raw.length > 10 && !/^\d+$/.test(raw) && clean.length > 5) {
                        sentences.push({ raw, clean, pageNum, startIdx, endIdx: idx });
                    }
                    buf = ''; startIdx = -1;
                }
            });
        }

        // ── Lazy page rendering ───────────────────────────────────
        function setupLazyRender() {
            iObserver = new IntersectionObserver(entries => {
                entries.forEach(e => {
                    if (e.isIntersecting) renderPage(parseInt(e.target.dataset.page));
                });
            }, { root: contentArea, rootMargin: '800px 0px 800px 0px', threshold: 0.01 });

            pdfPages.querySelectorAll('.pdf-page-wrap').forEach(el => iObserver.observe(el));
        }

        async function renderPage(num) {
            const s = pageRenderState[num];
            if (!s || s.status === 'done') return;
            if (s.status === 'rendering') return s.promise;

            s.status  = 'rendering';
            s.promise = (async () => {
                const page     = await pdfDoc.getPage(num);
                const SCALE    = 1.4;
                const viewport = page.getViewport({ scale: SCALE });

                const canvas = document.getElementById(`canvas-${num}`);
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

                // BUG FIX: pdf.js 3.x requires `textContent`, not `textContentStream`.
                // Capture the textDivs array — it is populated 1:1 with tc.items and is
                // the only reliable way to map item indices to DOM spans for highlighting.
                const tl   = document.getElementById(`tl-${num}`);
                const tc   = await page.getTextContent();
                const divs = [];
                await pdfjsLib.renderTextLayer({
                    textContent: tc,
                    container: tl,
                    viewport,
                    textDivs: divs
                }).promise;
                pageTextDivs[num] = divs;

                s.status = 'done';
            })();

            return s.promise;
        }

        // ── Page pill ─────────────────────────────────────────────
        // BUG FIX: listener registered once at module level, NOT inside loadPDF
        contentArea.addEventListener('scroll', updatePagePill);

        function updatePagePill() {
            if (!pdfDoc) return;
            const mid = contentArea.scrollTop + contentArea.clientHeight * 0.35;
            for (const wrap of pdfPages.children) {
                if (wrap.offsetTop <= mid && wrap.offsetTop + wrap.offsetHeight > mid) {
                    pagePill.textContent = `Page ${wrap.dataset.page} / ${pdfDoc.numPages}`;
                    break;
                }
            }
        }

        // ── Feed ──────────────────────────────────────────────────
        function renderFeed() {
            document.getElementById('feed-count').textContent = sentences.length;
            const feed = document.getElementById('sentence-feed');
            feed.innerHTML = sentences.map((s, idx) => {
                // BUG FIX: only add ellipsis when text actually exceeds the preview length
                const preview = s.clean.length > 68
                    ? s.clean.slice(0, 68) + '…'
                    : s.clean;
                return `<div class="feed-item" id="fi-${idx}" onclick="jumpTo(${idx})">` +
                       `<span class="feed-pg">P${s.pageNum}</span>${preview}</div>`;
            }).join('');
        }

        function syncFeed() {
            document.querySelectorAll('.feed-item').forEach(el => el.classList.remove('active'));
            const el = document.getElementById(`fi-${currentIndex}`);
            if (el) {
                el.classList.add('active');
                el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        // ── Audio cache ───────────────────────────────────────────
        function clearCache() {
            Object.values(audioCache).forEach(url => URL.revokeObjectURL(url));
            audioCache = {};
        }

        // ── Controls state ────────────────────────────────────────
        function setControlsEnabled(on) {
            [prevBtn, ppBtn, nextBtn, snapBtn].forEach(b => b.disabled = !on);
        }

        function resetPlayer() {
            isPlaying = false;
            isLoading = false;
            audio.pause();
            audio.src = '';
            ppBtn.textContent = '▶';
        }

        // ── Playback ──────────────────────────────────────────────
        async function playSentence(idx, scroll = false) {
            if (!sentences.length || idx < 0 || idx >= sentences.length) return;
            currentIndex = idx;
            isLoading    = true;
            ppBtn.disabled = true;

            const s = sentences[idx];
            setStatus(`Loading sentence ${idx + 1} / ${sentences.length}…`, 'loading');

            await renderPage(s.pageNum);
            applyHighlight(s);
            syncFeed();
            if (scroll) scrollToHighlight();

            const voice = document.getElementById('voiceSelect').value;
            try {
                if (!audioCache[idx]) {
                    const res = await fetch(
                        `/tts?text=${encodeURIComponent(s.clean)}&voice=${voice}`
                    );
                    if (!res.ok) throw new Error(`Server error ${res.status}`);
                    audioCache[idx] = URL.createObjectURL(await res.blob());
                }

                audio.src = audioCache[idx];
                audio.playbackRate = parseFloat(speedSlider.value);
                isLoading = false;
                ppBtn.disabled = false;
                setStatus(`Sentence ${idx + 1} / ${sentences.length}  ·  Page ${s.pageNum}`);

                await audio.play();
                isPlaying = true;
                ppBtn.textContent = '⏸';
            } catch (err) {
                isLoading = false;
                isPlaying = false;
                ppBtn.disabled = false;
                ppBtn.textContent = '▶';
                if (err.name === 'NotAllowedError') {
                    setStatus('Autoplay blocked — press Play or Space to start');
                } else {
                    setStatus(`Error: ${err.message}`, 'error');
                }
            }

            preloadAhead(idx);
        }

        function preloadAhead(from) {
            const voice = document.getElementById('voiceSelect').value;
            for (let i = 1; i <= PRELOAD; i++) {
                const idx = from + i;
                if (idx >= sentences.length || audioCache[idx]) continue;
                fetch(`/tts?text=${encodeURIComponent(sentences[idx].clean)}&voice=${voice}`)
                    .then(r => { if (r.ok) return r.blob(); throw 0; })
                    .then(b => { audioCache[idx] = URL.createObjectURL(b); })
                    .catch(() => {});
            }
        }

        // ── Highlight ─────────────────────────────────────────────
        function applyHighlight(sentence) {
            document.querySelectorAll('.textLayer .hl').forEach(el => el.classList.remove('hl'));
            const divs = pageTextDivs[sentence.pageNum];
            if (!divs) return;
            for (let n = sentence.startIdx; n <= sentence.endIdx; n++) {
                if (divs[n]) divs[n].classList.add('hl');
            }
        }

        function scrollToHighlight() {
            const first = document.querySelector('.textLayer .hl');
            if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // ── Transport ─────────────────────────────────────────────
        function togglePlay() {
            if (isLoading) return;
            if (isPlaying) {
                audio.pause();
            } else if (audio.src && !audio.ended) {
                audio.play();
            } else {
                playSentence(currentIndex, true);
            }
        }

        function prevSentence() {
            if (currentIndex > 0) playSentence(currentIndex - 1, true);
        }

        function nextSentence() {
            if (currentIndex < sentences.length - 1) playSentence(currentIndex + 1, true);
        }

        // BUG FIX: jumpTo no longer clears the entire cache — just pauses and seeks
        function jumpTo(idx) {
            audio.pause();
            isPlaying = false;
            playSentence(idx, true);
        }

        // BUG FIX: snapToActive only scrolls to the highlighted text, does NOT restart audio
        function snapToActive() {
            scrollToHighlight();
        }

        // ── Audio events ──────────────────────────────────────────
        audio.addEventListener('ended', () => {
            if (audioCache[currentIndex]) {
                URL.revokeObjectURL(audioCache[currentIndex]);
                delete audioCache[currentIndex];
            }
            isPlaying = false;
            if (currentIndex + 1 < sentences.length) {
                playSentence(currentIndex + 1, true);
            } else {
                ppBtn.textContent = '▶';
                setStatus('Finished reading the document ✓');
            }
        });

        audio.addEventListener('play',  () => {
            isPlaying = true;
            ppBtn.textContent = '⏸';
        });
        audio.addEventListener('pause', () => {
            isPlaying = false;
            if (!isLoading) ppBtn.textContent = '▶';
        });

        // ── Speed slider ──────────────────────────────────────────
        speedSlider.addEventListener('input', e => {
            const v = parseFloat(e.target.value);
            document.getElementById('speedVal').textContent =
                v.toFixed(2).replace(/\.?0+$/, '') + '×';
            audio.playbackRate = v;
        });

        // ── Keyboard shortcuts ────────────────────────────────────
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (e.code === 'Space')      { e.preventDefault(); togglePlay();   }
            if (e.code === 'ArrowLeft')  { e.preventDefault(); prevSentence(); }
            if (e.code === 'ArrowRight') { e.preventDefault(); nextSentence(); }
            if (e.code === 'KeyS')       { e.preventDefault(); snapToActive(); }
        });
    </script>
</body>
</html>"""


def start_server():
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")


if __name__ == "__main__":
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    webview.create_window(
        title="Kokoro Space Reader",
        url="http://127.0.0.1:8000",
        width=1400,
        height=950,
    )
    webview.start()

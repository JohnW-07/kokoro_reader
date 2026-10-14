// ── Server API ───────────────────────────────────────────────────────────────
// Thin wrappers over the FastAPI backend. Every call is time-boxed: a hung
// request must surface as an error, never as a promise that never settles.
// (That failure mode is what wedged the previous version of this app.)

const DEFAULT_TIMEOUT_MS = 20000;
const SCRIPT_TIMEOUT_MS = 180000; // classification + optional LLM over a whole paper
const SUMMARY_TIMEOUT_MS = 120000; // one on-device model call; the server gives up at 90 s

/**
 * fetch with an AbortController deadline that also honours the caller's `signal`.
 * Rejects with `.kind` 'timeout' on the deadline, 'abort' (name AbortError) on a caller abort.
 * The caller's signal is forwarded by hand, not with AbortSignal.any (Safari 17.4+ only).
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number}} [init]
 */
async function request(url, init = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    if (!res.ok) throw await httpError(res);
    return res;
  } catch (err) {
    if (err.name === 'AbortError' && signal?.aborted) {
      const e = new Error(`Request to ${url} was cancelled`);
      e.name = 'AbortError';
      e.kind = 'abort';
      throw e;
    }
    if (err.name === 'AbortError') {
      const e = new Error(`Request to ${url} timed out after ${timeoutMs} ms`);
      e.kind = 'timeout';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function httpError(res) {
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body && body.detail) detail = String(body.detail);
  } catch {
    /* body was not JSON; the status line is all we have */
  }
  const err = new Error(detail);
  err.kind = 'http';
  err.status = res.status;
  return err;
}

/** @returns {Promise<{ok:boolean, tts_ready:boolean, llm_available:boolean, llm_model:string}>} */
export async function health() {
  const res = await request('/api/health', { timeoutMs: 4000 });
  return res.json();
}

/** Fetch the PDF the user picked in the native dialog. */
export async function pdfBytes() {
  const res = await request('/api/pdf', { timeoutMs: 60000 });
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Build the speakable script from extracted page geometry.
 * @param {{doc_id:string, stats:object, pages:object[], options:object}} payload
 * @param {{signal?: AbortSignal}} [opts] cancels the in-flight POST
 */
export async function buildScript(payload, { signal } = {}) {
  const res = await request('/api/script/build', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: SCRIPT_TIMEOUT_MS,
  });
  return res.json();
}

export async function loadNotes(docId) {
  const res = await request(`/api/notes/${encodeURIComponent(docId)}`, { timeoutMs: 8000 });
  return res.json();
}

export async function saveNotes(docId, record) {
  const res = await request(`/api/notes/${encodeURIComponent(docId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
    timeoutMs: 12000,
  });
  return res.json();
}

export function exportUrl(docId) {
  return `/api/notes/${encodeURIComponent(docId)}/export.md`;
}

export async function voices() {
  const res = await request('/api/voices', { timeoutMs: 8000 });
  return res.json();
}

/** @returns {Promise<{summary: string, backend: string, cached: boolean}>} 503 when the backend is unavailable */
export async function summarize(payload) {
  const res = await request('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: SUMMARY_TIMEOUT_MS,
  });
  return res.json();
}

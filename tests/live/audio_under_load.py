"""The audio path under the conditions the user actually hit."""
import concurrent.futures as cf
import os, io, json, statistics, struct, sys, time, wave
import httpx, numpy as np

BASE = "http://127.0.0.1:8000"
S = os.environ.get("KOKORO_FIXTURES", "/tmp")
p = f = 0
def ok(n, c, x=""):
    global p, f
    if c: p += 1; print(f"  PASS  {n}")
    else: f += 1; print(f"  FAIL  {n}  {x}")

sents = [s for s in json.load(open(f"{S}/vjepa_sents.json")) if 20 <= len(s) <= 600]
print(f"{len(sents)} real sentences from VJEPA_2 available")

def tts(text, voice="af_heart", speed=1.0, timeout=120.0):
    t0 = time.monotonic()
    r = httpx.get(f"{BASE}/api/tts", params={"text": text, "voice": voice, "speed": speed}, timeout=timeout)
    return r, time.monotonic() - t0

def probe(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes)) as w:
        n, sr = w.getnframes(), w.getframerate()
        raw = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768
    return {"secs": n / sr, "rate": sr, "peak": float(np.abs(raw).max()) if n else 0.0,
            "rms": float(np.sqrt((raw ** 2).mean())) if n else 0.0,
            "finite": bool(np.isfinite(raw).all())}

# ── 1. sustained reading, the "stops after a while" scenario ──────────────────
print("\n1. reading 40 real sentences back to back")
lat, dur, chars = [], [], []
bad = []
for i, s in enumerate(sents[:40]):
    r, el = tts(s)
    if r.status_code != 200 or r.content[:4] != b"RIFF":
        bad.append((i, r.status_code, r.text[:80])); continue
    m = probe(r.content)
    lat.append(el); dur.append(m["secs"]); chars.append(len(s))
    if not m["finite"] or m["peak"] < 0.01 or m["secs"] < 0.15:
        bad.append((i, "silent/short", f"{m} :: {s[:60]}"))
ok("   all 40 returned playable audio", not bad, json.dumps(bad[:3]))
ok("   none was silent", all(d > 0.15 for d in dur), f"min {min(dur):.2f}s")
cps = [c / d for c, d in zip(chars, dur)]
ok("   speech rate is plausible (8-30 chars/sec)", 8 < statistics.median(cps) < 30, f"median {statistics.median(cps):.1f}")
print(f"        latency  median {statistics.median(lat)*1000:.0f} ms   p90 {sorted(lat)[int(.9*len(lat))]*1000:.0f} ms   max {max(lat)*1000:.0f} ms")
print(f"        audio    {sum(dur):.1f}s of speech from {sum(chars)} chars")

# ── 2. cache ──────────────────────────────────────────────────────────────────
print("\n2. the disk cache")
r1, e1 = tts(sents[0]); r2, e2 = tts(sents[0])
ok("   identical bytes on a repeat", r1.content == r2.content)
ok("   and it is much faster", e2 < max(e1 * 0.5, 0.2), f"{e1*1000:.0f} ms then {e2*1000:.0f} ms")

# ── 3. speed is applied once, on the server ───────────────────────────────────
print("\n3. speed")
txt = sents[1]
d10 = probe(tts(txt, speed=1.0)[0].content)["secs"]
d15 = probe(tts(txt, speed=1.5)[0].content)["secs"]
ratio = d10 / d15
ok("   1.5x is ~1.5x shorter", 1.25 < ratio < 1.8, f"{d10:.2f}s vs {d15:.2f}s (ratio {ratio:.2f})")

# ── 4. A1/A2: abandoned requests must not wedge the server ────────────────────
print("\n4. 60 abandoned requests (A1/A2)")
long_texts = [s for s in sents if len(s) > 200][:60] or sents[:60]
def abandon(t):
    try:
        httpx.get(f"{BASE}/api/tts", params={"text": t, "voice": "af_heart"}, timeout=0.25)
    except Exception:
        pass
t0 = time.monotonic()
with cf.ThreadPoolExecutor(max_workers=60) as pool:
    list(pool.map(abandon, long_texts))
print(f"        fired and abandoned 60 requests in {time.monotonic()-t0:.1f}s")
worst = 0.0
for route in ("/api/health", "/api/voices", "/"):
    t1 = time.monotonic()
    try:
        code = httpx.get(BASE + route, timeout=10.0).status_code
    except Exception as exc:
        code = f"ERR {type(exc).__name__}"
    el = time.monotonic() - t1
    worst = max(worst, el)
    print(f"        {route:14} {code}  {el*1000:.0f} ms")
ok("   every sync route still answers", worst < 5.0, f"worst {worst:.2f}s")
r, el = tts(sents[5], timeout=60)
ok("   a new synthesis is still served", r.status_code == 200 and r.content[:4] == b"RIFF", f"{r.status_code} in {el:.1f}s")
ok("   and promptly", el < 20.0, f"{el:.1f}s")

# ── 5. input validation ───────────────────────────────────────────────────────
print("\n5. boundaries")
ok("   empty text -> 400", httpx.get(f"{BASE}/api/tts", params={"text": "", "voice": "af_heart"}, timeout=20).status_code == 400)
ok("   bad voice -> 400", httpx.get(f"{BASE}/api/tts", params={"text": "hi there", "voice": "../etc"}, timeout=20).status_code == 400)
ok("   a hidden voice is refused or handled", httpx.get(f"{BASE}/api/tts", params={"text": "hello there", "voice": "jf_alpha"}, timeout=60).status_code in (400, 422, 500, 503))

print(f"\n{'ALL PASS' if f == 0 else 'FAILURES'}: {p} passed, {f} failed")

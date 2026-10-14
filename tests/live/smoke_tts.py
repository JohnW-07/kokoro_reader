"""Live smoke test against a running server. Verifies R1/R2 claims with real timings."""
import sys, time, json, threading, urllib.request, urllib.error

BASE = "http://127.0.0.1:8000"

def get(path, timeout=300):
    t0 = time.perf_counter()
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        body = r.read()
    return r.status, body, (time.perf_counter() - t0) * 1000

def main():
    st, body, ms = get("/api/health", 10)
    print(f"[health] {st} {ms:.0f}ms {body.decode()}")

    st, body, ms = get("/", 10)
    print(f"[index]  {st} {ms:.0f}ms {len(body)} bytes")

    st, body, ms = get("/api/voices", 600)
    print(f"[voices] {st} {ms:.0f}ms {body.decode()[:120]}")

    # R2: health must stay responsive while a synthesis is in flight.
    latencies = []
    stop = threading.Event()
    def poll():
        while not stop.is_set():
            try:
                _, _, ms = get("/api/health", 5)
                latencies.append(ms)
            except Exception as e:
                latencies.append(-1.0)
            time.sleep(0.05)

    t = threading.Thread(target=poll, daemon=True); t.start()
    text = ("We show that the estimator converges at the expected rate under all stated "
            "assumptions, and that the bound is tight up to a logarithmic factor.")
    st, wav, ms = get(f"/api/tts?text={urllib.parse.quote(text)}&voice=af_heart&speed=1.0", 600)
    stop.set(); t.join(timeout=2)
    print(f"[tts]    {st} {ms:.0f}ms {len(wav)} bytes riff={wav[:4]!r}")
    good = [x for x in latencies if x >= 0]
    if good:
        print(f"[R2]     {len(good)} health probes during synth: "
              f"max={max(good):.0f}ms median={sorted(good)[len(good)//2]:.0f}ms  "
              f"(requirement: max < 100ms)")
    else:
        print("[R2]     NO PROBES COMPLETED — health was blocked")

    # Cache hit should be far faster.
    st, wav2, ms2 = get(f"/api/tts?text={urllib.parse.quote(text)}&voice=af_heart&speed=1.0", 600)
    print(f"[cache]  {st} {ms2:.0f}ms  (first was {ms:.0f}ms) same_bytes={wav==wav2}")

if __name__ == "__main__":
    import urllib.parse
    main()

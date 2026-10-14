"""Notes against the live server: round-trip, concurrency, caps, export, and the
two data-loss scenarios as the client now drives them."""
import concurrent.futures as cf, json, time, httpx

BASE = "http://127.0.0.1:8000"
A, B = "a" * 40, "b" * 40
p = f = 0
def ok(n, c, x=""):
    global p, f
    if c: p += 1; print(f"  PASS  {n}")
    else: f += 1; print(f"  FAIL  {n}  {x}")

def hl(i, note="", rects=None):
    return {"id": f"h{i}", "page": 1, "color": "yellow", "text": f"selection {i}",
            "note": note, "rects": rects or [{"x": .1, "y": .1 + i/100, "w": .3, "h": .01}],
            "created_at": "2026-09-12T00:00:00Z", "updated_at": "2026-09-12T00:00:00Z"}

def put(doc, body): return httpx.put(f"{BASE}/api/notes/{doc}", json=body, timeout=20)
def get(doc): return httpx.get(f"{BASE}/api/notes/{doc}", timeout=20)

print("\n1. round trip")
rec = {"doc_id": A, "title": "Paper A", "highlights": [hl(i, f"note {i}") for i in range(5)],
       "last_index": 42, "options": {"read_captions": True}}
r = put(A, rec); ok("   PUT accepted", r.status_code == 200, r.text[:120])
g = get(A).json()
ok("   all 5 highlights came back", len(g["highlights"]) == 5, str(len(g["highlights"])))
ok("   notes survived", g["highlights"][3]["note"] == "note 3", g["highlights"][3]["note"])
ok("   reading position survived", g["last_index"] == 42, str(g["last_index"]))
ok("   options survived", g.get("options", {}).get("read_captions") is True, json.dumps(g.get("options")))

print("\n2. an unknown document reads as empty, not 404")
g2 = get("c" * 40)
ok("   200 with an empty record", g2.status_code == 200 and g2.json()["highlights"] == [], g2.text[:120])

print("\n3. concurrent writers of the SAME document (the deterministic-tmp race)")
def write(i): return put(A, {**rec, "last_index": i}).status_code
with cf.ThreadPoolExecutor(max_workers=8) as pool:
    codes = list(pool.map(write, range(24)))
ok("   every concurrent write succeeded", set(codes) == {200}, str(sorted(set(codes))))
after = get(A).json()
ok("   the file is still valid and complete", len(after["highlights"]) == 5, str(len(after["highlights"])))

print("\n4. a runaway selection is capped, not rejected")
huge = put(A, {**rec, "highlights": [hl(0, "big", [{"x": .1, "y": i/5000, "w": .3, "h": .0001} for i in range(4000)])]})
ok("   accepted", huge.status_code == 200, huge.text[:120])
back = get(A).json()["highlights"][0]["rects"]
ok("   rects capped at 512", len(back) == 512, str(len(back)))

print("\n5. document B is untouched by anything written to A")
put(B, {"doc_id": B, "title": "Paper B", "highlights": [hl(9, "B's only note")], "last_index": 7})
put(A, {**rec, "highlights": []})                       # wipe A on purpose
b = get(B).json()
ok("   B still has its highlight", len(b["highlights"]) == 1, str(len(b["highlights"])))
ok("   B still has its note", b["highlights"][0]["note"] == "B's only note", str(b["highlights"][0]))
ok("   B still has its position", b["last_index"] == 7, str(b["last_index"]))

print("\n6. markdown export")
put(A, rec)
ex = httpx.get(f"{BASE}/api/notes/{A}/export.md", timeout=20)
ok("   200 markdown", ex.status_code == 200 and "markdown" in ex.headers.get("content-type", ""), ex.headers.get("content-type",""))
ok("   contains a note", "note 3" in ex.text, ex.text[:160])
ok("   no filesystem path leaks", "/Users/" not in ex.text and "/var/" not in ex.text)

print("\n7. bad input is rejected at the boundary")
ok("   bad doc_id -> 400", put("NOT-HEX", rec).status_code == 400)
ok("   bad doc_id on GET -> 400", get("../../etc/passwd").status_code in (400, 404))
ok("   garbage rects are dropped, not fatal",
   put(A, {**rec, "highlights": [{**hl(0), "rects": ["nope", None, {"x": "a"}]}]}).status_code == 200)

print("\n8. cleanup")
for d in (A, B, "c" * 40):
    httpx.delete(f"{BASE}/api/notes/{d}", timeout=10)
ok("   deleted", get(A).json()["highlights"] == [])
print(f"\n{'ALL PASS' if f == 0 else 'FAILURES'}: {p} passed, {f} failed")

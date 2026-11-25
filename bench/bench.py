"""usage: bench.py NAME [batches] -- benchmark listing_rows approaches on bench/projects/NAME (made by prep.py)."""
import json, os, random, statistics, subprocess, sys, time
from common import *

name = sys.argv[1]
NB = int(sys.argv[2]) if len(sys.argv) > 2 else 300
BATCH = 200
start_jvm()
import jpype, pyghidra
jpype.addClassPath(str(HERE / "java/out"))


def rss_mb():
    return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())])) / 1024


def heap_mb():
    from java.lang import Runtime, System
    System.gc()
    r = Runtime.getRuntime()
    return (r.totalMemory() - r.freeMemory()) / 1048576, r.maxMemory() / 1048576


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))]


out = {"name": name}
with pyghidra.open_program(None, PROJ, name, analyze=False, program_name="prog") as flat:
    prog = flat.getCurrentProgram()
    listing, st = prog.getListing(), prog.getSymbolTable()
    space = prog.getAddressFactory().getDefaultAddressSpace()
    out["heap_before_mb"], out["heap_max_mb"] = [round(x) for x in heap_mb()]
    out["rss_before_mb"] = round(rss_mb())

    t = time.monotonic(); index = build_index(prog); out["py_index_s"] = round(time.monotonic() - t, 2)
    out["rows"] = N = len(index)
    out["rss_after_py_index_mb"] = round(rss_mb())
    out["heap_after_py_index_mb"] = round(heap_mb()[0])

    RowFetcher = jpype.JClass("RowFetcher")
    t = time.monotonic(); rf = RowFetcher(prog); out["java_index_s"] = round(time.monotonic() - t, 2)
    assert rf.size() == N
    out["heap_after_java_index_mb"] = round(heap_mb()[0])
    print(out, flush=True)

    from ghidra.program.model.listing import CommentType, Instruction
    EOL = CommentType.EOL

    # (i) naive: verbatim from sidecar fetch_rows
    def naive(start, count):
        rows = []
        for off in index[start:start + count]:
            a = space.getAddress(off)
            cu = listing.getCodeUnitAt(a)
            if isinstance(cu, Instruction):
                ops = ", ".join(str(cu.getDefaultOperandRepresentation(i)) for i in range(cu.getNumOperands()))
            else:
                ops = str(cu.getDefaultValueRepresentation())
            b = bytes(x & 0xFF for x in cu.getBytes())
            row = {"address": "0x%x" % off, "bytes": b.hex(" "), "mnemonic": str(cu.getMnemonicString()), "operands": ops}
            sym = st.getPrimarySymbol(a)
            if sym is not None:
                row["label"] = str(sym.getName())
            c = cu.getComment(CommentType.EOL)
            if c:
                row["comment"] = str(c)
            rows.append(row)
        return rows

    # (ii) tuned: one iterator from the start address, cached bound methods, byte[] via buffer protocol, getLabel()
    getCUs = listing.getCodeUnits
    def tuned(start, count):
        it = getCUs(space.getAddress(index[start]), True)
        nxt = it.next
        rows = []
        ap = rows.append
        for _ in range(count):
            cu = nxt()
            if isinstance(cu, Instruction):
                ops = ", ".join([str(cu.getDefaultOperandRepresentation(i)) for i in range(cu.getNumOperands())])
            else:
                ops = str(cu.getDefaultValueRepresentation())
            off = cu.getMinAddress().getOffset()
            row = {"address": "0x%x" % off, "bytes": bytes(memoryview(cu.getBytes())).hex(" "),
                   "mnemonic": str(cu.getMnemonicString()), "operands": ops}
            lbl = cu.getLabel()
            if lbl is not None:
                row["label"] = str(lbl)
            c = cu.getComment(EOL)
            if c:
                row["comment"] = str(c)
            ap(row)
        return rows

    # (iii) Java helper, JSON string parsed in Python
    rowsJson = rf.rowsJson
    def java(start, count):
        return json.loads(str(rowsJson(start, count)))

    approaches = {"i_naive": naive, "ii_tuned": tuned, "iii_java": java}

    # --- equality check
    rnd = random.Random(1)
    starts = [0, max(0, N - BATCH)] + [rnd.randrange(0, max(1, N - BATCH)) for _ in range(150)]
    nchk = 0
    for s in starts:
        n = min(BATCH, N - s)
        a, b, c = naive(s, n), tuned(s, n), java(s, n)
        for i in range(n):
            if not (a[i] == b[i] == c[i]):
                print("MISMATCH at", s + i, a[i], b[i], c[i]); raise SystemExit(1)
        nchk += n
    out["verified_rows"] = nchk
    print("verified", nchk, "rows identical across i/ii/iii", flush=True)

    # --- timing
    # random: random start each batch across whole index; sequential: consecutive windows from a random start
    rs = random.Random(2)
    rand_starts = [rs.randrange(0, max(1, N - BATCH)) for _ in range(NB)]
    seq0 = rs.randrange(0, max(1, N - BATCH * NB))
    seq_starts = [min(max(0, N - BATCH), seq0 + i * BATCH) for i in range(NB)]
    res = {}
    for an, fn in approaches.items():
        for _ in range(20):  # warm-up
            fn(rs.randrange(0, max(1, N - BATCH)), BATCH)
        for kind, ss in (("random", rand_starts), ("sequential", seq_starts)):
            lat = []
            for s in ss:
                t = time.perf_counter(); fn(s, min(BATCH, N - s)); lat.append((time.perf_counter() - t) * 1000)
            res["%s/%s" % (an, kind)] = {"rows_per_s": round(BATCH * len(lat) / (sum(lat) / 1000)),
                                         "median_ms": round(statistics.median(lat), 2), "p95_ms": round(pct(lat, .95), 2),
                                         "batches": len(lat)}
            print(an, kind, res["%s/%s" % (an, kind)], flush=True)
    # raw string (no json.loads) for Java, informational
    lat = []
    for s in rand_starts:
        t = time.perf_counter(); str(rowsJson(s, min(BATCH, N - s))); lat.append((time.perf_counter() - t) * 1000)
    res["iii_java_rawstring/random"] = {"median_ms": round(statistics.median(lat), 2), "p95_ms": round(pct(lat, .95), 2)}
    out["results"] = res
json.dump(out, open(HERE / ("results_%s.json" % name), "w"), indent=1)
print(json.dumps(out, indent=1))

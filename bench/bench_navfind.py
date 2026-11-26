#!/usr/bin/env python3
"""Row 6 (navigate and find) measurements on a big binary with a persisted project.
Usage: bench_navfind.py <binary> <projects_dir> <out.json>   (projects_dir must already hold the analyzed program; open must be `persisted`)
Spawns the real sidecar and talks to it over the WebSocket protocol. Single runs, cold = first request of its kind after a program change."""
import asyncio, glob, json, os, random, statistics, subprocess, sys, time
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
binary, projects, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
env = dict(os.environ, SIDECAR_ALLOW_NO_AUTH="1", SIDECAR_PROJECTS_DIR=projects,
           GHIDRA_INSTALL_DIR=os.environ.get("GHIDRA_INSTALL_DIR") or sorted(glob.glob(ROOT + "/ghidra-install/ghidra_*"))[-1])
random.seed(1)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
QUIET = common.wait_quiet()  # exits 3 when the machine never gets quiet: no measurement under load


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 2)


def summ(xs):
    return {"n": len(xs), "median_ms": round(statistics.median(xs), 2), "p95_ms": pct(xs, 0.95), "max_ms": round(max(xs), 2)}


def rss_mb(pid):
    r = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return round(int(r) / 1024, 1) if r else 0


def quiet():
    out = subprocess.run("pgrep -fl 'electron|sidecar/main.py|decompile'", shell=True, capture_output=True, text=True).stdout.strip().splitlines()
    # not our own sidecar (this worktree), not shell wrappers that merely contain the words
    return [l[:160] for l in out if "pgrep" not in l and "navigate-find-features" not in l and " /bin/zsh -c " not in l and "bench_navfind" not in l]


async def main():
    res = {"binary": binary, "quiet": QUIET, "others_running_at_start": quiet()}
    p = subprocess.Popen([sys.executable, ROOT + "/sidecar/main.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    port = int(p.stdout.readline())
    nid = [0]
    async with websockets.connect("ws://127.0.0.1:%d" % port, max_size=None) as ws:
        futs = {}

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m.get("id") is not None and m["id"] in futs:
                    futs.pop(m["id"]).set_result(m)
        asyncio.create_task(reader())

        async def request(method, **params):
            nid[0] += 1
            i = nid[0]
            f = futs[i] = asyncio.get_running_loop().create_future()
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}))
            return await f

        async def call(method, **params):
            m = await request(method, **params)
            assert "result" in m, (method, params, m)
            return m["result"]

        async def timed(method, **params):
            t = time.monotonic()
            r = await call(method, **params)
            return round((time.monotonic() - t) * 1000, 1), r

        o = await call("open_binary", path=binary, analysis="blocking")
        assert o["persisted"], "needs the persisted program (a first open takes 17-40 min)"
        res["rss_after_open_mb"] = rss_mb(p.pid)
        info = await call("listing_info")
        res["total_bytes"] = info["totalBytes"]

        def rand_addr():
            x = random.randrange(info["totalBytes"])
            for r in info["ranges"]:
                if x < r["size"]:
                    return hex(int(r["start"], 16) + x)
                x -= r["size"]

        async def listing_lat(n=300, gap=0.016, stop=None):
            lat = []
            while len(lat) < n and not (stop and stop.is_set()):
                t = time.monotonic()
                await call("listing_rows", address=rand_addr(), count=100)
                lat.append((time.monotonic() - t) * 1000)
                await asyncio.sleep(gap)
            return lat

        res["listing_baseline"] = summ(await listing_lat())

        # ---- symbol table ----
        S = res["symbols"] = {}
        ms, r = await timed("list_symbols", limit=100)
        S["default_first_page_cold_ms"], S["total"] = ms, r["total"]
        S["default_second_page_ms"] = (await timed("list_symbols", offset=100, limit=100))[0]
        S["default_page_again_ms"] = (await timed("list_symbols", limit=100))[0]
        S["default_deep_page_cold_ms"] = (await timed("list_symbols", offset=r["total"] - 100, limit=100))[0]
        S["default_deep_page_again_ms"] = (await timed("list_symbols", offset=r["total"] - 100, limit=100))[0]
        # filter-as-you-type: each query is new (cold); then a repeat and a page 2 of the last (warm)
        typing = []
        for q in ("s", "st", "std", "std::", "std::vector"):
            ms, r2 = await timed("list_symbols", query=q, limit=100)
            typing.append({"query": q, "ms": ms, "total": r2["total"]})
        S["filter_typing_cold"] = typing
        S["filter_repeat_ms"] = (await timed("list_symbols", query="std::vector", limit=100))[0]
        S["filter_page2_ms"] = (await timed("list_symbols", query="std::vector", offset=100, limit=100))[0]
        ms, r2 = await timed("list_symbols", query="exegesis", limit=100)
        S["filter_rare_cold"] = {"ms": ms, "total": r2["total"]}
        for kind in ("function", "external", "label"):
            ms, r2 = await timed("list_symbols", kinds=[kind], limit=100)
            S["kind_%s_cold" % kind] = {"ms": ms, "total": r2["total"]}
        for srt in ("name", "kind", "namespace", "source"):
            ms, r2 = await timed("list_symbols", sort=srt, limit=100)
            S["sort_%s_cold_ms" % srt] = ms
            S["sort_%s_page2_ms" % srt] = (await timed("list_symbols", sort=srt, offset=100, limit=100))[0]
        S["sort_address_desc_cold_ms"] = (await timed("list_symbols", sort="address", desc=True, limit=100))[0]
        t, hits = await timed("search_symbols", query="std::vector", limit=100)
        S["search_symbols_ms"] = t
        S["search_symbols_hits"] = len(hits)

        # ---- strings ----
        T = res["strings"] = {}
        ms, r = await timed("list_strings", limit=100)
        T["first_page_cold_ms"], T["total"] = ms, r["total"]
        T["second_page_ms"] = (await timed("list_strings", offset=100, limit=100))[0]
        T["deep_page_ms"] = (await timed("list_strings", offset=r["total"] - 100, limit=100))[0]
        ms, r2 = await timed("list_strings", query="error", limit=100)
        T["query_cold"] = {"ms": ms, "total": r2["total"]}
        T["query_repeat_ms"] = (await timed("list_strings", query="error", limit=100))[0]
        ms, r2 = await timed("list_strings", minLength=12, limit=100)
        T["minlength12_cold"] = {"ms": ms, "total": r2["total"]}
        T["minlength12_page2_ms"] = (await timed("list_strings", minLength=12, offset=100, limit=100))[0]

        # ---- memory search ----
        M = res["memsearch"] = {}

        async def walk(pattern, limit=1000, **kw):
            """All pages of a search: total ms, matches, pages, slowest page."""
            t0, start, n, pages, worst = time.monotonic(), None, 0, 0, 0
            while True:
                t = time.monotonic()
                r = await call("search_memory", pattern=pattern, limit=limit, **({"start": start} if start else {}), **kw)
                worst = max(worst, (time.monotonic() - t) * 1000)
                n += len(r["items"]); pages += 1
                if r["next"] is None:
                    break
                start = r["next"]
            return {"pattern": pattern, "total_ms": round((time.monotonic() - t0) * 1000), "matches": n, "pages": pages, "slowest_page_ms": round(worst)}

        M["exact_4_rare"] = await walk("de ad be ef")                  # whole binary, (almost) no matches: pure scan
        M["exact_4_rare_again"] = await walk("de ad be ef")
        M["exact_4_wildcard"] = await walk("48 8b ?? 24")              # a common x86-64 prefix, but this is an arm64 binary: still few matches
        M["exact_4_arm64_common"] = await walk("fd 7b bf a9", limit=10000)  # stp x29, x30, [sp, #-16]! : one per function prologue
        M["exact_4_zero"] = await walk("00 00 00 00", limit=10000)     # a very common pattern: hundreds of thousands of matches, paged
        M["text_ascii"] = await walk("std::", kind="text")
        M["text_utf16"] = await walk("std", kind="text", encoding="utf16le")
        M["text_ascii_nocase"] = await walk("ERROR", kind="text", caseSensitive=False)

        # ---- listing latency while scans run ----
        W = res["listing_during"] = {}

        async def during(name, work):
            stop = asyncio.Event()

            async def runner():
                t0 = time.monotonic()
                await work()
                stop.set()
                return round((time.monotonic() - t0) * 1000)
            task = asyncio.create_task(runner())
            lat = await listing_lat(n=100000, stop=stop)
            W[name] = {**summ(lat), "scan_ms": await task}

        async def search_rare():
            await walk("de ad be ef")

        async def search_loop():
            for _ in range(3):
                await walk("de ad be ef")

        async def strings_cold():
            await call("list_strings", minLength=7, limit=100)

        async def symbols_sort_cold():
            await call("list_symbols", sort="namespace", desc=True, limit=100)
            await call("list_symbols", sort="kind", desc=True, limit=100)

        await during("byte_search_rare_x1", search_rare)
        await during("byte_search_rare_x3", search_loop)
        await during("strings_first_scan_minlength7", strings_cold)
        await during("symbol_sort_snapshots", symbols_sort_cold)
        res["rss_end_mb"] = rss_mb(p.pid)
    res["others_running_at_end"] = quiet()
    p.stdin.close()
    try:
        p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        p.kill()
    json.dump(res, open(out_path, "w"), indent=1)
    print(json.dumps(res, indent=1))

asyncio.run(main())

#!/usr/bin/env python3
"""Round 7: first open in background mode. One sidecar, nothing else running. Usage: bench_background.py <binary> <projects_dir> <out.json> [--profile fast|full] [--timeout MIN]
Measures, from the moment open_binary is sent: the reply, the first listing rows, the first decompile, the end of the analysis; and while the analysis runs:
listing_rows latency (a random address every 100 ms), decompile latency (one function after the other), program_changed rate, peak RSS (JVM, native decompiler).
Env passed through: SIDECAR_MAXMEM, SIDECAR_ANALYSIS_CORES, ... Writes <out> and <out>.stderr.log (Ghidra's analyzer task times)."""
import argparse, asyncio, glob, json, os, random, statistics, subprocess, sys, threading, time
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ap = argparse.ArgumentParser()
ap.add_argument("binary"); ap.add_argument("projects"); ap.add_argument("out")
ap.add_argument("--profile", choices=["fast", "full"], default="full")
ap.add_argument("--timeout", type=float, default=90)
a = ap.parse_args()
os.makedirs(a.projects, exist_ok=True)
env = dict(os.environ, SIDECAR_ALLOW_NO_AUTH="1", SIDECAR_PROJECTS_DIR=a.projects,
           GHIDRA_INSTALL_DIR=os.environ.get("GHIDRA_INSTALL_DIR") or sorted(glob.glob(ROOT + "/ghidra-install/ghidra_*"))[-1])
random.seed(7)


def tree_rss(pid):  # JVM (the sidecar process) and its native children (decompile)
    ps = lambda p: (int(subprocess.run(["ps", "-o", "rss=", "-p", str(p)], capture_output=True, text=True).stdout.strip() or 0)) / 1024
    kids = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
    return ps(pid), sum(ps(k) for k in kids)


def summ(xs):
    xs = sorted(xs)
    if not xs:
        return {"n": 0}
    q = lambda p: round(xs[min(len(xs) - 1, int(len(xs) * p))], 2)
    return {"n": len(xs), "median_ms": round(statistics.median(xs), 2), "p95_ms": q(0.95), "max_ms": round(xs[-1], 2)}


async def main():
    errlog = open(a.out.replace(".json", "") + ".stderr.log", "w")
    p = subprocess.Popen([sys.executable, ROOT + "/sidecar/main.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errlog, env=env)
    port = int(p.stdout.readline())
    res = {"binary": a.binary, "size_mb": round(os.path.getsize(a.binary) / 1e6, 2), "profile": a.profile, "env": {k: v for k, v in os.environ.items() if k.startswith("SIDECAR_")}}
    samples, stop = [], threading.Event()
    T0 = [time.monotonic()]

    def sampler():
        while not stop.is_set():
            j, n = tree_rss(p.pid)
            samples.append((round(time.monotonic() - T0[0], 1), round(j), round(n)))
            stop.wait(2)
    threading.Thread(target=sampler, daemon=True).start()
    notes, futs, nid = [], {}, [0]
    async with websockets.connect("ws://127.0.0.1:%d" % port, max_size=None) as ws:
        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m.get("id") is None:
                    notes.append((time.monotonic(), m))
                elif m["id"] in futs:
                    futs.pop(m["id"]).set_result(m)
        rd = asyncio.create_task(reader())

        async def call(method, **params):
            nid[0] += 1
            f = futs[nid[0]] = asyncio.get_running_loop().create_future()
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": nid[0], "method": method, "params": params}))
            return await f

        t0 = T0[0] = time.monotonic()
        rel = lambda: round(time.monotonic() - t0, 2)
        r = await call("open_binary", path=a.binary, analysis="background", **({"profile": "fast"} if a.profile == "fast" else {}))
        res["open_reply_s"] = rel()
        res["open_result"] = r.get("result") or r.get("error")
        info = (await call("listing_info"))["result"]
        res["ranges"], res["total_bytes"] = len(info["ranges"]), info["totalBytes"]
        start = info["ranges"][0]["start"]
        rows = await call("listing_rows", address=start, count=100)
        res["first_listing_rows_s"] = rel()
        res["first_rows_ok"] = len(rows.get("result", [])) > 0
        funcs0 = (await call("list_functions"))["result"]
        res["functions_at_open"] = len(funcs0)
        fcount = [(rel(), len(funcs0))]
        # decompile something that exists at the start: the first function, else wait for one
        entries = [f["entry"] for f in funcs0]
        while not entries:
            await asyncio.sleep(0.5)
            entries = [f["entry"] for f in (await call("list_functions"))["result"]]
        d = await call("decompile", entry=entries[0])
        res["first_decompile_s"] = rel()
        res["first_decompile_ok"] = "result" in d
        # while the analysis runs: listings, decompiles, function count
        lst, dec, running = [], [], [True]
        ranges = info["ranges"]

        async def listing_loop():
            while running[0]:
                rg = random.choice(ranges)
                off = random.randrange(0, max(1, rg["size"] - 400))
                t = time.monotonic()
                await call("listing_rows", address="0x%x" % (int(rg["start"], 16) + off), count=100)
                lst.append((time.monotonic() - t) * 1000)
                await asyncio.sleep(0.1)

        async def decompile_loop():
            while running[0]:
                es = entries if len(entries) < 200 else random.sample(entries, 200)
                for e in es:
                    if not running[0]:
                        return
                    t = time.monotonic()
                    r = await call("decompile", entry=e, timeoutSecs=10)
                    dec.append(((time.monotonic() - t) * 1000, "result" in r))

        async def watch():
            while True:
                st = (await call("analysis_status"))["result"]
                n = len((await call("list_functions"))["result"])
                fcount.append((rel(), n))
                if st["state"] in ("done", "failed", "cancelled"):
                    return st
                if time.monotonic() - t0 > a.timeout * 60:
                    return {"state": "TIMEOUT"}
                await asyncio.sleep(5)
        tasks = [asyncio.create_task(listing_loop()), asyncio.create_task(decompile_loop())]
        st = await watch()
        running[0] = False
        await asyncio.gather(*tasks, return_exceptions=True)
        res["analysis_done_s"] = rel()
        res["analysis_final"] = st
        res["listing_during_analysis"] = summ(lst)
        res["decompile_during_analysis"] = {**summ([x for x, _ in dec]), "failed": sum(1 for _, ok in dec if not ok)}
        res["functions_timeline"] = fcount[::max(1, len(fcount) // 40)]
        res["program_changed_events"] = sum(1 for _, m in notes if m["method"] == "program_changed")
        res["analysis_state_events"] = sum(1 for _, m in notes if m["method"] == "analysis_state")
        res["functions_at_end"] = len((await call("list_functions"))["result"])
        # the same reads once the analysis is over, for comparison
        lst2 = []
        for _ in range(100):
            rg = random.choice(ranges)
            t = time.monotonic()
            await call("listing_rows", address="0x%x" % (int(rg["start"], 16) + random.randrange(0, max(1, rg["size"] - 400))), count=100)
            lst2.append((time.monotonic() - t) * 1000)
        res["listing_after_analysis"] = summ(lst2)
        rd.cancel()
    stop.set()
    res["rss_peak_jvm_mb"] = max((s[1] for s in samples), default=0)
    res["rss_peak_native_mb"] = max((s[2] for s in samples), default=0)
    res["rss_samples_every_2s"] = samples[::5]
    p.stdin.close()
    try:
        p.wait(timeout=60)
    except subprocess.TimeoutExpired:
        p.kill()
    json.dump(res, open(a.out, "w"), indent=1)
    print(json.dumps({k: v for k, v in res.items() if not k.endswith("timeline") and "samples" not in k}, indent=1))

asyncio.run(main())

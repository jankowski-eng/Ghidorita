#!/usr/bin/env python3
"""First-open measurements on one big binary. One sidecar process, nothing else running (two analyses in parallel distort time and memory).

Usage: bench_open.py <binary> <projects_dir> <out.json> [--cancel-at S ...] [--timeout MIN]
  --cancel-at S   (repeatable) cancel_open S seconds after the first analysis progress event, then open again.
                  Cancelled opens save nothing, so the final (uncancelled) open is the full first open.
Env passed through to the sidecar: SIDECAR_MAXMEM, SIDECAR_ANALYSIS_DISABLE, ...
Writes <out.json> (+ <out>.stderr.log with the sidecar's stderr, incl. Ghidra's per-analyzer task times)."""
import argparse, asyncio, glob, json, os, subprocess, sys, threading, time
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ap = argparse.ArgumentParser()
ap.add_argument("binary"); ap.add_argument("projects"); ap.add_argument("out")
ap.add_argument("--cancel-at", type=float, action="append", default=[])
ap.add_argument("--timeout", type=float, default=90, help="minutes for the full open")
ap.add_argument("--no-full", action="store_true")
a = ap.parse_args()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
QUIET = common.wait_quiet()  # exits 3 when the machine never gets quiet: no measurement under load
os.makedirs(a.projects, exist_ok=True)
env = dict(os.environ, SIDECAR_ALLOW_NO_AUTH="1", SIDECAR_PROJECTS_DIR=a.projects,
           GHIDRA_INSTALL_DIR=os.environ.get("GHIDRA_INSTALL_DIR") or sorted(glob.glob(ROOT + "/ghidra-install/ghidra_*"))[-1])


def ps_rss(pid):
    r = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return int(r) / 1024 if r else 0.0


def rss(pid):  # sidecar (JVM) and its native children (decompile)
    kids = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
    return ps_rss(pid), sum(ps_rss(k) for k in kids)


async def main():
    t_start = time.monotonic()
    errlog = open(a.out.replace(".json", "") + ".stderr.log", "w")
    p = subprocess.Popen([sys.executable, ROOT + "/sidecar/main.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errlog, env=env)
    port = int(p.stdout.readline())
    res = {"quiet": QUIET, "binary": a.binary, "size_mb": round(os.path.getsize(a.binary) / 1e6, 2), "jvm_start_s": round(time.monotonic() - t_start, 2),
           "env": {k: v for k, v in os.environ.items() if k.startswith("SIDECAR_")}}
    samples, notes, stop = [], [], threading.Event()
    t0 = time.monotonic()

    def sampler():
        while not stop.is_set():
            j, n = rss(p.pid)
            samples.append((round(time.monotonic() - t0, 1), round(j, 1), round(n, 1)))
            stop.wait(5)
    threading.Thread(target=sampler, daemon=True).start()

    async with websockets.connect("ws://127.0.0.1:%d" % port, max_size=None) as ws:
        futs, nid = {}, [0]

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m.get("id") is None:
                    notes.append((time.monotonic() - t0, m))
                elif m["id"] in futs:
                    futs.pop(m["id"]).set_result((time.monotonic() - t0, m))
        rd = asyncio.create_task(reader())

        async def send(method, **params):
            nid[0] += 1
            f = futs[nid[0]] = asyncio.get_running_loop().create_future()
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": nid[0], "method": method, "params": params}))
            return f

        async def call(method, **params):
            return (await (await send(method, **params)))[1]

        def first_analysis_note():
            return next((t for t, m in notes if m["method"] == "progress" and m["params"]["phase"] == "analysis"), None)

        cancels = []
        for delay in a.cancel_at:
            n0 = len(notes)
            oid = await send("open_binary", path=a.binary)
            while True:  # wait for the first analysis event of THIS open
                await asyncio.sleep(0.1)
                t_an = next((t for t, m in notes[n0:] if m["method"] == "progress" and m["params"]["phase"] == "analysis"), None)
                if t_an is not None or oid.done():
                    break
            if t_an is None:
                cancels.append({"cancel_at_s": delay, "error": "open ended before analysis started"})
                continue
            await asyncio.sleep(delay)
            last = [m["params"] for _, m in notes[n0:] if m["method"] == "progress"][-1]
            tc = time.monotonic()
            ack = await call("cancel_open")
            t_ack = time.monotonic()
            t_end, r = await oid
            t_end = time.monotonic()
            cancels.append({"cancel_after_analysis_start_s": delay, "analyzer_at_cancel": last.get("analyzer"), "message_at_cancel": last.get("message"),
                            "ack_ms": round((t_ack - tc) * 1000), "open_failed_after_ms": round((t_end - tc) * 1000),
                            "ack": ack["result"], "error_code": r.get("error", {}).get("code"),
                            "rss_mb_after": [round(x, 1) for x in rss(p.pid)]})
            print("cancel", cancels[-1], flush=True)
        if cancels:
            res["cancel_tests"] = cancels

        if not a.no_full:
            n0 = len(notes)
            t_open = time.monotonic()
            oid = await send("open_binary", path=a.binary)
            try:
                t_end, r = await asyncio.wait_for(oid, a.timeout * 60)
                res["open_result"] = r.get("result") or r.get("error")
            except asyncio.TimeoutError:
                res["open_result"] = "TIMEOUT after %.0f min" % a.timeout
                t_end = None
            res["full_open_wall_s"] = round(time.monotonic() - t_open, 1)
            prog = [(t - (t_open - t0), m["params"]) for t, m in notes[n0:] if m["method"] == "progress"]
            first = {}
            for t, pr in prog:
                first.setdefault(pr["phase"], round(t, 1))
            res["phase_first_event_s"] = first  # seconds after open_binary was sent
            res["progress_events"] = len(prog)
            # analyzer timeline from the events (only analyzers longer than the 0.2 s event throttle show up)
            tl, cur = [], None
            for t, pr in prog:
                if pr["phase"] != "analysis":
                    if cur:
                        cur["end"] = round(t, 1); tl.append(cur); cur = None
                    continue
                an = pr.get("analyzer") or ""
                if cur is None or an != cur["analyzer"]:
                    if cur:
                        cur["end"] = round(t, 1); tl.append(cur)
                    cur = {"analyzer": an, "start": round(t, 1)}
            if cur:
                cur["end"] = res["full_open_wall_s"]; tl.append(cur)
            res["analyzer_timeline"] = tl
            if isinstance(res["open_result"], dict):
                fns = (await call("list_functions"))["result"]
                info = (await call("listing_info"))["result"]
                res.update(functions=len(fns), total_bytes=info["totalBytes"], ranges=len(info["ranges"]))
        rd.cancel()
    stop.set()
    res["rss_peak_jvm_mb"] = max((s[1] for s in samples), default=0)
    res["rss_peak_native_mb"] = max((s[2] for s in samples), default=0)
    res["rss_samples_every_5s"] = samples
    p.stdin.close()
    try:
        p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        p.kill()
    json.dump(res, open(a.out, "w"), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k not in ("rss_samples_every_5s", "analyzer_timeline", "cancel_tests")}, indent=1))

asyncio.run(main())

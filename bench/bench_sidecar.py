#!/usr/bin/env python3
"""Sidecar-level measurements on one binary (step 6). Usage: bench_sidecar.py <binary> <projects_dir> [out.json]
Spawns the real sidecar twice (fresh import, then persisted reopen) and talks to it over the WebSocket protocol."""
import asyncio, json, os, random, statistics, subprocess, sys, time, glob
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
binary, projects = sys.argv[1], sys.argv[2]
out_path = sys.argv[3] if len(sys.argv) > 3 else None
os.makedirs(projects, exist_ok=True)
env = dict(os.environ, SIDECAR_ALLOW_NO_AUTH="1", SIDECAR_PROJECTS_DIR=projects,
           GHIDRA_INSTALL_DIR=os.environ.get("GHIDRA_INSTALL_DIR") or sorted(glob.glob(ROOT + "/ghidra-install/ghidra_*"))[-1])
random.seed(1)


def rss_mb(pid):  # process + native children (the decompile process)
    def one(p):
        r = subprocess.run(["ps", "-o", "rss=", "-p", str(p)], capture_output=True, text=True).stdout.strip()
        return int(r) / 1024 if r else 0
    kids = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
    return round(one(pid), 1), round(sum(one(k) for k in kids), 1)


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 2)


def summ(xs):
    return {"n": len(xs), "median_ms": round(statistics.median(xs), 2), "p95_ms": pct(xs, 0.95), "max_ms": round(max(xs), 2)}


async def session(first):
    t0 = time.monotonic()
    p = subprocess.Popen([sys.executable, ROOT + "/sidecar/main.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    port = int(p.stdout.readline())
    res = {"jvm_start_s": round(time.monotonic() - t0, 2)}
    nid = [0]
    async with websockets.connect("ws://127.0.0.1:%d" % port, max_size=None) as ws:
        futs = {}

        async def reader():  # single reader, dispatches replies to waiting calls (decompile and listing run concurrently)
            async for raw in ws:
                m = json.loads(raw)
                if m.get("id") is not None and m["id"] in futs:
                    futs.pop(m["id"]).set_result(m)

        rd = asyncio.create_task(reader())

        async def request(method, **params):
            nid[0] += 1
            f = futs[nid[0]] = asyncio.get_running_loop().create_future()
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": nid[0], "method": method, "params": params}))
            return await f

        async def call(method, **params):
            m = await request(method, **params)
            assert "result" in m, m
            return m["result"]

        t = time.monotonic()
        o = await call("open_binary", path=binary)
        res["open_binary_s"] = round(time.monotonic() - t, 2)
        res["persisted"] = o["persisted"]
        res["rss_after_open_mb"] = rss_mb(p.pid)
        if first:
            fns = await call("list_functions")
            info = await call("listing_info")
            res.update(functions=len(fns), total_bytes=info["totalBytes"], ranges=len(info["ranges"]))

            def rand_addr():
                x = random.randrange(info["totalBytes"])
                for r in info["ranges"]:
                    if x < r["size"]:
                        pre, _, h = r["start"].rpartition(":")  # "0x..", "code:1000", "OVL::1000"
                        return (pre + ":" if pre else "0x") + format(int(h, 16) + x, "x")
                    x -= r["size"]

            lat = []
            for _ in range(300):
                a = rand_addr(); t = time.monotonic()
                rows = await call("listing_rows", address=a, count=100)
                lat.append((time.monotonic() - t) * 1000)
            res["listing_100_rows_random_300"] = summ(lat)
            lat = []
            for _ in range(100):
                a = rand_addr(); t = time.monotonic()
                await call("listing_rows", address=a, count=100, direction="backward")
                lat.append((time.monotonic() - t) * 1000)
            res["listing_100_rows_backward_100"] = summ(lat)

            if not os.environ.get("LISTING_ONLY"):
                # 50 decompiles of random functions while another task keeps fetching random listing pages
                sample = random.sample(fns, min(50, len(fns)))
                stop = False; ll = []

                async def scroller():
                    while not stop:
                        a = rand_addr(); t = time.monotonic()
                        await call("listing_rows", address=a, count=100)
                        ll.append((time.monotonic() - t) * 1000)
                        await asyncio.sleep(0.016)
                task = asyncio.create_task(scroller())
                dl = []; errs = 0
                for f in sample:
                    t = time.monotonic()
                    m = await request("decompile", entry=f["entry"], timeoutSecs=30)
                    errs += "error" in m
                    dl.append((time.monotonic() - t) * 1000)
                stop = True; await task
                res["decompile_50_cold_while_listing"] = {**summ(dl), "errors": errs, "total_s": round(sum(dl) / 1000, 1)}
                res["listing_during_decompile"] = summ(ll)
                res["sample_function_bytes_median"] = statistics.median(f["size"] for f in sample)
                # the 50 largest functions: the cold decompile worst case, again with listing fetches running
                big = sorted(fns, key=lambda f: -f["size"])[:50]
                stop = False; ll = []
                task = asyncio.create_task(scroller())
                dl = []; errs = 0
                for f in big:
                    t = time.monotonic()
                    m = await request("decompile", entry=f["entry"], timeoutSecs=30)
                    errs += "error" in m
                    dl.append((time.monotonic() - t) * 1000)
                stop = True; await task
                res["decompile_50_largest_while_listing"] = {**summ(dl), "errors": errs, "largest_function_bytes": big[0]["size"], "50th_bytes": big[-1]["size"]}
                res["listing_during_largest_decompile"] = summ(ll)
                res["rss_after_workload_mb"] = rss_mb(p.pid)
    rd.cancel()
    p.stdin.close()
    t = time.monotonic(); p.wait(timeout=20)
    res["exit_after_stdin_close_s"] = round(time.monotonic() - t, 2)
    res["total_spawn_to_ready_s"] = round(res["jvm_start_s"] + res["open_binary_s"], 2)
    return res


async def main():
    r = {"binary": binary, "size_mb": round(os.path.getsize(binary) / 1e6, 2)}
    r["first_open"] = await session(True)
    print(json.dumps(r["first_open"], indent=1), flush=True)
    if not os.environ.get("SKIP_REOPEN"):
        r["reopen"] = await session(False)
        print(json.dumps(r["reopen"], indent=1), flush=True)
    if out_path:
        json.dump(r, open(out_path, "w"), indent=1)

asyncio.run(main())

import asyncio, glob, json, os, subprocess, sys, time

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
JAVA = os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home")
BIN = os.environ.get("SPIKE_BINARY", "/bin/ls")


def ghidra_dir():
    d = os.environ.get("GHIDRA_INSTALL_DIR") or (sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "ghidra-install", "ghidra_*/")) or [None])[-1])
    assert d, "no Ghidra install"
    return d


def thin_binary(tmp_path):
    out = tmp_path / "ls_arm64"
    r = subprocess.run(["lipo", BIN, "-thin", "arm64", "-output", str(out)], capture_output=True)
    return str(out) if r.returncode == 0 else BIN


def test_smoke(tmp_path):
    timings = {}
    env = dict(os.environ, GHIDRA_INSTALL_DIR=ghidra_dir(), JAVA_HOME=JAVA)
    t0 = time.monotonic()
    p = subprocess.Popen([sys.executable, os.path.join(HERE, "main.py")], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, env=env)
    port = int(p.stdout.readline())
    timings["jvm_start_s"] = round(time.monotonic() - t0, 2)
    binary = thin_binary(tmp_path)

    async def scenario():
        notes, nid = [], [0]
        async with websockets.connect("ws://127.0.0.1:%d" % port, max_size=None) as ws:
            async def call(method, **params):
                nid[0] += 1
                await ws.send(json.dumps({"jsonrpc": "2.0", "id": nid[0], "method": method, "params": params}))
                while True:
                    m = json.loads(await ws.recv())
                    if m.get("id") == nid[0]:
                        return m
                    notes.append(m)

            t = time.monotonic()
            r = await call("open_binary", path=binary)
            timings["import_analysis_s"] = round(time.monotonic() - t, 2)
            assert "result" in r, r
            phases = {n["params"]["phase"] for n in notes if n["method"] == "progress"}
            assert {"import", "analysis", "ready"} <= phases, phases

            fns = (await call("list_functions"))["result"]
            assert fns
            timings["function_count"] = len(fns)

            # first function whose decompile yields tokens
            for f in fns:
                t = time.monotonic()
                d = await call("decompile", entry=f["entry"])
                if "result" in d and d["result"]["tokens"]:
                    break
            ms = (time.monotonic() - t) * 1000
            res = d["result"]
            assert res["cached"] is False
            lines = res["text"].split("\n")
            for k in res["tokens"]:
                assert 0 <= k["line"] < len(lines) and k["colStart"] < k["colEnd"] <= len(lines[k["line"]])
            by_line = {}
            for k in res["tokens"]:
                by_line.setdefault(k["line"], []).append(k)
            for l, ks in by_line.items():
                ks.sort(key=lambda k: k["colStart"])
                for a, b in zip(ks, ks[1:]):
                    assert a["colEnd"] <= b["colStart"], "overlap"
            assert any(k["kind"] == "function" for k in res["tokens"])
            timings["decompile_ms"] = round(ms, 1)
            timings["decompile_fn"] = f["name"]
            t = time.monotonic()
            d2 = await call("decompile", entry=f["entry"])
            timings["cache_hit_ms"] = round((time.monotonic() - t) * 1000, 1)
            assert d2["result"]["cached"] is True and d2["result"]["text"] == res["text"]
            timings["targets_seen"] = sum("targetFunction" in k for k in res["tokens"])

            info = (await call("listing_info"))["result"]
            ranges = info["ranges"]
            assert ranges and info["totalBytes"] == sum(r["size"] for r in ranges)
            timings["total_bytes"], timings["ranges"] = info["totalBytes"], len(ranges)
            first = ranges[0]["start"]
            rows = (await call("listing_rows", address=first, count=200))["result"]
            assert len(rows) == 200 and rows[0]["address"] == first
            assert all(r["address"].startswith("0x") and r["mnemonic"] and r["length"] > 0 for r in rows)
            for a, b in zip(rows, rows[1:]):  # ascending; contiguous inside a range
                assert int(b["address"], 16) >= int(a["address"], 16) + a["length"]
            # forward from the middle of a code unit starts at the unit containing it
            mid = int(rows[5]["address"], 16)
            f = (await call("listing_rows", address=hex(mid + rows[5]["length"] - 1), count=3))["result"]
            assert f[0]["address"] == rows[5]["address"], (f[0], rows[5])
            # backward: strictly before the anchor, ascending, and consistent with forward
            back = (await call("listing_rows", address=rows[50]["address"], count=20, direction="backward"))["result"]
            assert back == rows[30:50], "backward != forward slice"
            assert (await call("listing_rows", address=first, count=20, direction="backward"))["result"] == []
            last = ranges[-1]
            end = hex(int(last["start"], 16) + last["size"] - 1)
            tail = (await call("listing_rows", address=end, count=50))["result"]
            assert len(tail) == 1 and int(tail[0]["address"], 16) + tail[0]["length"] == int(last["start"], 16) + last["size"]
            assert (await call("listing_rows", address=hex(int(end, 16) + 1), count=5))["result"] == [] or len(ranges) > 1
            # random-position latency
            import random
            lat = []
            for _ in range(50):
                r = random.choice(ranges)
                a = hex(int(r["start"], 16) + random.randrange(r["size"]))
                t = time.monotonic()
                await call("listing_rows", address=a, count=200)
                lat.append((time.monotonic() - t) * 1000)
            lat.sort()
            timings["listing_rows_200_median_ms"] = round(lat[25], 1)

            assert (await call("nope"))["error"]["code"] == -32601
            assert (await call("decompile", entry="0x1"))["error"]["code"] == -32004

            # cancel: fire a decompile then cancel right away (may race with fast functions)
            big = max(fns, key=lambda f: f["size"])
            nid[0] += 1
            did = nid[0]
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": did, "method": "decompile", "params": {"entry": big["entry"], "timeoutSecs": 1}}))
            await asyncio.sleep(0.05)
            c = await call("cancel_decompile")
            timings["cancel_result"] = c["result"]
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == did:
                    timings["cancel_outcome"] = m.get("error", {}).get("code", "completed")
                    break

    try:
        asyncio.run(asyncio.wait_for(scenario(), 600))
    finally:
        print("TIMINGS", json.dumps(timings, indent=1))
        json.dump(timings, open(os.path.join(HERE, "timings.json"), "w"), indent=1)
        p.stdin.close()
    t = time.monotonic()
    assert p.wait(timeout=15) is not None
    timings["exit_after_stdin_close_s"] = round(time.monotonic() - t, 2)
    json.dump(timings, open(os.path.join(HERE, "timings.json"), "w"), indent=1)

#!/usr/bin/env python3
"""What did an analysis profile find? Usage: bench_probe.py <binary> <projects_dir> <out.json> [--sample-from other_probe.json]
Opens the (already persisted) program and counts functions, defined strings, references into a fixed sample of
function entries, how many of those entries are still function entries here, and a rough decompile fingerprint.
The sample comes from the reference run (--sample-from); without it a sample of every 20th function is taken and saved."""
import asyncio, glob, json, os, random, re, subprocess, sys, time
import websockets

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
binary, projects, out = sys.argv[1:4]
ref = sys.argv[sys.argv.index("--sample-from") + 1] if "--sample-from" in sys.argv else None
env = dict(os.environ, SIDECAR_ALLOW_NO_AUTH="1", SIDECAR_PROJECTS_DIR=projects,
           GHIDRA_INSTALL_DIR=os.environ.get("GHIDRA_INSTALL_DIR") or sorted(glob.glob(ROOT + "/ghidra-install/ghidra_*"))[-1])


async def main():
    p = subprocess.Popen([sys.executable, ROOT + "/sidecar/main.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    port = int(p.stdout.readline())
    async with websockets.connect("ws://127.0.0.1:%d" % port, max_size=None) as ws:
        n = [0]

        async def call(method, **params):
            n[0] += 1
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": n[0], "method": method, "params": params}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == n[0]:
                    return m
        o = (await call("open_binary", path=binary, analysis="blocking"))["result"]
        assert o["persisted"], "probe needs an already analyzed (persisted) program"
        fns = (await call("list_functions"))["result"]
        res = {"functions": len(fns), "strings_total": (await call("list_strings", limit=1))["result"]["total"]}
        sample = json.load(open(ref))["sample"] if ref else [f["entry"] for f in fns[::20]]
        res["sample"] = sample
        entries = {f["entry"] for f in fns}
        res["sample_still_function_entries"] = sum(a in entries for a in sample)
        refs = calls = 0
        for a in sample:
            x = (await call("xrefs_to", address=a, limit=10000))["result"]
            refs += len(x); calls += sum("CALL" in r["type"] for r in x)
        res["xrefs_to_sample_total"], res["xrefs_to_sample_calls"] = refs, calls
        random.seed(2)
        fp = {"switch": 0, "undefined": 0, "lines": 0, "errors": 0, "n": 0}
        size = {f['entry']: f['size'] for f in fns}
        for a in sorted((a for a in sample if a in entries), key=lambda a: -size[a])[100:140]:  # mid-size: big enough to contain switches, small enough to finish
            r = await call("decompile", entry=a, timeoutSecs=20)
            if "error" in r:
                fp["errors"] += 1; continue
            t = r["result"]["text"]
            fp["n"] += 1; fp["switch"] += len(re.findall(r"\bswitch\s*\(", t)); fp["undefined"] += t.count("undefined"); fp["lines"] += t.count("\n") + 1
        res["decompile_fingerprint_40"] = fp
    p.stdin.close(); p.wait(timeout=30)
    json.dump(res, open(out, "w"), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != "sample"}, indent=1))

asyncio.run(main())

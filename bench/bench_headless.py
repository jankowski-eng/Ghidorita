#!/usr/bin/env python3
"""Baseline: Ghidra's own analyzeHeadless on one binary, wall time and peak RSS (JVM + native decompile children, sampled every 2 s).
Usage: bench_headless.py <binary> <out.json> [--fast]   (--fast: preScript FastProfile.java switches off the three fast-profile analyzers)
Needs JAVA_HOME (JDK 25) and GHIDRA_INSTALL_DIR like the sidecar. Uses a throwaway project; nothing else should be running."""
import argparse, glob, json, os, shutil, subprocess, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ap = argparse.ArgumentParser()
ap.add_argument("binary"); ap.add_argument("out"); ap.add_argument("--fast", action="store_true")
a = ap.parse_args()
G = os.environ.get("GHIDRA_INSTALL_DIR") or sorted(glob.glob(ROOT + "/ghidra-install/ghidra_*"))[-1]
env = dict(os.environ, JAVA_HOME=os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home"))


def tree(pid):
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,rss=,comm="], capture_output=True, text=True).stdout.split("\n")
    rows = [l.split(None, 3) for l in out if l.strip()]
    kids, rss, comm = {}, {}, {}
    for p, pp, r, c in rows:
        kids.setdefault(pp, []).append(p); rss[p] = int(r) / 1024; comm[p] = c
    jvm = nat = 0.0
    stack = [str(pid)]
    while stack:
        p = stack.pop()
        stack += kids.get(p, [])
        if comm.get(p, "").endswith("decompile"):
            nat += rss[p]
        elif comm.get(p, "").endswith("java"):
            jvm += rss[p]
    return jvm, nat


proj = tempfile.mkdtemp(prefix="hl-")
cmd = [G + "/support/analyzeHeadless", proj, "p", "-import", a.binary, "-deleteProject"]
if a.fast:
    cmd += ["-scriptPath", HERE + "/ghidra_scripts", "-preScript", "FastProfile.java"]
err = open(a.out.replace(".json", "") + ".stderr.log", "w")
t0 = time.monotonic()
p = subprocess.Popen(cmd, stdout=err, stderr=subprocess.STDOUT, env=env)
peak_j = peak_n = peak_sum = 0.0
samples = []
while p.poll() is None:
    j, n = tree(p.pid)
    peak_j, peak_n, peak_sum = max(peak_j, j), max(peak_n, n), max(peak_sum, j + n)
    samples.append((round(time.monotonic() - t0, 1), round(j), round(n)))
    time.sleep(2)
wall = time.monotonic() - t0
shutil.rmtree(proj, ignore_errors=True)
json.dump({"tool": "analyzeHeadless", "binary": a.binary, "size_mb": round(os.path.getsize(a.binary) / 1e6, 2), "fast": a.fast, "exit": p.returncode,
           "wall_s": round(wall, 1), "peak_jvm_mb": round(peak_j), "peak_native_decompile_mb": round(peak_n), "peak_total_mb": round(peak_sum),
           "samples": samples[::5]}, open(a.out, "w"), indent=1)
print(a.out, round(wall, 1), "s", round(peak_j), round(peak_n))

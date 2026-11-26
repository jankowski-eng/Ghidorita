import os, pathlib, time
HERE = pathlib.Path(__file__).resolve().parent
GHIDRA = os.environ.get("GHIDRA_INSTALL_DIR", str(HERE.parent / "ghidra-install/ghidra_12.3_DEV"))
JAVA_HOME = os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home")
PROJ = HERE / "projects"


def start_jvm():
    from pyghidra.launcher import HeadlessPyGhidraLauncher
    l = HeadlessPyGhidraLauncher(install_dir=pathlib.Path(GHIDRA))
    l.java_home = pathlib.Path(JAVA_HOME)
    l.start()


def build_index(prog):
    it = prog.getListing().getCodeUnits(prog.getMemory().getLoadedAndInitializedAddressSet(), True)
    return [cu.getMinAddress().getOffset() for cu in it]


def others_running():
    """Processes that distort a measurement: any Electron app (except Claude.app), sidecar, native decompiler or JVM that is not ours."""
    import subprocess
    me = {os.getpid()}
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout.splitlines()
    rows = [l.split(None, 2) for l in out if len(l.split(None, 2)) == 3]
    kids = True
    while kids:  # our own descendants
        kids = {int(p) for p, pp, _ in rows if int(pp) in me and int(p) not in me}
        me |= kids
    pat = ("node_modules/electron", "electron.app", "sidecar/main.py", "os/mac_arm_64/decompile", "bin/java", "/jre/", "bench_")
    return [c[:110] for p, pp, c in rows if int(p) not in me and "claude.app" not in c.lower() and "claude-code" not in c.lower() and "zsh -c" not in c
            and any(x in c for x in pat)]


def wait_quiet(max_wait_min=30, max_load=2.0):
    """Measure only on a quiet machine: wait (up to max_wait_min) until no other Electron/sidecar/decompile/JVM process runs and the 1-minute
    load average is below max_load for 3 checks in a row, else exit 3. Returns {"load1": .., "waited_s": ..} to store with the results."""
    import sys
    t0, ok = time.time(), 0
    while True:
        load1 = os.getloadavg()[0]
        others = others_running()
        ok = ok + 1 if (not others and load1 < max_load) else 0
        if ok >= 3:
            return {"load1_at_start": round(load1, 2), "waited_s": round(time.time() - t0)}
        if time.time() - t0 > max_wait_min * 60:
            print("machine not quiet after %d min (load %.1f, others: %s): not measuring" % (max_wait_min, load1, others[:5]), file=sys.stderr)
            sys.exit(3)
        time.sleep(20)

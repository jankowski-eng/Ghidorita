#!/usr/bin/env python3
"""Ghidra sidecar: JSON-RPC 2.0 over WebSocket (the contract and the threading rules: ../protocol.md; the code layout and the
thread model: ARCHITECTURE.md). This file only checks the environment, starts the JVM and serves."""
import asyncio, os, signal, sys, threading, time

from ghidrette.app import App
from ghidrette.core import jscans
from ghidrette.core.errors import log


def max_heap():
    """JVM -Xmx. Without it the JVM takes 1/4 of RAM (8 GB on a 32 GB Mac), which is neither tuned nor predictable.
    SIDECAR_MAXMEM (e.g. "6g") overrides; default is half of physical RAM, capped at 24 GB (leaves room for the
    native decompiler processes, the renderer and the OS)."""
    v = os.environ.get("SIDECAR_MAXMEM")
    if v:
        return v
    ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    return "%dm" % (min(ram // 2, 24 << 30) >> 20)


def main():
    if not os.environ.get("SIDECAR_TOKEN") and os.environ.get("SIDECAR_ALLOW_NO_AUTH") != "1":
        print("SIDECAR_TOKEN is not set: refusing to start without auth (SIDECAR_ALLOW_NO_AUTH=1 is the test-only escape)", file=sys.stderr)
        sys.exit(2)
    # keep real stdout for the port line only; JVM/Ghidra chatter goes to stderr
    out = os.fdopen(os.dup(1), "w")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    t0 = time.monotonic()
    if "GHIDRA_INSTALL_DIR" not in os.environ:
        sys.exit("GHIDRA_INSTALL_DIR not set")
    import pathlib
    import pyghidra
    from pyghidra.launcher import HeadlessPyGhidraLauncher
    launcher = HeadlessPyGhidraLauncher(install_dir=pathlib.Path(os.environ["GHIDRA_INSTALL_DIR"]))
    if os.environ.get("JAVA_HOME"):  # skip LaunchSupport JDK probing (it shells out to `java` on PATH)
        launcher.java_home = pathlib.Path(os.environ["JAVA_HOME"])
    launcher.add_vmargs("-Xmx%s" % max_heap())
    jscans.build()  # compile the Java helper before the JVM exists
    if os.environ.get("SIDECAR_ANALYSIS_CORES"):  # Ghidra sizes its analyzer thread pools (and so the native decompiler processes) from this
        launcher.add_vmargs("-Dcpu.core.limit=%s" % os.environ["SIDECAR_ANALYSIS_CORES"])
    launcher.add_vmargs("-Djava.awt.headless=true")  # else project code initialises AppKit from a non-main thread and hangs
    launcher.start()
    from java.lang import Runtime
    log("jvm start: %.2fs, max heap %d MB" % (time.monotonic() - t0, Runtime.getRuntime().maxMemory() // (1 << 20)))

    app = App()

    def watch_stdin():
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except Exception:
            pass
        app.server.shutdown()

    threading.Thread(target=watch_stdin, daemon=True).start()
    for _sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(_sig, lambda *_: threading.Thread(target=app.server.shutdown, daemon=True).start())
    asyncio.run(app.server.serve(out))


if __name__ == "__main__":
    main()

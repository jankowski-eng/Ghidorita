"""The debugger against a real QEMU (qemu-system-arm -M lm3s6965evb running testdata/fw/fw.bin, a Cortex-M3 loop calling work_a and work_b).
Skipped when qemu-system-arm is missing. The RSP client alone, without QEMU or a JVM: test_gdb.py."""
import asyncio, os, shutil, socket, subprocess, time

import pytest

from testlib import HERE, INVALID, Client, Proc, run

QEMU = shutil.which("qemu-system-arm") or ("/opt/homebrew/bin/qemu-system-arm" if os.path.exists("/opt/homebrew/bin/qemu-system-arm") else None)
FW = os.path.join(HERE, "testdata", "fw", "fw.bin")
WORK_A, WORK_B, MAIN, TARGET = "0x8", "0x18", "0x28", -32008


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def qemu():
    if not QEMU:
        pytest.skip("qemu-system-arm is not installed (brew install qemu): the debugger test needs a real gdbstub")
    port = free_port()
    p = subprocess.Popen([QEMU, "-M", "lm3s6965evb", "-kernel", FW, "-S", "-gdb", "tcp::%d" % port, "-display", "none", "-serial", "none"], stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            break
        except OSError:
            time.sleep(0.05)
    yield port
    p.kill()
    p.wait()


@pytest.fixture()
def proc(tmp_path):
    p = Proc(tmp_path)
    yield p
    p.stop()


async def stop_at(c, n=0, state="stopped", timeout=10):
    """The first debug_state notification after the first n whose state matches."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        got = [m["params"] for _, m in c.notes if m["method"] == "debug_state"]
        for i, st in enumerate(got[n:], n):
            if st["state"] == state:
                return i + 1, st
        await asyncio.sleep(0.02)
    raise AssertionError("no %s debug_state: %s" % (state, [m["params"] for _, m in c.notes if m["method"] == "debug_state"]))


def reg(st, name):
    return int(next(r["value"] for r in st["registers"] if r["name"] == name), 16)


def test_attach_break_continue_step_detach(qemu, proc):
    async def go():
        async with Client(proc.port) as c0:  # a connection that asks provider_info must send the session id on every program request: use another
            assert "debugger" in (await c0.ok("provider_info"))["capabilities"]
        async with Client(proc.port) as c:
            s = await c.ok("open_binary", path=FW, loader="Raw Binary", language="ARM:LE:32:Cortex", baseAddress="0x0")
            assert "refused" in (await c.call("debug_attach", host="127.0.0.1", port=free_port()))["error"]["message"].lower()
            await c.err("debug_breakpoint", INVALID, address="work_a")
            await c.ok("debug_breakpoint", address=WORK_A)  # set before attaching: installed on attach
            await c.ok("debug_attach", host="127.0.0.1", port=qemu)
            n, st = await stop_at(c)
            assert st["address"] == MAIN and st["breakpoints"] == [WORK_A] and st["target"] == "127.0.0.1:%d" % qemu, st
            assert {"r0", "sp", "lr", "pc"} <= {r["name"] for r in st["registers"]}, st
            await c.ok("debug_continue")
            assert (await stop_at(c, n, "running"))[1]["state"] == "running"
            n, st = await stop_at(c, n)
            assert st["address"] == WORK_A and reg(st, "pc") == 0x8, st
            assert reg(st, "lr") == 0x2d, hex(reg(st, "lr"))  # work_a was called from main_loop (bl at 0x28, Thumb return address 0x2c|1)
            await c.ok("debug_step")
            n, st2 = await stop_at(c, n)
            assert 0x8 < int(st2["address"], 16) < 0x18, st2["address"]
            await c.ok("debug_continue")  # leaves work_a, runs the loop round and stops at the breakpoint again
            n, st3 = await stop_at(c, n)
            assert st3["address"] == WORK_A
            await c.ok("debug_breakpoint", address=WORK_A)  # toggled off while stopped
            assert (await stop_at(c, n, "stopped"))[1]["breakpoints"] == []
            await c.ok("debug_continue")
            await asyncio.sleep(0.3)
            await c.ok("debug_pause")
            n, st4 = await stop_at(c, n)
            assert st4["state"] == "stopped" and int(st4["address"], 16) < 0x40
            await c.ok("debug_detach")
            assert (await stop_at(c, n, "detached"))[1]["state"] == "detached"
            assert (await c.ok("debug_status"))["state"] == "detached"
            await c.err("debug_step", TARGET)
    run(go())


def test_wrong_architecture(qemu, proc):
    async def go():
        async with Client(proc.port) as c:
            await c.ok("open_binary", path=FW, loader="Raw Binary", language="x86:LE:32:default", baseAddress="0x0")
            r = await c.call("debug_attach", host="127.0.0.1", port=qemu)
            assert "architecture" in r["error"]["message"].lower(), r
            assert (await c.ok("debug_status"))["state"] == "detached"
    run(go())

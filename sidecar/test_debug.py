"""The debugger against a real QEMU (qemu-system-arm -M lm3s6965evb running testdata/fw/fw.bin, a Cortex-M3 loop calling work_a and work_b).
Skipped when qemu-system-arm is missing. The RSP client alone, without QEMU or a JVM: test_gdb.py."""
import asyncio, os, shutil, socket, subprocess, time

import pytest

from testlib import HERE, INVALID, Client, Proc, run

QEMU = shutil.which("qemu-system-arm") or ("/opt/homebrew/bin/qemu-system-arm" if os.path.exists("/opt/homebrew/bin/qemu-system-arm") else None)
FW = os.path.join(HERE, "testdata", "fw", "fw.bin")
WORK_A, WORK_B, MAIN, SCALE, TARGET = "0x8", "0x18", "0x28", "0x54", -32008
FACT = "0xa4"


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
            assert reg(st, "lr") == 0x3d, hex(reg(st, "lr"))  # work_a was called from main_loop (bl at 0x38, Thumb return address 0x3c|1)
            await c.ok("debug_step")
            n, st2 = await stop_at(c, n)
            assert 0x8 < int(st2["address"], 16) < 0x18, st2["address"]
            await c.ok("debug_continue")  # leaves work_a, runs the loop round and stops at the breakpoint again
            n, st3 = await stop_at(c, n)
            assert st3["address"] == WORK_A
            await c.ok("debug_breakpoint", address=WORK_A)  # toggled off while stopped
            n, st = await stop_at(c, n, "stopped")  # the toggle announces the same stop again
            assert st["breakpoints"] == []
            await c.ok("debug_continue")
            n, _ = await stop_at(c, n, "running")
            await asyncio.sleep(0.3)
            await c.ok("debug_pause")
            n, st4 = await stop_at(c, n)  # a stop after the pause (the cursor is past the running announcement)
            assert st4["state"] == "stopped" and st4["stop"] > st["stop"] and int(st4["address"], 16) < 0x100, st4  # anywhere in the image, `scale` and `fact` included
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


def test_statement_step(qemu, proc):
    """Statement steps in main_loop run over the calls, stop at the boundaries of main_loop, and a breakpoint inside a called function ends the step there."""
    async def go():
        async with Client(proc.port) as c:
            await open_fw(c)
            toks = (await c.ok("decompile", entry=MAIN))["tokens"]
            first = {}
            for t in toks:
                if t.get("address"):
                    first[t["line"]] = min(first.get(t["line"], int(t["address"], 16)), int(t["address"], 16))
            bounds = sorted(hex(a) for a in first.values())
            assert len(bounds) >= 2, toks
            await c.err("debug_step", INVALID, mode="statement")
            await c.ok("debug_attach", host="127.0.0.1", port=qemu)
            n, st = await stop_at(c)
            for _ in range(3):  # never inside work_a / work_b (0x8..0x27): the calls are run over
                await c.ok("debug_step", mode="statement", boundaries=bounds)
                assert (await stop_at(c, n, "running"))[1]["state"] == "running"
                n, st = await stop_at(c, n)
                assert st["address"] in bounds and int(st["address"], 16) >= 0x28, (st["address"], bounds)
            await c.ok("debug_breakpoint", address=WORK_B)
            n, _ = await stop_at(c, n)  # the toggle announces the same stop again
            for _ in range(4):
                await c.ok("debug_step", mode="statement", boundaries=bounds)
                n, st = await stop_at(c, n)
                if st["address"] == WORK_B:
                    break
            assert st["address"] == WORK_B, st["address"]  # the breakpoint inside the call ended the step
            await c.ok("debug_detach")
    run(go())


async def open_fw(c):
    await c.ok("open_binary", path=FW, loader="Raw Binary", language="ARM:LE:32:Cortex", baseAddress="0x0")
    await c.ok("clear_code", address=WORK_A, length=os.path.getsize(FW) - 8)  # a raw image has no functions yet: the analysis left data after the vectors
    for a, n in ((WORK_A, "work_a"), (WORK_B, "work_b"), (MAIN, "main_loop"), (SCALE, "scale"), (FACT, "fact")):
        await c.call("create_function", address=a, name=n)  # a call target may already have become a function
    assert {WORK_A, WORK_B, MAIN, SCALE, FACT} <= {f["entry"] for f in await c.ok("list_functions")}


def test_memory_values_into_out_and_live_breakpoints(qemu, proc):
    async def go():
        async with Client(proc.port) as c:
            await open_fw(c)
            await c.err("debug_memory", TARGET, address="0x20000000")  # not attached
            assert "offset" in (await c.call("debug_attach", host="127.0.0.1", port=qemu, offset="zz"))["error"]["message"]
            await c.ok("debug_breakpoint", address=WORK_A)
            await c.ok("debug_attach", host="127.0.0.1", port=qemu, offset="0x0")
            n, st = await stop_at(c)
            await c.ok("debug_continue")
            n, st = await stop_at(c, n)
            assert st["address"] == WORK_A
            # memory: the global counter at 0x20000000, raw and through types
            m = await c.ok("debug_memory", address="0x20000000", length=8)
            assert m["bytes"] == "00" * 8 and "items" not in m, m
            t = await c.ok("debug_memory", address="0x20000000", dataType="uint[2]")
            assert [i["name"] for i in t["items"]] == ["[0]", "[1]"] and t["items"][0]["type"] == "uint", t
            await c.err("debug_memory", INVALID, address="0x20000000", dataType="no_such_type")
            await c.err("debug_memory", TARGET, address="0xf0000000", length=4)  # unmapped
            # values: the function's variables, here the global written by work_a
            v = await c.ok("debug_values", entry=WORK_A)
            g = next(i for i in v["items"] if i["kind"] == "global")
            assert g["where"] == "0x20000000" and g["size"] == 4 and g["raw"] == "0x00000000", v
            # a statement step out of work_a lands in main_loop, and the counter has changed
            await c.ok("debug_breakpoint", address=WORK_A)  # off: the next loop must not stop here
            n, _ = await stop_at(c, n)
            await c.ok("debug_step", mode="out")
            n, st = await stop_at(c, n)
            assert int(st["address"], 16) >= 0x28, st["address"]
            assert (await c.ok("debug_values", entry=WORK_A))["items"][0]["raw"] == "0x00000001"
            # step into: from the call in main_loop to the callee's entry (work_b); main_loop is not decompiled for boundaries here, so use its own
            toks = (await c.ok("decompile", entry=MAIN))["tokens"]
            starts = sorted({t["address"] for t in toks if t.get("address")})
            await c.ok("debug_step", mode="into", boundaries=starts)
            n, st = await stop_at(c, n)
            assert st["address"] in (WORK_A, WORK_B, *starts), st["address"]
            # breakpoint toggled while running: no stop is announced, the breakpoint works
            await c.ok("debug_breakpoint", address=WORK_B)
            n, _ = await stop_at(c, n)
            await c.ok("debug_continue")
            await stop_at(c, n, "running")
            n2 = len([1 for _, m in c.notes if m["method"] == "debug_state"])
            await c.ok("debug_breakpoint", address=WORK_A)
            n3, st = await stop_at(c, n2, "stopped")  # the toggle's own announcement is `running`-state; the next stop is a breakpoint hit
            assert st["address"] in (WORK_A, WORK_B), st
            await c.ok("debug_detach")
    run(go())


QEMU64 = shutil.which("qemu-system-aarch64") or ("/opt/homebrew/bin/qemu-system-aarch64" if os.path.exists("/opt/homebrew/bin/qemu-system-aarch64") else None)
FW64 = os.path.join(HERE, "testdata", "fw64", "fw.bin")
LEAF, MAIN64, BASE64 = "0x4020000c", "0x402000a8", "0x40200000"


@pytest.fixture()
def qemu64():
    if not QEMU64:
        pytest.skip("qemu-system-aarch64 is not installed (brew install qemu)")
    port = free_port()
    p = subprocess.Popen([QEMU64, "-M", "virt", "-cpu", "cortex-a57", "-device", "loader,file=%s,addr=0x40200000" % FW64, "-device", "loader,addr=0x40200000,cpu-num=0",
                          "-S", "-gdb", "tcp::%d" % port, "-display", "none", "-serial", "none"], stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            break
        except OSError:
            time.sleep(0.05)
    yield port
    p.kill()
    p.wait()


def test_aarch64_registers_and_stack_values(qemu64, proc):
    """A second architecture: the register names map through Ghidra's AARCH64 language, and -O0 code keeps parameters and locals on the stack."""
    async def go():
        async with Client(proc.port) as c:
            await c.ok("open_binary", path=FW64, loader="Raw Binary", language="AARCH64:LE:64:v8A", baseAddress=BASE64)
            await c.ok("clear_code", address=BASE64, length=0x118)
            for a, n in ((LEAF, "leaf"), (MAIN64, "main_loop")):
                await c.call("create_function", address=a, name=n)  # the analysis may have found it already
            assert {LEAF, MAIN64} <= {f["entry"] for f in await c.ok("list_functions")}
            await c.ok("debug_breakpoint", address=LEAF)  # at the entry: leaf's ninth parameter is on the stack at sp
            await c.ok("debug_attach", host="127.0.0.1", port=qemu64)
            n, st = await stop_at(c)
            assert {"x0", "x30", "sp", "pc"} <= {r["name"] for r in st["registers"]}, [r["name"] for r in st["registers"]]
            await c.ok("debug_continue")
            n, st = await stop_at(c, n)
            assert st["address"] == LEAF, st["address"]
            v = await c.ok("debug_values", entry=LEAF)
            params = [i for i in v["items"] if i["kind"] == "param"]
            assert len(params) == 9 and params[0]["raw"] == "0x00000000" and params[1]["raw"] == "0x00000002", params  # leaf(0, 2, ...) on the first loop, from w0 and w1
            stack = [i for i in params if i["where"].startswith("stack")]
            assert [i["raw"] for i in stack] == ["0x00000009"], params  # the ninth argument: read from the frame at sp-at-entry + 0
            m = await c.ok("debug_memory", address=next(r["value"] for r in st["registers"] if r["name"] == "sp"), length=16)
            assert len(m["bytes"]) == 32
            await c.ok("debug_detach")
    run(go())


def test_stack_parameters_of_an_unoptimised_function(qemu, proc):
    """scale() takes six parameters: e and f are passed on the stack. After its `sub sp, #0x20` Ghidra knows the stack depth, so the values read them at sp-at-entry + their offset."""
    async def go():
        async with Client(proc.port) as c:
            await open_fw(c)
            await c.ok("debug_breakpoint", address=hex(int(SCALE, 16) + 2))  # after the sub sp
            await c.ok("debug_attach", host="127.0.0.1", port=qemu)
            n, st = await stop_at(c)
            await c.ok("debug_continue")
            n, st = await stop_at(c, n)
            assert st["address"] == hex(int(SCALE, 16) + 2), st["address"]
            v = await c.ok("debug_values", entry=SCALE)
            stack = [i for i in v["items"] if i["where"].startswith("stack")]
            assert [i["raw"] for i in stack] == ["0x00000005", "0x00000006"], v  # scale(counter, 2, 3, 4, 5, 6): e and f from the frame
            await c.ok("debug_detach")
    run(go())


def test_step_out_of_a_recursive_function(qemu, proc):
    """fact(3) calls itself: step out from the outer frame runs the inner calls over (their returns land inside the same body, one frame deeper) and stops in scale."""
    async def go():
        async with Client(proc.port) as c:
            await open_fw(c)
            await c.ok("debug_breakpoint", address=FACT)
            await c.ok("debug_attach", host="127.0.0.1", port=qemu)
            n, st = await stop_at(c)
            await c.ok("debug_continue")
            n, st = await stop_at(c, n)
            assert st["address"] == FACT, st["address"]
            await c.ok("debug_breakpoint", address=FACT)  # off: the inner calls must not stop the step
            n, _ = await stop_at(c, n)
            await c.ok("debug_step", mode="out")
            n, st = await stop_at(c, n, "stopped")
            assert int(SCALE, 16) <= int(st["address"], 16) < int(FACT, 16), st["address"]  # back in scale, not in a deeper fact frame
            await c.ok("debug_detach")
    run(go())


def test_replacing_the_program_tears_the_debugger_down(qemu, proc):
    """The connection, the breakpoints and a step worker belong to the program: opening another one drops them, and the next attach starts clean."""
    async def go():
        async with Client(proc.port) as c:
            await open_fw(c)
            await c.ok("debug_breakpoint", address=WORK_A)
            await c.ok("debug_attach", host="127.0.0.1", port=qemu)
            n, st = await stop_at(c)
            await c.ok("open_binary", path=FW, loader="Raw Binary", language="ARM:LE:32:Cortex", baseAddress="0x1000")  # another program key: a replacement
            n, st = await stop_at(c, n, "detached")
            s = await c.ok("debug_status")
            assert s["state"] == "detached" and s["breakpoints"] == [] and not s.get("error"), s
            await c.ok("debug_attach", host="127.0.0.1", port=qemu)  # the gdbstub took the old client's disconnect: a new attach works
            n, st = await stop_at(c, n)
            assert st["breakpoints"] == [], st
            await c.ok("debug_detach")
    run(go())

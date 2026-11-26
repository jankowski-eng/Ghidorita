"""Background analysis (Round 7) against real Ghidra on /bin/ls and a raw blob: open returns before the analysis ends, reads work meanwhile,
edits/undo are Busy meanwhile, cancel, close/save/shutdown leave `partial`, reopen resumes, fast -> full keeps the programId."""
import asyncio, json, os, time

from testlib import BIN, BUSY, Client, Proc, run

BG = dict(path=BIN, analysis="background")


async def wait_state(c, want, timeout=180):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        st = await c.ok("analysis_status")
        if st["state"] in want:
            return st
        await asyncio.sleep(0.1)
    raise AssertionError("analysis never reached %s: %s" % (want, st))


async def programs(c):
    return {p["programId"]: p for p in await c.ok("list_programs")}


async def first_address(c):
    return (await c.ok("listing_info"))["ranges"][0]["start"]


async def free_address(c):
    """An address with no label (create_label validates before the transaction, so Busy needs a valid request)."""
    return "0x%x" % (int((await first_address(c)), 16) + 4)


def test_background_open_reads_busy_edits_and_finishes(tmp_path):
    proc = Proc(tmp_path / "projects")

    async def go():
        async with Client(proc.port) as c:
            t = time.monotonic()
            r = await c.ok("open_binary", **BG)
            reply_s = time.monotonic() - t
            assert r["analysis"]["state"] == "running" and r["analysis"]["analysis"] == "partial"
            st = await c.ok("analysis_status")
            assert st["state"] == "running", "the reply must come before the analysis ends"
            n0 = len(await c.ok("list_functions"))
            # reads work while it runs (each one measured: they never wait for the analysis)
            a = await first_address(c)
            for _ in range(5):
                t = time.monotonic()
                rows = await c.ok("listing_rows", address=a, count=50)
                assert rows and time.monotonic() - t < 2
            # edits, undo and redo are Busy: a second transaction would join the analysis one
            await c.err("create_label", BUSY, address=await free_address(c), name="mine")
            await c.err("undo", BUSY)
            await c.err("redo", BUSY)
            await c.err("start_analysis", BUSY)
            pid = r["programId"]
            assert (await programs(c))[pid]["analysis"] == "partial"
            end = await wait_state(c, ("done", "failed", "cancelled"))
            assert end["state"] == "done" and end["analysis"] == "done" and end["pct"] == 100
            n1 = len(await c.ok("list_functions"))
            assert n1 > n0, (n0, n1)
            ev = c.take("analysis_state")
            assert ev[0]["state"] == "running" and ev[-1]["state"] == "done"
            assert any(e["analyzer"] for e in ev), "no analyzer name seen"
            assert any(m["method"] == "program_changed" and m["params"]["ranges"] is None for _, m in c.notes), "no refresh during/after analysis"
            p = (await programs(c))[pid]
            assert p["analysis"] == "done" and p["analyzed"] is True and p["analysisProfile"] == "full"
            # edits work again and undo only touches the edit, not the analysis
            await c.ok("create_label", address=await free_address(c), name="mine")
            assert (await c.ok("undo_state"))["canUndo"] is True
            await c.ok("undo")
            assert (await c.ok("undo_state"))["canUndo"] is False
            assert len(await c.ok("list_functions")) == n1
            assert (await c.ok("start_analysis"))["state"] == "done"  # nothing to do
    run(go())
    proc.stop()


def test_cancel_then_edit_then_reopen_resumes(tmp_path):
    d = tmp_path / "projects"
    proc = Proc(d)

    async def go():
        async with Client(proc.port) as c:
            r = await c.ok("open_binary", **BG)
            pid = r["programId"]
            await asyncio.sleep(1.5)
            assert (await c.ok("cancel_analysis")) == {"cancelled": True}
            st = await wait_state(c, ("cancelled", "done"))
            assert st["state"] == "cancelled" and st["analysis"] == "partial"
            assert await c.ok("cancel_analysis") == {"cancelled": False}
            assert (await programs(c))[pid]["analysis"] == "partial"
            a = await first_address(c)
            await c.ok("listing_rows", address=a, count=10)  # the program stays usable
            await c.ok("create_label", address=await free_address(c), name="after_cancel")  # edits work again, on their own undo entry
            assert (await c.ok("undo_state"))["undoName"]
            await c.ok("undo")
            return pid
    pid = run(go())
    proc.stop()
    proc = Proc(d)

    async def again():
        async with Client(proc.port) as c:
            assert (await programs(c))[pid]["analysis"] == "partial"
            r = await c.ok("open_binary", **BG)
            assert r["persisted"] is True and r["programId"] == pid
            assert r["analysis"]["state"] == "running", "a partial program must resume, not sit half done"
            await wait_state(c, ("done",))
            assert (await programs(c))[pid]["analysis"] == "done"
    run(again())
    proc.stop()
    proc = Proc(d)

    async def third():
        async with Client(proc.port) as c:
            r = await c.ok("open_binary", **BG)
            assert r["persisted"] is True and r["analysis"]["state"] == "idle" and r["analysis"]["analysis"] == "done"
    run(third())
    proc.stop()


def test_save_close_and_shutdown_during_analysis_leave_partial(tmp_path):
    d = tmp_path / "projects"
    proc = Proc(d)

    async def go():
        async with Client(proc.port) as c:
            pid = (await c.ok("open_binary", **BG))["programId"]
            await asyncio.sleep(1)
            assert (await c.ok("save"))["saved"] in (True, False)  # cancels the analysis first
            st = await c.ok("analysis_status")
            assert st["state"] == "cancelled" and st["analysis"] == "partial"
            await c.ok("start_analysis")  # resume ...
            assert (await c.ok("analysis_status"))["state"] == "running"
            await c.ok("close_program")  # ... and close while it runs
            assert (await programs(c))[pid]["analysis"] == "partial"
            r = await c.ok("open_binary", **BG)  # resumed again
            assert r["analysis"]["state"] == "running"
            return pid
    pid = run(go())
    t = time.monotonic()
    proc.stop()  # shutdown during the analysis: cancels it, saves partial, releases the project lock
    assert time.monotonic() - t < 15 and proc.p.returncode is not None
    proc = Proc(d)

    async def after():
        async with Client(proc.port) as c:  # opening the project works: the lock was released
            assert (await programs(c))[pid]["analysis"] == "partial"
    run(after())
    proc.stop()
    meta = json.load(open(d / "programs.json"))
    assert meta[pid]["analysis"] == "partial"


def test_fast_then_full_keeps_program_id(tmp_path):
    proc = Proc(tmp_path / "projects")

    async def go():
        async with Client(proc.port) as c:
            r = await c.ok("open_binary", profile="fast", **BG)
            pid = r["programId"]
            await wait_state(c, ("done",))
            p = (await programs(c))[pid]
            assert p["analysis"] == "done" and p["analysisProfile"] == "fast"
            n_fast = len(await c.ok("list_functions"))
            assert (await c.ok("start_analysis", profile="fast"))["state"] == "done"  # no-op
            up = await c.ok("start_analysis", profile="full")
            assert up["state"] == "running" and up["profile"] == "full"
            await wait_state(c, ("done",))
            p = (await programs(c))[pid]
            assert p["programId"] == pid and p["analysis"] == "done" and p["analysisProfile"] == "full"
            assert len(await c.ok("list_functions")) >= n_fast
            assert len(await programs(c)) == 1  # no second program: same key
    run(go())
    proc.stop()


def test_raw_blob_background(tmp_path):
    blob = tmp_path / "blob.bin"
    blob.write_bytes((bytes.fromhex("1f2003d5") * 255) + bytes.fromhex("c0035fd6"))  # nop ... ret (AArch64)
    proc = Proc(tmp_path / "projects")

    async def go():
        async with Client(proc.port) as c:
            r = await c.ok("open_binary", path=str(blob), loader="Raw Binary", language="AARCH64:LE:64:v8A", compilerSpec="default",
                           baseAddress="0x100000", analysis="background")
            assert r["analysis"]["state"] in ("running", "done")
            st = await wait_state(c, ("done",), 120)
            assert st["analysis"] == "done"
            assert (await c.ok("listing_info"))["totalBytes"] == 1024
    run(go())
    proc.stop()

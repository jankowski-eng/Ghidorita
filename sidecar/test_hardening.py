"""Round 6 (hardening): defects that were reproduced, each with the test that fails on the old code. Real Ghidra on /bin/ls (one analysis, copied per test)."""
import asyncio, os

from ghidrette.core.errors import RpcError
from ghidrette.domains import search
from testlib import BIN, CANCELLED, Client, INVALID, NOT_FOUND, NO_PROGRAM, Proc, run
from test_persist import base, projects  # noqa: F401  (fixtures)


def test_stale_read_is_retried_once():
    """list_symbols racing an edit: the first attempt meets a deleted symbol, the retry runs on a fresh snapshot."""
    class Fake:
        cleared, calls = 0, 0

        def snap_clear(self):
            self.cleared += 1

        @search.retry_stale
        def read(self, stale_times):
            self.calls += 1
            if self.calls <= stale_times:
                raise search.StaleRead("symbol gone")
            return "page"
    f = Fake()
    assert f.read(1) == "page" and f.calls == 2 and f.cleared == 1
    g = Fake()
    try:
        g.read(2)
        raise AssertionError("two stale reads in a row must fail")
    except RpcError as e:
        assert e.code == CANCELLED and "retry" in str(e) and g.calls == 2


def test_clear_code_inside_a_defined_unit(projects):
    """clear_code on a range inside one defined data unit (the Mach-O header): units overlapping the range are cleared whole, nothing else changes.
    Before: refused with 'no instructions or defined data in range' because getCodeUnits(view) only yields units that start in the view."""
    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                await c.ok("open_binary", path=BIN)
                info = await c.ok("listing_info")
                rows = await c.ok("listing_rows", address=info["ranges"][0]["start"], count=12)
                unit = next(r for r in rows if r["length"] >= 16 and not r["mnemonic"].isupper())  # a defined data unit (segment_command)
                start = int(unit["address"], 16)
                fns = await c.ok("list_functions")
                code_before = [r for r in await c.ok("listing_rows", address=fns[0]["entry"], count=400) if r["mnemonic"].isupper()]
                await c.ok("clear_code", address=hex(start + 8), length=8)
                after = await c.ok("listing_rows", address=hex(start), count=1)
                assert after[0]["mnemonic"] != unit["mnemonic"]  # the whole unit went
                assert await c.ok("list_functions") == fns
                assert [r for r in await c.ok("listing_rows", address=fns[0]["entry"], count=400) if r["mnemonic"].isupper()] == code_before
                await c.ok("undo")
                assert (await c.ok("listing_rows", address=hex(start), count=1))[0]["mnemonic"] == unit["mnemonic"]
                assert await c.ok("list_functions") == fns
                await c.err("clear_code", INVALID, address=hex(start), length=0)
        finally:
            proc.stop()
    run(go())


def test_failed_open_leaves_no_program(projects, tmp_path):
    """One end state for every failed open_binary: no program open (before: bad arguments kept the old one open, a failure after the close did not)."""
    unreadable = tmp_path / "unreadable"
    unreadable.write_bytes(b"x" * 64)
    unreadable.chmod(0)

    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                for what, code, kw in (("missing file", NOT_FOUND, dict(path="/no/such/file")),
                                       ("unknown loader", INVALID, dict(path=BIN, loader="No Such Loader")),
                                       ("bad profile", INVALID, dict(path=BIN, profile="turbo")),
                                       ("unreadable file", -32603, dict(path=str(unreadable)))):
                    await c.ok("open_binary", path=BIN)
                    await c.ok("list_functions")
                    await c.err("open_binary", code, **kw)
                    for m in ("list_functions", "undo_state", "listing_info"):
                        await c.err(m, NO_PROGRAM)
                    assert (await c.ok("close_program")) == {}  # idempotent
                    assert any(p["analyzed"] for p in await c.ok("list_programs")), what  # the old program's analysis is still stored
                r = await c.ok("open_binary", path=BIN)  # and the sidecar is fine
                assert r["persisted"] is True and await c.ok("list_functions")
        finally:
            unreadable.chmod(0o600)
            proc.stop()
    run(go())


def test_no_program_changed_after_close(projects):
    """An edit followed at once by close_program: the coalescer's pending emit (armed flag) must not fire for the closed program."""
    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                await c.ok("open_binary", path=BIN)
                f = (await c.ok("list_functions"))[3]
                i1 = await c.send("rename_symbol", address=f["entry"], newName="close_race_probe")
                i2 = await c.send("close_program")
                assert "result" in await c.reply(i1) and "result" in await c.reply(i2)
                n = len(c.notes)
                await asyncio.sleep(0.3)  # the 50 ms coalescer timer has long fired
                late = [m["params"] for _, m in c.notes[n:] if m["method"] == "program_changed"]
                assert late == [], late
                # a later edit on a reopened program still notifies (armed flag not stuck)
                await c.ok("open_binary", path=BIN)
                n = len(c.notes)
                await c.ok("rename_symbol", address=f["entry"], newName="close_race_probe2")
                assert (await c.wait_note("program_changed", since=n))
        finally:
            proc.stop()
    run(go())

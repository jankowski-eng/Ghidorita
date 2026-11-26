"""Round 9 (hardening): defects that were reproduced, each with the test that fails on the old code. Real Ghidra on /bin/ls (one analysis, copied per test)."""
import asyncio

from ghidrette.core.errors import INTERNAL, RpcError
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
                # the reported case: clearing 8 bytes at 0x100000028 of /bin/ls was said to remove the instructions of the function at
                # 0x100000812. Not reproducible (before the fix the call was refused, after it only the header unit goes); pinned here.
                f812 = next((f for f in fns if f["entry"] == "0x100000812"), None)
                rows812 = await c.ok("listing_rows", address="0x100000812", count=60) if f812 else None
                await c.ok("clear_code", address=hex(start + 8), length=8)
                after = await c.ok("listing_rows", address=hex(start), count=1)
                assert after[0]["mnemonic"] != unit["mnemonic"]  # the whole unit went
                assert await c.ok("list_functions") == fns
                assert [r for r in await c.ok("listing_rows", address=fns[0]["entry"], count=400) if r["mnemonic"].isupper()] == code_before
                if f812:
                    assert await c.ok("listing_rows", address="0x100000812", count=60) == rows812
                    assert (await c.ok("get_function_at", address="0x100000812"))["entry"] == "0x100000812"
                await c.ok("undo")
                assert (await c.ok("listing_rows", address=hex(start), count=1))[0]["mnemonic"] == unit["mnemonic"]
                if f812:
                    assert await c.ok("listing_rows", address="0x100000812", count=60) == rows812
                assert await c.ok("list_functions") == fns
                await c.err("clear_code", INVALID, address=hex(start), length=0)
        finally:
            proc.stop()
    run(go())


def test_failed_open_preserves_program(projects, tmp_path):
    """Failed opens leave the current program, listing, and undo history intact."""
    unreadable = tmp_path / "unreadable"
    unreadable.write_bytes(b"x" * 64)
    unreadable.chmod(0)

    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                await c.err("open_binary", NOT_FOUND, path="/no/such/file")
                await c.err("list_functions", NO_PROGRAM)
                await c.ok("open_binary", path=BIN)
                f = (await c.ok("list_functions"))[0]
                await c.ok("rename_symbol", address=f["entry"], newName="open_hardening_probe")
                reads = ("list_functions", "undo_state", "listing_info")
                before = {m: await c.ok(m) for m in reads}
                assert before["undo_state"]["canUndo"] and before["undo_state"]["dirty"]
                for code, kw in ((NOT_FOUND, dict(path="/no/such/file")),
                                 (INVALID, dict(path=BIN, loader="No Such Loader")),
                                 (INVALID, dict(path=BIN, profile="turbo")),
                                 (INTERNAL, dict(path=str(unreadable)))):
                    await c.err("open_binary", code, **kw)
                    assert {m: await c.ok(m) for m in reads} == before
                await c.ok("undo")
                assert (await c.ok("get_function_at", address=f["entry"]))["name"] == f["name"]
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

"""Persistence, save, define_data / clear_code against real Ghidra on /bin/ls. One analysis (module fixture) is copied per test."""
import asyncio, glob, os, shutil, signal, time
from pathlib import Path

import pytest

from ghidorita.core.errors import INTERNAL
from testlib import BASE, BIN, INVALID, NOT_FOUND, NO_PROGRAM, X86, Client, Proc, blob, run


@pytest.fixture(scope="module")
def base(tmp_path_factory):
    d = tmp_path_factory.mktemp("base") / "projects"
    proc = Proc(d)

    async def go():
        async with Client(proc.port) as c:
            r = await c.ok("open_binary", path=BIN)
            assert r["persisted"] is False
            # a freshly imported + analyzed + saved program is clean and has nothing to save
            assert await c.ok("undo_state") == {"canUndo": False, "canRedo": False, "dirty": False}
            assert await c.ok("save") == {"saved": False}
    run(go())
    proc.stop()
    return d


@pytest.fixture
def projects(base, tmp_path):
    d = tmp_path / "projects"
    shutil.copytree(base, d)
    return d


async def change(c, since, undo_name):
    """The program_changed that carries this undo label (a rolled-back failure fires its own, earlier, broad one)."""
    end = time.monotonic() + 3
    while time.monotonic() < end:
        for _, m in c.notes[since:]:
            if m["method"] == "program_changed" and m["params"]["undo"].get("undoName") == undo_name:
                return m["params"]
        await asyncio.sleep(0.01)
    raise AssertionError("no program_changed for " + undo_name)


async def fn5(c):
    return (await c.ok("list_functions"))[5]["entry"]


async def name_at(c, a):
    return (await c.ok("get_function_at", address=a))["name"]


async def reopen_name(projects, a):
    proc = Proc(projects)
    try:
        async with Client(proc.port) as c:
            r = await c.ok("open_binary", path=BIN)
            return r["persisted"], await name_at(c, a)
    finally:
        proc.stop()


def test_clean_reopen_and_nothing_to_save(projects):
    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                assert (await c.ok("open_binary", path=BIN))["persisted"] is True
                assert await c.ok("undo_state") == {"canUndo": False, "canRedo": False, "dirty": False}
                assert await c.ok("save") == {"saved": False}
                await c.err("define_data", INVALID, address="0x1", dataType="int")
        finally:
            proc.stop()
    run(go())


def test_save_then_close_and_autosave_on_close(projects):
    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                await c.ok("open_binary", path=BIN)
                a = await fn5(c)
                await c.ok("rename_symbol", address=a, newName="persist_one")
                n = len(c.notes)
                st = await c.ok("undo_state")
                assert st["dirty"] is True and st["canUndo"]
                assert (await c.wait_note("program_changed", since=0))[-1]["undo"]["dirty"] is True
                assert await c.ok("save") == {"saved": True}
                # Ghidra's save drops the undo/redo stacks; clients learn it from program_changed (empty ranges/kinds)
                ev = (await c.wait_note("program_changed", since=n))[-1]
                assert ev["ranges"] == [] and ev["kinds"] == [] and ev["undo"] == {"canUndo": False, "canRedo": False, "dirty": False}
                assert await c.ok("undo_state") == ev["undo"]
                assert await c.ok("save") == {"saved": False}
                # autosave when the program is closed: reopening replaces it
                await c.ok("rename_symbol", address=a, newName="persist_two")
                assert (await c.ok("open_binary", path=BIN))["persisted"] is True
                assert await name_at(c, a) == "persist_two"
                assert (await c.ok("undo_state"))["dirty"] is False
        finally:
            proc.stop()
        return a
    a = run(go())
    assert asyncio.run(reopen_name(projects, a)) == (True, "persist_two")


@pytest.mark.parametrize("how", ["stdin_eof", "sigterm"])
def test_shutdown_saves(projects, how):
    async def go():
        proc = Proc(projects)
        async with Client(proc.port) as c:
            await c.ok("open_binary", path=BIN)
            a = await fn5(c)
            await c.ok("rename_symbol", address=a, newName="persist_shutdown")
            assert (await c.ok("undo_state"))["dirty"] is True
        t = time.monotonic()
        if how == "stdin_eof":
            proc.p.stdin.close()  # Electron died
        else:
            proc.p.send_signal(signal.SIGTERM)
        assert proc.p.wait(timeout=60) == 0
        print(how, "exit after %.2fs" % (time.monotonic() - t))
        return a
    a = run(go())
    assert asyncio.run(reopen_name(projects, a)) == (True, "persist_shutdown")


def test_sigkill_loses_unsaved_but_keeps_saved(projects):
    async def go():
        proc = Proc(projects)
        async with Client(proc.port) as c:
            await c.ok("open_binary", path=BIN)
            a = await fn5(c)
            old = await name_at(c, a)
            await c.ok("rename_symbol", address=a, newName="saved_name")
            await c.ok("save")
            await c.ok("rename_symbol", address=a, newName="unsaved_name")
        proc.p.kill()
        proc.p.wait()
        return a, old
    a, old = run(go())
    persisted, name = asyncio.run(reopen_name(projects, a))
    assert persisted is True and name == "saved_name"  # old version intact, in-memory edit lost


def test_snapshot_survives_sigkill(projects):
    async def go():
        proc = Proc(projects, {"SIDECAR_SNAPSHOT_SECS": "1"})
        try:
            async with Client(proc.port) as c:
                await c.ok("open_binary", path=BIN)
                a = await fn5(c)
                await c.ok("rename_symbol", address=a, newName="snapshot_name")
                assert (await c.ok("undo_state"))["dirty"] is True
                end = time.monotonic() + 45
                snapshots = []
                while time.monotonic() < end:
                    snapshots = glob.glob(os.path.join(projects, "**", "snapshot*.grf"), recursive=True)
                    if snapshots:
                        break
                    await asyncio.sleep(0.2)
                assert snapshots, "no Ghidra recovery snapshot within 45s"
                state = await c.ok("undo_state")  # queued on R: snapshot finished before SIGKILL
                assert state["dirty"] is True and state["canUndo"] is True
            return a
        finally:
            proc.p.kill()
            proc.p.wait()
    a = run(go())
    persisted, name = asyncio.run(reopen_name(projects, a))
    assert persisted is True and name == "snapshot_name"  # recovered from snapshot, never saved


def test_save_while_decompiling(projects):
    async def go():
        proc = Proc(projects, {"SIDECAR_DECOMP_WORKERS": "2"})
        try:
            async with Client(proc.port) as c:
                await c.ok("open_binary", path=BIN)
                fns = await c.ok("list_functions")
                big = sorted(fns, key=lambda f: -f["size"])[:4]
                ids = [await c.send("decompile", entry=f["entry"]) for f in big]
                await asyncio.sleep(0.05)
                a = await fn5(c)
                await c.ok("set_comment", address=a, kind="eol", text="saved during decompile")
                assert await c.ok("save") == {"saved": True}
                for i in ids:
                    r = await c.reply(i)
                    assert "result" in r or r["error"]["code"] != -32603, r
                assert (await c.ok("undo_state"))["dirty"] is False
        finally:
            proc.stop()
    run(go())


async def code_target(c, fns):
    """A function entry whose first instruction is followed by enough code to clear 8 bytes."""
    return fns[5]["entry"]


def test_define_data_clear_code_undo_dirty(projects):
    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                await c.ok("open_binary", path=BIN)
                f = await fn5(c)
                fi = int(f, 16)
                row = lambda: c.ok("listing_rows", address=f, count=1)
                insn = (await row())[0]
                assert insn["mnemonic"] not in ("??", "ddw")

                # define over an instruction: Ghidra refuses (force clears conflicting data, not instructions)
                await c.err("define_data", INVALID, address=f, dataType="dword")
                assert (await c.ok("undo_state"))["canUndo"] is False  # rolled back, nothing on the undo stack
                assert (await c.ok("undo_state"))["dirty"] is False

                # clear_code
                n = len(c.notes)
                far = (await c.ok("listing_rows", address=f, count=40))[-1]  # well past the 8 bytes cleared below
                assert int(far["address"], 16) >= fi + 16
                await c.ok("clear_code", address=f, length=8)
                assert far in await c.ok("listing_rows", address=far["address"], count=1)  # length is honoured, not "to the end"
                ev = await change(c, n, "Clear code")
                assert {"code"} <= set(ev["kinds"]) and "data" in ev["kinds"] and ev["undo"]["dirty"] is True
                assert (await row())[0]["mnemonic"] == "??"
                # clearing again is a no-op in Ghidra; we report it instead of creating an empty undo step
                await c.err("clear_code", INVALID, address=f, length=1)
                await c.err("clear_code", INVALID, address="0x1")
                await c.err("clear_code", INVALID, address=f, length=0)

                # define_data: names, paths, arrays, pointers
                for t, mn in (("dword", "ddw"), ("/dword", "ddw"), ("char[4]", "char[4]"), ("int", "int")):
                    n = len(c.notes)
                    await c.ok("define_data", address=f, dataType=t)
                    ev = await change(c, n, "Define data")
                    assert "data" in ev["kinds"]
                    assert ev["ranges"] is None or any(int(r["start"], 16) <= fi <= int(r["end"], 16) for r in ev["ranges"])  # null: a new type was resolved, broad
                    assert (await row())[0]["mnemonic"] == mn, (t, await row())
                assert (await c.ok("define_data", address=f, dataType="char *")) == {}
                assert (await row())[0]["length"] == 8
                for bad in ("no_such_type_zz", "", "void", "string", "int[", "/nope/missing"):
                    await c.err("define_data", INVALID, address=f, dataType=bad)
                await c.err("define_data", INVALID, address=f, dataType=5)
                await c.err("define_data", INVALID, address="0x1", dataType="int")
                await c.err("define_data", INVALID, address="zz", dataType="int")
                assert (await c.ok("undo_state"))["undoName"] == "Define data"  # failures added nothing

                # undo/redo of both; dirty tracks Ghidra's save point
                st = await c.ok("undo_state")
                assert st["dirty"] is True
                ups = 0
                while (await c.ok("undo_state"))["canUndo"]:
                    st = await c.ok("undo")
                    ups += 1
                assert ups >= 4 and st["dirty"] is False  # not exactly 6: redefining the same type is a no-op in Ghidra  # observed: undoing back to the saved state is clean again
                assert (await row())[0]["mnemonic"] == insn["mnemonic"]
                st = await c.ok("redo")
                assert st["dirty"] is True and st["undoName"] == "Clear code"  # redo dirties again
                assert (await row())[0]["mnemonic"] == "??"
                st = await c.ok("redo")
                assert (await row())[0]["mnemonic"] == "ddw" and st["undoName"] == "Define data"
                # save: clean, history dropped (Ghidra), data stays
                assert await c.ok("save") == {"saved": True}
                assert (await c.ok("undo_state"))["dirty"] is False
                assert (await row())[0]["mnemonic"] == "ddw"
                await c.ok("clear_code", address=f)  # default length: the code unit containing the address
                assert (await row())[0]["mnemonic"] == "??"
                assert (await c.ok("undo_state"))["dirty"] is True
                await c.ok("undo")
                assert (await c.ok("undo_state"))["dirty"] is False
                await c.ok("define_data", address=f, dataType="dword")  # same type again: Ghidra changes nothing
                st = await c.ok("undo_state")
                assert st["dirty"] is False and st["canUndo"] is False  # observed: no-op, not dirty, no undo step
                await c.ok("define_data", address=f, dataType="char[4]")  # different type over defined data: force replaces it
                assert (await c.ok("undo_state"))["undoName"] == "Define data"
                await c.ok("save")
        finally:
            proc.stop()
        # persisted
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                assert (await c.ok("open_binary", path=BIN))["persisted"] is True
                assert (await c.ok("listing_rows", address=f, count=1))[0]["mnemonic"] == "char[4]"
        finally:
            proc.stop()
    run(go())


def test_corrupt_persisted_item_is_preserved(projects, tmp_path):
    gbfs = list(Path(projects).rglob("*.gbf"))
    assert gbfs, "no .gbf files under the scratch project"
    for g in gbfs:  # a SIGKILL during the first (non-atomic) save leaves something like this
        with open(g, "r+b") as fh:
            fh.truncate(max(16, os.path.getsize(g) // 10))
    saved = {g: g.read_bytes() for g in gbfs}
    other = blob(tmp_path, "working.bin")

    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                entries = await c.ok("list_programs")
                assert len(entries) == 1
                rid = entries[0]["programId"]
                await c.ok("open_binary", path=other, loader="Raw Binary", language=X86, baseAddress=BASE)
                await c.ok("set_comment", address=BASE, kind="eol", text="keep this edit")
                before = await c.ok("undo_state")
                entries = await c.ok("list_programs")
                r = await c.call("open_binary", path=BIN)
                assert r["error"]["code"] == INTERNAL
                assert rid in r["error"]["message"] and "preserved" in r["error"]["message"]
                assert await c.ok("undo_state") == before
                assert (await c.ok("listing_info"))["ranges"][0]["start"] == BASE
                assert await c.ok("list_programs") == entries
                assert {g: g.read_bytes() for g in gbfs} == saved
                await c.ok("delete_program", programId=rid)
                assert (await c.ok("open_binary", path=BIN))["persisted"] is False
        finally:
            proc.stop()
    run(go())


@pytest.mark.parametrize("damage", ["moved", "overwritten"])
def test_open_program_by_id_ignores_the_source_file(tmp_path, damage):
    """A saved edit survives the binary being moved or replaced: the stored program opens by its ID, nothing is re-imported."""
    raw = blob(tmp_path)
    opts = dict(path=raw, loader="Raw Binary", language=X86, baseAddress=BASE)

    async def edit():
        async with Client(proc.port) as c:
            r = await c.ok("open_binary", **opts)
            a = (await c.ok("list_functions"))[0]["entry"]
            await c.ok("rename_symbol", address=a, newName="edited_by_user")
            assert await c.ok("save") == {"saved": True}
            return r["programId"], a
    proc = Proc(tmp_path / "projects")
    try:
        pid, a = run(edit())
    finally:
        proc.stop()
    if damage == "moved":
        os.rename(raw, raw + ".moved")
    else:
        Path(raw).write_bytes(b"\x90" * 64)

    async def reopen():
        async with Client(proc.port) as c:
            await c.err("open_program", NOT_FOUND, programId="no-such-program")
            r = await c.ok("open_program", programId=pid)
            assert r["programId"] == pid and r["persisted"] is True
            assert await name_at(c, a) == "edited_by_user"
            assert (await c.ok("undo_state"))["dirty"] is False
            assert [e["programId"] for e in await c.ok("list_programs")] == [pid]  # nothing was imported
    proc = Proc(tmp_path / "projects")
    try:
        run(reopen())
    finally:
        proc.stop()


def test_save_without_program(tmp_path):
    proc = Proc(tmp_path / "p")
    try:
        async def go():
            async with Client(proc.port) as c:
                await c.err("save", NO_PROGRAM)
                await c.err("define_data", NO_PROGRAM, address="0x1", dataType="int")
                await c.err("clear_code", NO_PROGRAM, address="0x1")
        run(go())
    finally:
        proc.stop()


def test_bookmarks_add_list_undo_redo_save_reopen(projects):
    """A Note bookmark: listed (and on its listing row), one undo step each way, announced with its address, survives save + reopen; remove is an edit too."""
    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                await c.ok("open_binary", path=BIN)
                a = await fn5(c)
                before = await c.ok("list_bookmarks")  # analyzers' bookmarks, every type
                notes0 = await c.ok("list_bookmarks", type="Note")
                assert notes0["total"] == 0 and all(i["type"] != "Note" for i in before["items"])
                since = len(c.notes)
                await c.ok("set_bookmark", address=a, category="triage", comment="look at this")
                ch = await change(c, since, "Set bookmark")
                assert "bookmark" in ch["kinds"] and ch["ranges"] and ch["ranges"][0]["start"] == a, ch
                notes = await c.ok("list_bookmarks", type="Note")
                assert notes["items"] == [{"address": a, "type": "Note", "category": "triage", "comment": "look at this"}] and notes["total"] == 1
                assert {"type": "Note", "count": 1} in notes["types"] and (await c.ok("list_bookmarks"))["total"] == before["total"] + 1
                assert (await c.ok("list_bookmarks", query="LOOK AT"))["total"] == 1 and (await c.ok("list_bookmarks", type="Note", query="nope"))["total"] == 0
                assert (await c.ok("listing_rows", address=a, count=1))[0]["bookmarks"] == [{"category": "triage", "comment": "look at this"}]
                await c.ok("set_bookmark", address=a, category="triage", comment="replaced")  # same address + category: replaces
                assert (await c.ok("list_bookmarks", type="Note"))["items"][0]["comment"] == "replaced"
                await c.ok("set_bookmark", address=a, category="other", comment="second")
                items = (await c.ok("list_bookmarks", type="Note", sort="category", desc=True))["items"]
                assert [i["category"] for i in items] == ["triage", "other"]
                await c.err("set_bookmark", INVALID, address="0x1", category="c", comment="x")
                await c.err("set_bookmark", INVALID, address=a, category=1, comment="x")
                await c.err("list_bookmarks", INVALID, sort="nonsense")
                # undo / redo: each set is one step
                await c.ok("undo"); await c.ok("undo")  # the second category, then the replaced comment is the first set again
                await c.ok("undo")
                assert (await c.ok("list_bookmarks", type="Note"))["total"] == 0
                assert "bookmarks" not in (await c.ok("listing_rows", address=a, count=1))[0]
                await c.ok("redo")
                assert (await c.ok("list_bookmarks", type="Note"))["items"][0]["comment"] == "look at this"
                await c.ok("redo"); await c.ok("redo")
                assert (await c.ok("list_bookmarks", type="Note"))["total"] == 2
                assert (await c.ok("save"))["saved"] is True
                await c.ok("close_program")
                await c.ok("open_binary", path=BIN)
                items = (await c.ok("list_bookmarks", type="Note"))["items"]
                assert sorted((i["category"], i["comment"]) for i in items) == [("other", "second"), ("triage", "replaced")]
                await c.ok("remove_bookmark", address=a, type="Note")  # every category at that address
                assert (await c.ok("list_bookmarks", type="Note"))["total"] == 0
                await c.err("remove_bookmark", NOT_FOUND, address=a, type="Note")
                await c.ok("undo")
                assert (await c.ok("list_bookmarks", type="Note"))["total"] == 2
        finally:
            proc.stop()
    run(go())

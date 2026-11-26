"""The Ghidra project: import candidates, languages, the program browser, the project lock."""
import asyncio, os, time

from testlib import BIN, BUSY, CANCELLED, Client, INVALID, NOT_FOUND, NO_PROGRAM, PROJECT_LOCKED, Proc, X86, blob, run


def test_candidates_and_languages(bproc):
    proc, d = bproc
    raw = blob(d)

    async def go():
        async with Client(proc.port) as c:
            r0 = await c.ok("import_candidates", path=raw)
            assert r0["candidates"] == [] and r0["sizeBytes"] == os.path.getsize(raw) and r0["entropy"] and all(0 <= e <= 8 for e in r0["entropy"])  # nothing recognises a bare blob
            await c.err("import_candidates", NOT_FOUND, path=str(d / "nope"))
            await c.err("import_candidates", INVALID)
            res = await c.ok("import_candidates", path=BIN)
            assert res["sizeBytes"] == os.path.getsize(BIN)
            r = res["candidates"]
            assert r and sum(x["preferred"] for x in r) == 1
            assert all(set(x) == {"loader", "language", "compilerSpec", "preferred", "acceptsBaseAddress"} for x in r)
            pref = next(x for x in r if x["preferred"])
            assert pref["language"] and pref["compilerSpec"] and pref["acceptsBaseAddress"] is False
            rb = [x for x in r if x["loader"] == "Raw Binary"]
            assert rb and rb[0]["language"] is None and rb[0]["acceptsBaseAddress"] is True
            langs = await c.ok("list_languages")
            ent = next(l for l in langs if l["id"] == X86)
            assert ent["description"] and ent["compilerSpecs"] and {"id", "name"} == set(ent["compilerSpecs"][0])
            assert [l["id"] for l in langs] == sorted(l["id"] for l in langs)
    run(go())


def test_list_programs_survives_restart_and_busy_during_open(tmp_path):
    raw = blob(tmp_path)
    opts = dict(path=raw, loader="Raw Binary", language=X86)
    proc = Proc(tmp_path / "projects")
    try:
        async def first():
            async with Client(proc.port) as c:
                await c.ok("open_binary", **opts)
        run(first())
    finally:
        proc.stop()
    proc = Proc(tmp_path / "projects")
    try:
        async def second():
            async with Client(proc.port) as c:
                (p,) = await c.ok("list_programs")
                assert p["sourcePath"] == raw and p["options"]["language"] == X86 and p["lastOpened"]
                t0 = p["lastOpened"]
                await asyncio.sleep(1.1)
                assert (await c.ok("open_binary", **opts))["persisted"] is True
                assert (await c.ok("list_programs"))[0]["lastOpened"] > t0
                assert (await c.ok("undo_state"))["dirty"] is False  # writing lastOpened does not dirty the program
        run(second())
    finally:
        proc.stop()


def test_busy_during_open_for_project_methods(tmp_path):
    proc = Proc(tmp_path / "projects")
    try:
        async def go():
            async with Client(proc.port) as c:
                oid = await c.send("open_binary", path=BIN)
                end = time.monotonic() + 60
                while time.monotonic() < end and not any(p["phase"] == "analysis" for p in c.take("progress")):
                    await asyncio.sleep(0.02)
                for m, kw in (("list_programs", {}), ("delete_program", {"programId": "0" * 64}), ("close_program", {}), ("import_candidates", {"path": BIN})):
                    await c.err(m, BUSY, **kw)
                assert isinstance(await c.ok("list_languages"), list)
                await c.err("save", NO_PROGRAM)
                await c.ok("cancel_open")
                assert (await c.reply(oid))["error"]["code"] == CANCELLED
                assert await c.ok("list_programs") == []
        run(go())
    finally:
        proc.stop()


def test_project_lock_clear_error(tmp_path):
    p1, d = Proc(tmp_path / "projects"), tmp_path / "projects"
    p2 = Proc(d)

    async def go():
        async with Client(p1.port) as c1:
            await c1.ok("list_programs")  # p1 owns the project now
            async with Client(p2.port) as c2:
                for m, kw in (("list_programs", {}), ("open_binary", {"path": BIN})):
                    r = await c2.call(m, **kw)
                    assert r["error"]["code"] == PROJECT_LOCKED and "in use by another Ghidrette" in r["error"]["message"], r
                assert await c2.ok("list_languages")  # the sidecar stays usable
                assert (await c2.call("list_functions"))["error"]["code"] == NO_PROGRAM
            return True
    try:
        run(go())
        p1.stop()  # releases the project; the second sidecar's next call works (no sticky failure)

        async def after():
            async with Client(p2.port) as c2:
                assert await c2.ok("list_programs") == []
        run(after())
    finally:
        p1.stop(); p2.stop()


def test_corrupt_catalog_is_moved_aside_and_rebuilt(tmp_path):
    d = tmp_path / "projects"
    a, b = blob(tmp_path, "a.bin"), blob(tmp_path, "b.bin", pad=16)

    def session(fn):
        proc = Proc(d)
        try:
            async def go():
                async with Client(proc.port) as c:
                    return await fn(c)
            return run(go())
        finally:
            proc.stop()

    async def open_both(c):
        ids = [(await c.ok("open_binary", path=p, loader="Raw Binary", language=X86))["programId"] for p in (a, b)]
        return ids, await c.ok("list_programs")
    (ia, ib), before = session(open_both)
    assert {p["analysis"] for p in before} == {"done"}
    good = (d / "programs.json").read_bytes()

    async def listing(c):
        return await c.ok("list_programs")
    assert session(listing) == before  # a valid catalog is read as is, and not rewritten
    assert (d / "programs.json").read_bytes() == good

    (d / "programs.json").write_bytes(b'{"truncated')

    async def reopen_a(c):
        await c.ok("open_binary", path=a, loader="Raw Binary", language=X86)  # meta_touch: a read-modify-write of the catalog
        return {p["programId"]: p for p in await c.ok("list_programs")}
    after = session(reopen_a)
    assert set(after) == {ia, ib}  # b was not dropped
    assert after[ib]["analysis"] != "done" and after[ib]["analyzed"] is False  # unknown, never "done"
    assert after[ib]["sourcePath"] == a.replace("a.bin", "b.bin") and after[ib]["name"] == "b.bin"  # from the program's own metadata
    assert after[ia]["analysis"] == "done"  # the open finished the (unknown) analysis
    (bad,) = d.glob("programs.json.corrupt-*")
    assert bad.read_bytes() == b'{"truncated'

    (d / "programs.json").unlink()
    gone = {p["programId"]: p for p in session(listing)}  # a missing file is an empty catalog, as before: no rebuild, read as analyzed
    assert set(gone) == {ia, ib} and all(p["analysis"] == "done" and p["name"] == p["programId"] for p in gone.values())
    assert len(list(d.glob("programs.json.corrupt-*"))) == 1

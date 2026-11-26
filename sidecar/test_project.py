"""The Ghidra project: import candidates, languages, the program browser, the project lock."""
import asyncio, os, time

from testlib import BIN, BUSY, CANCELLED, Client, INVALID, NOT_FOUND, NO_PROGRAM, PROJECT_LOCKED, Proc, X86, blob, run


def test_candidates_and_languages(bproc):
    proc, d = bproc
    raw = blob(d)

    async def go():
        async with Client(proc.port) as c:
            assert (await c.ok("import_candidates", path=raw)) == {"candidates": [], "sizeBytes": os.path.getsize(raw)}  # nothing recognises a bare blob
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

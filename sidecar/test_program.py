"""open_binary (progress, profiles, import options, cancel/Busy), close, save/dirty state, reopen.
Order matters: the raw-blob tests share one sidecar (bproc), test_list_and_delete_programs counts the imports the test before it made."""
import asyncio, hashlib, os, re, time

from testlib import BASE, BIN, BUSY, CANCELLED, Client, HERE, INVALID, NOT_FOUND, NO_PROGRAM, Proc, X86, blob, run


def test_open_progress(env):
    assert env["open"]["persisted"] is False
    notes = [(t, m["params"]) for t, m in env["notes"] if m["method"] == "progress"]
    phases = [p["phase"] for _, p in notes]
    firsts = [phases.index(x) for x in ("import", "analysis", "saving", "ready")]
    assert firsts == sorted(firsts), phases
    assert phases[-1] == "ready"
    an = [p for _, p in notes if p["phase"] == "analysis" and p.get("analyzer")]
    assert an, "no analysis progress carried an analyzer name"
    assert len({p["analyzer"] for p in an}) > 3
    assert max(p["done"] for p in an) > 3 and all(p["pct"] == -1 or 0 <= p["pct"] <= 100 for _, p in notes)
    times = [t for t, _ in notes if True]
    per_sec = {}
    for t in times:
        per_sec[int(t)] = per_sec.get(int(t), 0) + 1
    assert max(per_sec.values()) <= 12, per_sec  # ~5/s plus phase boundaries
    print("analysis notes %d, distinct analyzers %d, open %.1fs" % (len(an), len({p['analyzer'] for p in an}), env["open_s"]))


def test_reopen_is_fast_and_quiet(env):
    async def go():
        async with Client(env["proc"].port) as c:
            t = time.monotonic()
            r = await c.ok("open_binary", path=BIN)
            took = time.monotonic() - t
            assert r["persisted"] is True and r["programId"] == env["open"]["programId"]
            phases = {p["phase"] for p in c.take("progress")}
            assert phases == {"import", "ready"}, phases
            assert took < 5
            assert (await c.ok("undo_state"))["canUndo"] is False
            assert len(await c.ok("list_functions")) == len(env["fns"])
    run(go())


def test_open_cancel_busy_failfast(tmp_path):
    proc = Proc(tmp_path / "projects")
    try:
        async def go():
            async with Client(proc.port) as c:
                oid = await c.send("open_binary", path=BIN)
                await c.wait_note("progress", timeout=30)
                # wait until analysis is actually running
                end = time.monotonic() + 60
                while time.monotonic() < end and not any(p["phase"] == "analysis" for p in c.take("progress")):
                    await asyncio.sleep(0.02)
                assert any(p["phase"] == "analysis" for p in c.take("progress"))
                # requests during the open fail fast
                for method, params in (("list_functions", {}), ("listing_rows", {"address": "0x0", "count": 1}),
                                       ("decompile", {"entry": "0x0"}), ("rename_symbol", {"address": "0x0", "newName": "x"}),
                                       ("undo", {})):
                    t = time.monotonic()
                    await c.err(method, NO_PROGRAM, **params)
                    ms = (time.monotonic() - t) * 1000
                    assert ms < 100, (method, ms)
                t = time.monotonic()
                await c.err("open_binary", BUSY, path=BIN)
                assert (time.monotonic() - t) < 0.1
                t = time.monotonic()
                assert (await c.ok("cancel_open")) == {"cancelled": True}
                r = await c.reply(oid)
                print("cancel_open -> open_binary error after %.2fs" % (time.monotonic() - t))
                assert r["error"]["code"] == CANCELLED, r
                await c.err("list_functions", NO_PROGRAM)
                assert (await c.ok("cancel_open")) == {"cancelled": False}
                # the project must hold nothing, so this is a full import + analysis, and it works without a restart
                n = len(c.notes)
                r = await c.ok("open_binary", path=BIN)
                assert r["persisted"] is False
                new = [m["params"] for _, m in c.notes[n:] if m["method"] == "progress"]
                assert {"import", "analysis", "saving", "ready"} <= {p["phase"] for p in new}
                assert len({p["analyzer"] for p in new if p.get("analyzer")}) > 3
                fns = await c.ok("list_functions")
                assert fns
                await c.ok("rename_symbol", address=fns[0]["entry"], newName="open_failure_probe")
                undo_before = await c.ok("undo_state")
                assert undo_before["dirty"] and undo_before["canUndo"]
                other = os.path.join(HERE, "..", "bench", "nonexistent")
                await c.err("open_binary", NOT_FOUND, path=other)
                await c.err("open_binary", INVALID, path=BIN, profile="unknown")
                await c.err("open_binary", INVALID, path=blob(tmp_path))
                assert await c.ok("undo_state") == undo_before
                assert any(f["name"] == "open_failure_probe" for f in await c.ok("list_functions"))
                await c.ok("undo")
                assert (await c.ok("open_binary", path=BIN))["persisted"] is True
                assert len(await c.ok("list_functions")) == len(fns)
                # now it is persisted, cancel is a no-op and reopen is quick
                assert (await c.ok("open_binary", path=BIN))["persisted"] is True
        run(go())
    finally:
        proc.stop()


def test_import_options_validation(bproc):
    proc, d = bproc
    raw = blob(d)

    async def go():
        async with Client(proc.port) as c:
            for bad in ({"loader": "No Such Loader"}, {"language": "x86:LE:99:nope"},
                        {"loader": "Raw Binary", "language": X86, "compilerSpec": "nope"},
                        {"loader": "Raw Binary", "language": X86, "baseAddress": "zz"},
                        {"loader": "Raw Binary", "language": X86, "baseAddress": "0x1ffffffff"},  # > 32-bit space
                        {"loader": "Raw Binary", "language": X86, "baseAddress": 5}):
                await c.err("open_binary", INVALID, path=raw, **bad)
            await c.err("open_binary", INVALID, path=raw)  # default import: no loader recognises the blob
            assert await c.ok("list_programs") == []
    run(go())


def test_raw_import_options_save_reopen_dirty_undo(bproc):
    proc, d = bproc
    raw = blob(d)
    sha = hashlib.sha256(open(raw, "rb").read()).hexdigest()
    opts = dict(path=raw, loader="Raw Binary", language=X86, baseAddress=BASE)

    async def go():
        async with Client(proc.port) as c:
            r = await c.ok("open_binary", **opts)
            assert r["persisted"] is False and r["name"] == "blob.bin"
            pid = r["programId"]
            assert re.fullmatch(sha + "-[0-9a-f]{12}", pid)
            info = await c.ok("listing_info")
            assert info["ranges"][0]["start"] == BASE and info["totalBytes"] == 26
            first = (await c.ok("listing_rows", address=BASE, count=1))[0]
            assert first["bytes"].startswith("55")  # raw bytes, nothing disassembled without an entry point
            # not dirty after a fresh import, nor after reads/decompiles in the background
            assert (await c.ok("undo_state"))["dirty"] is False
            await c.ok("list_functions"), await c.ok("list_strings"), await c.ok("search_symbols", query="f")
            await asyncio.sleep(0.5)
            assert (await c.ok("undo_state")) == {"canUndo": False, "canRedo": False, "dirty": False}
            # the key depends on the options
            other = (await c.ok("open_binary", **{**opts, "baseAddress": "0x1000"}))
            assert other["programId"] != pid and other["programId"].startswith(sha + "-")
            assert (await c.ok("listing_info"))["ranges"][0]["start"] == "0x1000"
            r = await c.ok("open_binary", **opts)
            assert r["persisted"] is True and r["programId"] == pid
            assert (await c.ok("undo_state"))["dirty"] is False  # persisted reopen is clean too

            # edit -> dirty; save -> clean, notification, edit survives reopen
            n = len(c.notes)
            await c.ok("set_comment", address=BASE, kind="eol", text="kept")
            u = await c.ok("undo_state")
            assert u["dirty"] is True and u["canUndo"] is True
            await c.ok("save")
            pc = (await c.wait_note("program_changed", since=n))
            save_note = [p for p in pc if p["ranges"] == []][-1]
            assert save_note["kinds"] == [] and save_note["undo"]["dirty"] is False
            after = await c.ok("undo_state")
            assert after["dirty"] is False
            print("undo state after save:", after)
            await c.ok("save")  # unchanged: still a success
            # MEASURED (protocol.md "Persistence and crash safety"): saving clears Ghidra's undo AND redo stacks
            assert after == {"canUndo": False, "canRedo": False, "dirty": False}
            await c.err("undo", INVALID)
            await c.ok("set_comment", address=BASE, kind="eol", text="second")
            u = await c.ok("undo")
            assert u["dirty"] is False and u["canRedo"] is True  # back at the saved state: Ghidra tracks that, dirty clears
            assert (await c.ok("redo"))["dirty"] is True
            await c.ok("save")
            assert (await c.ok("undo_state")) == {"canUndo": False, "canRedo": False, "dirty": False}

            # an unsaved edit is autosaved when another open replaces the program (protocol.md, Persistence)
            await c.ok("open_binary", **opts)
            await c.ok("set_comment", address="0x8000010", kind="eol", text="autosaved")
            assert (await c.ok("undo_state"))["dirty"] is True
            await c.ok("open_binary", **opts)
            assert (await c.ok("undo_state"))["dirty"] is False
            rows = {x["address"]: x for x in await c.ok("listing_rows", address=BASE, count=26)}
            assert rows[BASE].get("comment") == "second" and rows["0x8000010"].get("comment") == "autosaved"
    run(go())


def test_list_and_delete_programs(bproc):
    proc, d = bproc
    raw = blob(d)
    sha = hashlib.sha256(open(raw, "rb").read()).hexdigest()
    opts = dict(path=raw, loader="Raw Binary", language=X86, baseAddress=BASE)

    async def go():
        async with Client(proc.port) as c:
            progs = await c.ok("list_programs")  # earlier tests left two imports of blob.bin
            assert len(progs) == 2 and all(p["programId"].startswith(sha + "-") for p in progs)
            p = progs[0]
            assert p["name"] == "blob.bin" and p["sourcePath"] == raw and p["sizeBytes"] == 26 and p["analyzed"] is True
            assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", p["lastOpened"])
            assert progs[0]["lastOpened"] >= progs[1]["lastOpened"]
            assert any(x["options"] == {"loader": "Raw Binary", "language": X86, "baseAddress": BASE} for x in progs)
            assert any(x["options"] == {"loader": "Raw Binary", "language": X86, "baseAddress": "0x1000"} for x in progs)

            r = await c.ok("open_binary", **opts)
            pid = r["programId"]
            await c.err("delete_program", BUSY, programId=pid)  # open
            await c.err("delete_program", NOT_FOUND, programId="f" * 64)
            await c.err("delete_program", NOT_FOUND, programId="../../etc")
            await c.err("delete_program", INVALID)
            assert len(await c.ok("list_programs")) == 2  # works with a program open
            victim = next(x["programId"] for x in progs if x["programId"] != pid)
            assert (await c.ok("delete_program", programId=victim)) == {}
            assert [x["programId"] for x in await c.ok("list_programs")] == [pid]
            await c.err("delete_program", NOT_FOUND, programId=victim)
            assert (await c.ok("undo_state"))["dirty"] is False
            # a deleted program is imported afresh
            assert (await c.ok("open_binary", **{**opts, "baseAddress": "0x1000"}))["persisted"] is False
    run(go())


def test_dirty_clean_on_ls_and_close_program(env):
    """Reads and decompiles never dirty; close_program autosaves, cancels queued decompiles, later requests fail NoProgram."""
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            assert (await c.ok("undo_state"))["dirty"] is False
            await c.ok("decompile", entry=max(fns, key=lambda f: f["size"])["entry"])
            await asyncio.sleep(0.3)
            assert (await c.ok("undo_state"))["dirty"] is False
            progs = await c.ok("list_programs")
            assert len(progs) == 1 and progs[0]["options"] == {} and progs[0]["programId"] == env["open"]["programId"]
            assert progs[0]["name"] == os.path.basename(BIN) and progs[0]["sizeBytes"] == os.path.getsize(BIN)

            ranked = sorted(fns, key=lambda f: -f["size"])[3:15]
            await c.ok("rename_symbol", address=ranked[0]["entry"], newName="cache_clear_probe")  # empty the cache
            ids = [await c.send("decompile", entry=f["entry"]) for f in ranked]
            await asyncio.sleep(0.01)
            assert (await c.ok("close_program")) == {}
            codes = [(await c.reply(i)).get("error", {}).get("code") for i in ids]
            assert CANCELLED in codes and set(codes) <= {None, CANCELLED}, codes
            assert codes.count(CANCELLED) >= len(ids) - 3, codes  # at most the in-flight ones (2 workers) can win the race
            for m, kw in (("list_functions", {}), ("decompile", {"entry": ranked[0]["entry"]}), ("save", {}), ("undo_state", {})):
                await c.err(m, NO_PROGRAM, **kw)
            assert (await c.ok("close_program")) == {}  # idempotent
            await c.err("delete_program", NOT_FOUND, programId="a" * 64)
            # close autosaved the rename; the reopened program is clean
            assert (await c.ok("open_binary", path=BIN))["persisted"] is True
            assert (await c.ok("undo_state"))["dirty"] is False
            assert any(f["name"] == "cache_clear_probe" for f in await c.ok("list_functions"))
            await c.ok("rename_symbol", address=ranked[0]["entry"], newName=ranked[0]["name"])  # leave the shared /bin/ls program as it was
            await c.ok("save")
    run(go())


def test_open_profile_fast_and_full(tmp_path):
    err = open(tmp_path / "stderr.log", "wb")
    proc = Proc(tmp_path / "projects", stderr=err)
    sha = hashlib.sha256(open(BIN, "rb").read()).hexdigest()

    async def go():
        async with Client(proc.port) as c:
            await c.err("open_binary", INVALID, path=BIN, profile="turbo")
            r = await c.ok("open_binary", path=BIN, profile="fast")
            assert r["programId"].startswith(sha + "-") and r["persisted"] is False
            fast_fns = len(await c.ok("list_functions"))
            progs = await c.ok("list_programs")
            assert [p["options"] for p in progs] == [{"profile": "fast"}]
            await c.ok("close_program")
            r2 = await c.ok("open_binary", path=BIN, profile="fast")  # same key: persisted, no re-analysis
            assert r2["programId"] == r["programId"] and r2["persisted"] is True
            full = await c.ok("open_binary", path=BIN, profile="full")  # explicit full == plain default key
            assert full["programId"] == sha and full["persisted"] is False
            assert len(await c.ok("list_functions")) > 0 and fast_fns > 0
            assert {p["programId"]: p["options"] for p in await c.ok("list_programs")} == {sha: {}, r["programId"]: {"profile": "fast"}}
    try:
        run(go())
    finally:
        proc.stop()
        err.close()
    log = open(tmp_path / "stderr.log", errors="replace").read()
    assert "analyzers disabled: ['Call Convention ID', 'Decompiler Switch Analysis', 'Stack']" in log, log[-2000:]
    assert log.count("analyzers disabled") == 1  # the full open and the persisted reopen disable nothing


def test_open_profile_on_raw_blob(bproc):
    proc, d = bproc
    raw = blob(d, "profile.bin", pad=7)  # other bytes than the shared blob: its own program, no comments left by earlier tests
    opts = dict(path=raw, loader="Raw Binary", language=X86, baseAddress=BASE)

    async def go():
        async with Client(proc.port) as c:
            full = await c.ok("open_binary", **opts)
            fast = await c.ok("open_binary", profile="fast", **opts)
            assert fast["programId"] != full["programId"] and fast["persisted"] is False
            await c.ok("close_program")
            ents = {p["programId"]: p["options"] for p in await c.ok("list_programs")}
            assert ents[fast["programId"]] == {"loader": "Raw Binary", "language": X86, "baseAddress": BASE, "profile": "fast"}
            assert "profile" not in ents[full["programId"]]
            # raw-blob path of the Round 5 reads/edits
            await c.ok("open_binary", **opts)
            assert await c.ok("get_comments", address=BASE) == {}
            await c.ok("set_comment", address=BASE, kind="plate", text="blob plate")
            assert await c.ok("get_comments", address=BASE) == {"plate": "blob plate"}
            mid = hex(int(BASE, 16) + 3)  # inside the second instruction? unlabeled either way
            row = (await c.ok("listing_rows", address=mid, count=1))[0]
            assert "label" not in row
            await c.ok("create_label", address=row["address"], name="blob_lbl")
            assert (await c.ok("listing_rows", address=row["address"], count=1))[0]["label"] == "blob_lbl"
            await c.ok("undo"); await c.ok("undo")
    run(go())

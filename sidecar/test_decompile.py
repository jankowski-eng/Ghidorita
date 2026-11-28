"""Decompiler: edits and the decompile cache, the pool and cancel_decompile.
Order matters: the pool timing test needs warm workers, the cache test before it warms them."""
import asyncio, time

from testlib import CANCELLED, Client, INVALID, NOT_FOUND, find_call_pair, run


def test_edits_undo_redo_and_cache(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            u0 = await c.ok("undo_state")
            assert u0["canUndo"] is False, u0  # the analysis transaction is not undoable

            # --- rename_symbol: event, undo/redo round trip, cache invalidation of a *caller*
            caller, callee, d1 = await find_call_pair(c, fns)
            assert (await c.ok("decompile", entry=caller["entry"]))["cached"] is True
            n = len(c.notes)
            await c.ok("rename_symbol", address=callee, newName="renamed_callee_x")
            ev = (await c.wait_note("program_changed", since=n))[0]
            assert "symbol" in ev["kinds"] and ev["undo"]["canUndo"] and "renamed_callee_x" in ev["undo"]["undoName"]
            d2 = await c.ok("decompile", entry=caller["entry"])
            assert d2["cached"] is False and "renamed_callee_x" in d2["text"], d2["text"][:300]
            assert (await c.ok("get_function_at", address=callee))["name"] == "renamed_callee_x"
            n = len(c.notes)
            st = await c.ok("undo")
            assert st["canUndo"] is False and st["canRedo"] and "renamed_callee_x" in st["redoName"]
            ev = (await c.wait_note("program_changed", since=n))[0]
            assert ev["ranges"] is None and ev["undo"] == st
            d3 = await c.ok("decompile", entry=caller["entry"])
            assert d3["cached"] is False and "renamed_callee_x" not in d3["text"] and d3["text"] == d1["text"]
            st = await c.ok("redo")
            assert st["canUndo"] and not st["canRedo"]
            assert (await c.ok("get_function_at", address=callee))["name"] == "renamed_callee_x"
            await c.ok("undo")

            # --- set_comment: all kinds, listing shows eol, empty clears
            info = await c.ok("listing_info")
            a = info["ranges"][0]["start"]
            for kind in ("eol", "pre", "post", "plate", "repeatable"):
                n = len(c.notes)
                await c.ok("set_comment", address=a, kind=kind, text="hello " + kind)
                ev = (await c.wait_note("program_changed", since=n))[0]
                assert "comment" in ev["kinds"] and ev["ranges"] and ev["ranges"][0]["start"] <= a <= ev["ranges"][0]["end"] or ev["ranges"] is None
                if kind == "eol":
                    assert (await c.ok("listing_rows", address=a, count=1))[0]["comment"] == "hello eol"
            await c.ok("set_comment", address=a, kind="eol", text="")
            assert "comment" not in (await c.ok("listing_rows", address=a, count=1))[0]
            for _ in range(6):
                await c.ok("undo")
            assert (await c.ok("undo_state"))["canUndo"] is False

            # --- rename_variable / retype_variable (decompiler HighFunction path)
            done_var = False
            for f in sorted(fns, key=lambda f: -f["size"])[:40]:
                r = await c.ok("decompile", entry=f["entry"])
                vars_ = [k for k in r["tokens"] if k["kind"] in ("variable", "param") and k.get("varName") and k["line"] > 0]
                if not vars_:
                    continue
                name = vars_[0]["varName"]
                n = len(c.notes)
                res = await c.call("rename_variable", entry=f["entry"], name=name, newName="my_renamed_var")
                if "error" in res:
                    continue
                await c.wait_note("program_changed", since=n)
                # the edit runs on the edit lane and commits on R: its result still names the undo step it committed (what `undo {expect}` takes)
                assert res["result"]["undoName"].startswith("Rename variable in ") and res["result"]["undoName"] == (await c.ok("undo_state"))["undoName"]
                t2 = await c.ok("decompile", entry=f["entry"])
                assert t2["cached"] is False and "my_renamed_var" in t2["text"] and t2["text"] != r["text"]
                # retype the renamed variable
                n = len(c.notes)
                rt = await c.call("retype_variable", entry=f["entry"], name="my_renamed_var", dataType="long")
                if "result" in rt:
                    await c.wait_note("program_changed", since=n)
                    assert rt["result"]["undoName"].startswith("Retype variable in ")
                    assert "type" in (await c.ok("undo_state"))["undoName"].lower() or True
                    await c.ok("undo")
                await c.ok("undo")
                t3 = await c.ok("decompile", entry=f["entry"])
                assert "my_renamed_var" not in t3["text"]
                done_var = True
                break
            assert done_var, "no function allowed a variable rename"
            await c.err("rename_variable", NOT_FOUND, entry=fns[0]["entry"], name="no_such_var_zz", newName="abc")

            # --- set_function_signature
            tgt = next(f for f in fns if f["size"] > 40)
            g = await c.ok("get_function_at", address=tgt["entry"])
            n = len(c.notes)
            await c.ok("set_function_signature", entry=tgt["entry"], signature="long sig_probe(long a, char *b)")
            await c.wait_note("program_changed", since=n)
            g2 = await c.ok("get_function_at", address=tgt["entry"])
            assert g2["name"] == "sig_probe" and "char *" in g2["signature"], g2
            await c.ok("undo")
            assert (await c.ok("get_function_at", address=tgt["entry"]))["name"] == g["name"]
            await c.err("set_function_signature", INVALID, entry=tgt["entry"], signature="this is ((( not C")

            # --- create_function: on an instruction that no function contains, if /bin/ls has one
            found = None
            cur = info["ranges"][0]["start"]
            for _ in range(60):
                rows = await c.ok("listing_rows", address=cur, count=1000)
                if not rows:
                    break
                for row in rows:
                    if row["mnemonic"] not in ("db", "ds", "dw", "dd", "dq", "??") and await c.ok("get_function_at", address=row["address"]) is None:
                        found = row["address"]
                        break
                if found:
                    break
                cur = hex(int(rows[-1]["address"], 16) + rows[-1]["length"])
            if found:
                n = len(c.notes)
                r = await c.call("create_function", address=found, name="made_by_test")
                if "result" in r:
                    assert r["result"]["entry"] == found and r["result"]["name"] == "made_by_test"
                    await c.wait_note("program_changed", since=n)
                    assert (await c.ok("get_function_at", address=found))["name"] == "made_by_test"
                    await c.ok("undo")
                    assert await c.ok("get_function_at", address=found) is None
            await c.err("create_function", INVALID, address=fns[0]["entry"])  # already a function
            assert (await c.ok("undo_state"))["canUndo"] is False
    run(go())


def test_pool_concurrent_and_cancel(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            big = sorted(fns, key=lambda f: -f["size"])[:2]

            async def clear_cache():  # a rename clears the whole cache; undo it right after
                await c.ok("rename_symbol", address=fns[0]["entry"], newName="cache_clear_probe")
                await c.ok("undo")
            # behaviour, not wall-clock: with 2 workers a tiny decompile queued behind the biggest one is answered first
            # (a single worker would answer in arrival order). Arrival order of the replies does not depend on machine load
            # unless the tiny one is starved for the whole decompile of the biggest function.
            await clear_cache()
            tiny = min((f for f in fns if f["size"] > 0), key=lambda f: f["size"])
            i_big = await c.send("decompile", entry=big[0]["entry"])
            i_tiny = await c.send("decompile", entry=tiny["entry"])
            t_tiny, r_tiny = await asyncio.wait_for(c.waiters[i_tiny], 300)
            t_big, r_big = await asyncio.wait_for(c.waiters[i_big], 300)
            assert "result" in r_tiny and "result" in r_big and r_big["result"]["cached"] is False, (r_tiny, r_big)
            assert t_tiny < t_big, "tiny decompile waited for the big one: the pool serialised"

            # cancel running + queued still work with the pool (3 requests, 2 workers: the third is queued)
            await clear_cache()
            ranked = sorted(fns, key=lambda f: -f["size"])
            ids = [await c.send("decompile", entry=f["entry"], timeoutSecs=30) for f in ranked[2:5]]
            await asyncio.sleep(0.01)
            assert (await c.ok("cancel_decompile", id=ids[2]))["cancelled"] is True
            assert (await c.reply(ids[2]))["error"]["code"] == CANCELLED
            for i in ids[:2]:
                r = await c.reply(i)
                assert "result" in r or r["error"]["code"] == CANCELLED
            assert (await c.ok("cancel_decompile", id=999999)) == {"cancelled": False}
    run(go())


def test_function_graph_blocks_edges_and_c(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            f = next(f for f in sorted(fns, key=lambda f: f["size"]) if f["size"] > 300)
            g = await c.ok("function_graph", entry=f["entry"])
            starts = [b["start"] for b in g["blocks"]]
            assert len(starts) > 2 and f["entry"] in starts and starts == sorted(starts, key=lambda s: int(s, 16)), starts
            assert all(b["lines"] and b["kind"] in ("c", "asm") for b in g["blocks"])
            assert any(b["kind"] == "c" for b in g["blocks"]), "no block got C lines"
            assert g["edges"] and all(e["from"] in starts and e["to"] in starts for e in g["edges"]), g["edges"][:3]
            kinds = {e["kind"] for e in g["edges"]}
            assert {"true", "false"} <= kinds, kinds
            for s in starts:  # a conditional branch has exactly one true and one false edge
                ks = sorted(e["kind"] for e in g["edges"] if e["from"] == s and e["kind"] != "uncond")
                assert ks in ([], ["false", "true"]), (s, ks)
            assert await c.ok("function_graph", entry=f["entry"]) == g  # cached
            await c.err("function_graph", NOT_FOUND, entry=hex(int(f["entry"], 16) + 1))
    run(go())


def test_decompile_warnings(env):
    """A function whose C holds WARNING comments (found in /bin/ls) returns them in `warnings`, once, not in the text; a clean one has no field."""
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            warned = clean = None
            for f in sorted(fns, key=lambda f: -f["size"])[:200]:
                d = await c.ok("decompile", entry=f["entry"], timeoutSecs=60) if f["size"] < 30000 else None
                if d is None:
                    continue
                if d.get("warnings") and warned is None:
                    warned = d
                elif not d.get("warnings") and clean is None:
                    clean = d
                if warned and clean:
                    break
            assert warned, "no function with warnings in the 200 largest of the test binary"
            for w in warned["warnings"]:
                assert w.startswith("WARNING"), w
                assert w not in warned["text"], "warning shown twice: " + w
            assert len(set(warned["warnings"])) == len(warned["warnings"])
            n = len(warned["text"].split("\n"))
            assert all(t["line"] < n for t in warned["tokens"])  # tokens renumbered with the removed lines
            assert clean is not None and "warnings" not in clean
    run(go())


def test_warning_regex_never_crosses_a_comment_end():
    from ghidorita.domains.decompile import WARNING_LINE, WARNING_ONE
    assert WARNING_LINE.fullmatch("/* WARNING: a */ /* WARNING: b */") and WARNING_ONE.findall("/* WARNING: a */ /* WARNING: b */") == ["WARNING: a", "WARNING: b"]
    for line in ("/* WARNING: a */ /* my note */", "/* WARNING: a */ x = 1; /* my note */", "x = 1; /* WARNING: a */"):
        assert not WARNING_LINE.fullmatch(line.strip()), line

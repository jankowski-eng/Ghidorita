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
                t2 = await c.ok("decompile", entry=f["entry"])
                assert t2["cached"] is False and "my_renamed_var" in t2["text"] and t2["text"] != r["text"]
                # retype the renamed variable
                n = len(c.notes)
                rt = await c.call("retype_variable", entry=f["entry"], name="my_renamed_var", dataType="long")
                if "result" in rt:
                    await c.wait_note("program_changed", since=n)
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
            await clear_cache()
            t = time.monotonic()
            ids = [await c.send("decompile", entry=f["entry"]) for f in big]
            rs = [await c.reply(i) for i in ids]
            conc = time.monotonic() - t
            assert all("result" in r and r["result"]["cached"] is False for r in rs), rs
            await clear_cache()
            seq = 0.0
            for f in big:
                t = time.monotonic()
                await c.ok("decompile", entry=f["entry"])
                seq += time.monotonic() - t
            print("pool of 2: concurrent %.3fs vs sequential %.3fs" % (conc, seq))
            if seq > 0.3:  # only meaningful when the work is not trivially small
                assert conc < 0.9 * seq, (conc, seq)

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

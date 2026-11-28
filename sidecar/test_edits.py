"""Listing edits: comments and labels."""

import pytest

from ghidorita.core.errors import RpcError
from testlib import CANCELLED, Client, INVALID, NOT_FOUND, inproc, run


def test_get_comments_and_create_label(env):
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            f = fns[len(fns) // 2]
            at = f["entry"]
            assert await c.ok("get_comments", address=at) == {}
            texts = {"eol": "e1", "pre": "p1\nline2", "post": "o1", "plate": "pl1", "repeatable": "r1"}
            for k, t in texts.items():
                await c.ok("set_comment", address=at, kind=k, text=t)
            assert await c.ok("get_comments", address=at) == texts
            assert await c.ok("get_comments", address=hex(int(at, 16) + 0)) == texts
            await c.ok("set_comment", address=at, kind="pre", text="")  # empty clears: the key disappears
            assert "pre" not in await c.ok("get_comments", address=at)
            await c.err("get_comments", INVALID, address="zz")
            await c.err("get_comments", NOT_FOUND, address="0x1")
            for _ in range(6):
                await c.ok("undo")
            assert await c.ok("get_comments", address=at) == {}

            # an unlabeled code unit: rename_symbol says NotFound, create_label makes the label
            rows = await c.ok("listing_rows", address=max(fns, key=lambda f: f["size"])["entry"], count=8)
            row = next(r for r in rows[1:] if "label" not in r)
            a = row["address"]
            await c.err("rename_symbol", NOT_FOUND, address=a, newName="nope")
            since = len(c.notes)
            await c.ok("create_label", address=a, name="r5_label")
            note = (await c.wait_note("program_changed", since=since))[0]
            assert "symbol" in note["kinds"] and note["undo"]["dirty"] is True
            assert (await c.ok("listing_rows", address=a, count=1))[0]["label"] == "r5_label"
            assert any(h["name"] == "r5_label" and h["address"] == a and h["kind"] == "label" for h in await c.ok("search_symbols", query="r5_label"))
            await c.err("create_label", INVALID, address=a, name="again")  # one primary label: rename it instead
            await c.err("create_label", INVALID, address="0x1", name="x")  # not in memory
            await c.err("create_label", INVALID, address=a)  # missing name
            await c.ok("rename_symbol", address=a, newName="r5_renamed")
            await c.ok("undo"); await c.ok("undo")
            assert "label" not in (await c.ok("listing_rows", address=a, count=1))[0]
            u = await c.ok("undo_state")
            assert u["canRedo"] is True
            await c.ok("redo"); await c.ok("undo")  # round trip; leaves the shared program as it was
    run(go())


def test_function_source_and_load_coverage(env, tmp_path):
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            assert all(f["source"] in ("user", "analysis", "imported", "default") for f in await c.ok("list_functions"))
            f = fns[0]
            await c.ok("rename_symbol", address=f["entry"], newName="cov_renamed")
            assert next(g for g in await c.ok("list_functions") if g["entry"] == f["entry"])["source"] == "user"
            p = tmp_path / "cov.txt"
            p.write_text("# trace\n0x401000-0x40100f\n\n0x401020  # one\n")
            assert await c.ok("load_coverage", path=str(p)) == {"ranges": [{"start": "0x401000", "end": "0x40100f"}, {"start": "0x401020", "end": "0x401020"}]}
            p.write_text("0x10\nnope\n")
            await c.err("load_coverage", INVALID, path=str(p))
            p.write_text("0x20-0x10\n")
            await c.err("load_coverage", INVALID, path=str(p))
            await c.err("load_coverage", NOT_FOUND, path=str(tmp_path / "missing"))
            await c.ok("undo")

    run(go())


async def open_edit_blob(call, tmp_path):
    from testlib import BASE, X86, edit_blob
    path, fns = edit_blob(tmp_path)
    await call("open_binary", path=path, loader="Raw Binary", language=X86, baseAddress=BASE, analysis="blocking")
    have = {f["entry"] for f in await call("list_functions")}
    for name, entry in fns.items():
        if entry not in have:
            await call("create_function", address=entry, name=name)
    return fns


def test_set_equate_one_operand(sc, tmp_path, monkeypatch):
    async def go():
        async with inproc(tmp_path, monkeypatch) as (ctx, call):
            fns = await open_edit_blob(call, tmp_path)
            before = (await call("decompile", entry=fns["h"]))
            tok = next(t for t in before["tokens"] if t["kind"] == "const")
            assert (tok["constValue"], tok["constSize"]) == ("42", 4) and "callee(0x2a)" in before["text"]
            at = tok["address"]
            for bad in (dict(value="43"), dict(size=3), dict(name="not a name")):
                with pytest.raises(RpcError) as e:
                    await call("set_equate", address=at, **{"value": "42", "size": 4, "name": "ANSWER", **bad})
                assert e.value.code == INVALID
            await call("set_equate", address=at, value="42", size=4, name="ANSWER")
            after = await call("decompile", entry=fns["h"])
            assert "callee(ANSWER)" in after["text"] and after["cached"] is False
            assert (await call("undo_state"))["undoName"] == "Set equate ANSWER"
            await call("undo")
            assert (await call("decompile", entry=fns["h"]))["text"] == before["text"]
            await call("redo")
            assert "callee(ANSWER)" in (await call("decompile", entry=fns["h"]))["text"]
            # an enum member: the equate is named after the enum, the C shows the member
            e = (await call("create_data_type", kind="enum", name="Answers"))["path"]
            await call("edit_enum", path=e, op={"op": "set", "name": "FORTY_TWO", "value": "42"})
            await call("set_equate", address=at, value="42", size=4, name="FORTY_TWO", enum=e)
            assert "callee(FORTY_TWO)" in (await call("decompile", entry=fns["h"]))["text"]
            await call("edit_enum", path=e, op={"op": "set", "name": "ALSO_42", "value": "42"})  # a second name for the same value is as valid
            await call("set_equate", address=at, value="42", size=4, name="ALSO_42", enum=e)
            assert "callee(ALSO_42)" in (await call("decompile", entry=fns["h"]))["text"]
            await call("set_equate", address=at, value="42", size=4, name="FORTY_TWO", enum=e)  # and back, with both members existing
            assert "callee(FORTY_TWO)" in (await call("decompile", entry=fns["h"]))["text"]
            await call("set_equate", address=at, value="42", size=4, name="ALSO_42", enum=e)
            assert "callee(ALSO_42)" in (await call("decompile", entry=fns["h"]))["text"]
            with pytest.raises(RpcError) as err:
                await call("set_equate", address=at, value="42", size=4, name="NOPE", enum=e)
            assert err.value.code == INVALID
    run(go())


def test_set_function_no_return_redecompiles_callers(sc, tmp_path, monkeypatch):
    async def go():
        async with inproc(tmp_path, monkeypatch) as (ctx, call):
            fns = await open_edit_blob(call, tmp_path)
            before = await call("decompile", entry=fns["g"])
            assert "return 1" in before["text"]
            assert (await call("decompile", entry=fns["g"]))["cached"] is True
            await call("set_function_no_return", entry=fns["die"], noReturn=True)
            after = await call("decompile", entry=fns["g"])
            assert after["cached"] is False and "return 1" not in after["text"], after["text"]
            assert (await call("undo_state"))["undoName"].startswith("Mark no return")
            with pytest.raises(RpcError) as e:
                await call("set_function_no_return", entry=fns["die"], noReturn="yes")
            assert e.value.code == INVALID
            await call("undo")
            assert (await call("decompile", entry=fns["g"]))["text"] == before["text"]
    run(go())


def test_edit_results_name_their_undo_step_and_undo_can_expect_it(env):
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            at = fns[len(fns) // 2]["entry"]
            first = await c.ok("set_comment", address=at, kind="eol", text="expect-test")
            assert first["undoName"] == (await c.ok("undo_state"))["undoName"] == "Set eol comment"
            second = await c.ok("rename_symbol", address=at, newName="expect_renamed")
            assert second["undoName"].startswith("Rename ") and second["undoName"] == (await c.ok("undo_state"))["undoName"]
            # a mismatch fails Cancelled, names the actual top step, and undoes nothing
            before = await c.ok("undo_state")
            r = await c.call("undo", expect=first["undoName"])
            assert r["error"]["code"] == CANCELLED and second["undoName"] in r["error"]["message"], r
            assert await c.ok("undo_state") == before
            await c.err("undo", INVALID, expect=5)
            assert await c.ok("undo_state") == before
            # a match undoes exactly the top step; without expect nothing changed (additive)
            after = await c.ok("undo", expect=second["undoName"])
            assert after["undoName"] == first["undoName"]
            await c.ok("undo", expect=first["undoName"])  # leaves the shared program as it was
    run(go())


def test_a_no_op_edit_does_not_claim_the_previous_undo_step(env):
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            at = fns[len(fns) // 2]["entry"]
            assert await c.ok("get_comments", address=at) == {}
            mine = await c.ok("rename_symbol", address=at, newName="noop_renamed")  # an earlier step (someone else's)
            r = await c.ok("set_comment", address=at, kind="pre", text="")  # clearing a comment that is not there changes nothing
            assert "undoName" not in r, r  # it must not inherit "Rename ..." and let a later undo {expect} revert the rename
            assert (await c.ok("undo_state"))["undoName"] == mine["undoName"]
            real = await c.ok("set_comment", address=at, kind="pre", text="x")
            assert real["undoName"] == "Set pre comment"  # a real edit still names its step
            await c.ok("undo", expect=real["undoName"]); await c.ok("undo", expect=mine["undoName"])  # leaves the shared program as it was
    run(go())

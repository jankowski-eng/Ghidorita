"""Function reads and symbol search by name/address."""

import pytest

from ghidorita.core.errors import RpcError
from testlib import Client, INVALID, NOT_FOUND, inproc, run


def test_reads(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            f = max(fns, key=lambda f: f["size"])
            mid = hex(int(f["entry"], 16) + 3)
            g = await c.ok("get_function_at", address=mid)
            assert g["entry"] == f["entry"] and g["name"] == f["name"] and g["size"] == f["size"] and "(" in g["signature"]
            assert await c.ok("get_function_at", address="0x1") is None

            hits = await c.ok("search_symbols", query=f["name"][:6].upper(), limit=5)
            assert 0 < len(hits) <= 5 and all(h["kind"] in ("function", "label", "data", "external", "variable", "other") for h in hits)
            assert any(h["name"] == f["name"] for h in await c.ok("search_symbols", query=f["name"]))
            byaddr = await c.ok("search_symbols", query=f["entry"])
            assert byaddr and byaddr[0]["address"] == f["entry"]
            assert await c.ok("search_symbols", query="zzz_no_such_symbol_zzz") == []

            # a function that someone calls
            tgt = None
            for fn in fns[:400]:
                x = await c.ok("xrefs_to", address=fn["entry"])
                if x:
                    tgt, xs = fn, x
                    break
            assert tgt, "no xrefs found"
            assert all(set(r) >= {"from", "type"} for r in xs) and any(r.get("function") for r in xs)
            assert len(await c.ok("xrefs_to", address=tgt["entry"], limit=1)) == 1
            callers = [r for r in xs if "CALL" in r["type"]]
            if callers:
                frm = await c.ok("xrefs_from", address=callers[0]["from"])
                assert any(r["to"] == tgt["entry"] for r in frm), (frm, tgt)

            s = await c.ok("list_strings")
            assert s["total"] > 0 and 0 < len(s["items"]) <= 500
            assert all(i["length"] >= 4 and i["value"] and i["address"].startswith("0x") for i in s["items"])
            page = await c.ok("list_strings", offset=1, limit=2)
            assert page["items"] == s["items"][1:3] and page["total"] == s["total"]
            assert (await c.ok("list_strings", minLength=50))["total"] < s["total"]

            dts = await c.ok("list_data_types", query="int", limit=10)
            assert dts and all("int" in d["name"].lower() and d["path"] and "size" in d for d in dts)
            assert dts[0]["name"].lower().startswith("int")

            u = await c.ok("undo_state")
            assert set(u) >= {"canUndo", "canRedo"}
    run(go())


def test_get_bytes(env):
    """get_bytes: the bytes a listing row shows, longer ranges, caps, and NotFound for anything not initialized memory (nothing partial)."""
    async def go():
        async with Client(env["proc"].port) as c:
            info = await c.ok("listing_info")
            rows = await c.ok("listing_rows", address=info["ranges"][0]["start"], count=200)
            row = next(r for r in rows if r["length"] > 16 or r["length"] > 4)  # a row with at least 5 bytes
            got = await c.ok("get_bytes", address=row["address"], length=row["length"])
            assert got == {"address": row["address"], "length": row["length"], "bytes": got["bytes"]}
            assert got["bytes"].split(" ")[:len(row["bytes"].split(" "))] == row["bytes"].split(" ")
            assert len(got["bytes"].split(" ")) == row["length"]
            # two adjacent rows read as one range
            a, b = rows[0], rows[1]
            both = await c.ok("get_bytes", address=a["address"], length=a["length"] + b["length"])
            assert both["bytes"].startswith(a["bytes"]) and len(both["bytes"].split(" ")) == a["length"] + b["length"]
            first = info["ranges"][0]
            big = min(first["size"], 65536)
            assert len((await c.ok("get_bytes", address=first["start"], length=big))["bytes"].split(" ")) == big  # the cap itself is allowed
            for bad in (0, -1, 65537, 1.5, "4", None):
                await c.err("get_bytes", INVALID, address=first["start"], length=bad)
            await c.err("get_bytes", INVALID, address="nonsense", length=4)
            await c.err("get_bytes", NOT_FOUND, address="0x10", length=4)  # unmapped
            last = info["ranges"][-1]
            end = hex(int(last["start"], 16) + last["size"] - 1)
            assert len((await c.ok("get_bytes", address=end, length=1))["bytes"].split(" ")) == 1
            await c.err("get_bytes", NOT_FOUND, address=end, length=2)  # runs past the end of the range
    run(go())


def test_stack_frame(sc, tmp_path, monkeypatch):
    """A function with two stack variables of known source: the frame lists them by offset, a rename shows in the next read and in the decompile."""
    from test_edits import open_edit_blob

    async def go():
        async with inproc(tmp_path, monkeypatch) as (ctx, call):
            from ghidra.program.model.data import IntegerDataType, LongDataType
            from ghidra.program.model.listing import LocalVariableImpl
            from ghidra.program.model.symbol import SourceType
            fns = await open_edit_blob(call, tmp_path)
            k = fns["k"]
            assert (await call("stack_frame", entry=k))["slots"] == []
            prog, f = ctx.session.program, ctx.session.program.getFunctionManager().getFunctionAt(ctx.session.addr(k))
            tx = prog.startTransaction("variables")
            try:
                f.addLocalVariable(LocalVariableImpl("counter", IntegerDataType.dataType, -8, prog), SourceType.USER_DEFINED)
                f.addLocalVariable(LocalVariableImpl("buf", LongDataType.dataType, -12, prog), SourceType.ANALYSIS)
                f.addLocalVariable(LocalVariableImpl("local_10", LongDataType.dataType, -16, prog), SourceType.DEFAULT)
            finally:
                prog.endTransaction(tx, True)
            fr = await call("stack_frame", entry=k)
            assert fr["entry"] == k and fr["name"] == "k"
            assert fr["slots"] == [
                {"offset": -16, "size": 4, "name": "local_10", "dataType": "long", "parameter": False, "source": "default"},
                {"offset": -12, "size": 4, "name": "buf", "dataType": "long", "parameter": False, "source": "analysis"},
                {"offset": -8, "size": 4, "name": "counter", "dataType": "int", "parameter": False, "source": "user"}], fr
            assert "counter" in (await call("decompile", entry=k))["text"]
            await call("rename_variable", entry=k, name="counter", newName="total")
            fr = await call("stack_frame", entry=k)
            assert [s["name"] for s in fr["slots"]] == ["local_10", "buf", "total"] and fr["slots"][2]["source"] == "user"
            text = (await call("decompile", entry=k))["text"]
            assert "total" in text and "counter" not in text
            await call("retype_variable", entry=k, name="total", dataType="short")
            assert next(s for s in (await call("stack_frame", entry=k))["slots"] if s["name"] == "total")["dataType"] == "short"
            with pytest.raises(RpcError) as e:
                await call("stack_frame", entry="0x1")
            assert e.value.code == NOT_FOUND
    run(go())

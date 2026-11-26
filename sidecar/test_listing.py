"""Listing and function reads."""

from testlib import Client, run


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

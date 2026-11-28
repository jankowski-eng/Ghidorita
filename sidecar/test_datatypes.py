"""Data type manager RPCs (tree, detail, struct/enum editors, apply) against real Ghidra on /bin/ls; one analysis copied per test."""
import asyncio, time

from testlib import BIN, INVALID, NOT_FOUND, NO_PROGRAM, Client, Proc, bare, run
from test_persist import base, change, projects  # noqa: F401  (fixtures)


def comps(d):
    return [(x["ordinal"], x["offset"], x["length"], x["type"], x["name"], x["undefined"]) for x in d["components"]]


async def with_prog(projects, fn):
    proc = Proc(projects)
    try:
        async with Client(proc.port) as c:
            await c.ok("open_binary", path=BIN)
            return await fn(c)
    finally:
        proc.stop()


def test_no_program_and_tree(projects):
    async def go():
        proc = Proc(projects)
        try:
            async with Client(proc.port) as c:
                for m, kw in (("dt_sources", {}), ("dt_children", {}), ("get_data_type", {"path": "/x"}), ("create_data_type", {"kind": "struct", "name": "S"}),
                              ("edit_struct", {"path": "/S", "op": {"op": "add", "type": "int"}}), ("create_struct_from_data", {"address": "0x1", "length": 1, "name": "S"})):
                    await c.err(m, NO_PROGRAM, **kw)
                await c.ok("open_binary", path=BIN)
                src = await c.ok("dt_sources")
                assert [s["id"] for s in src] == ["program", "builtin"] and src[0]["writable"] and not src[1]["writable"]
                root = await c.ok("dt_children")
                assert root["categories"] and root["types"]
                assert all(set(t) == {"name", "path", "kind", "size"} for t in root["types"])
                assert {t["kind"] for t in root["types"]} <= {"struct", "union", "enum", "typedef", "pointer", "function", "array", "builtin"}
                names = [t["name"].lower() for t in root["types"]]
                assert names == sorted(names)
                cat = root["categories"][0]
                sub = await c.ok("dt_children", path=cat["path"])  # lazy: one level at a time
                assert set(sub) == {"categories", "types"}
                b = await c.ok("dt_children", source="builtin", path="/")
                assert any(t["name"] == "dword" and t["size"] == 4 for t in b["types"])
                d = await c.ok("get_data_type", source="builtin", path="/dword")
                assert d["kind"] == "builtin" and d["writable"] is False
                await c.err("dt_children", NOT_FOUND, path="/no/such/category")
                await c.err("dt_children", INVALID, source="nope")
                await c.err("get_data_type", NOT_FOUND, path="/NoSuchType")
                await c.err("create_data_type", INVALID, kind="bogus", name="X")
                hits = await c.ok("list_data_types", query="dword", limit=5)
                assert hits and hits[0]["kind"] == "builtin" and "size" in hits[0] and {h["source"] for h in hits} <= {"program", "builtin"}
        finally:
            proc.stop()
    run(go())


def test_struct_editor_undo_and_filler(projects):
    async def go(c):
        u = lambda: c.ok("undo_state")
        assert bare(await c.ok("create_data_type", kind="struct", name="S1")) == {"path": "/S1"}
        d = await c.ok("get_data_type", path="/S1")
        assert d["kind"] == "struct" and d["size"] == 0 and d["components"] == [] and d["packed"] is False
        await c.err("create_data_type", INVALID, kind="struct", name="S1")  # no silent "S1.conflict"
        names = ["Edit S1: add", "Edit S1: add", "Edit S1: add"]
        for op in ({"type": "dword", "name": "a"}, {"type": "char[8]", "name": "nm", "comment": "the name"}, {"type": "S1 *", "name": "next"}):
            n = len(c.notes)
            await c.ok("edit_struct", path="/S1", op={"op": "add", **op})
            ev = (await c.wait_note("program_changed", since=n))[0]
            assert "type" in ev["kinds"] and ev["undo"]["undoName"] == "Edit S1: add"  # one transaction per edit
        d = await c.ok("get_data_type", path="/S1")
        assert comps(d) == [(0, 0, 4, "dword", "a", False), (1, 4, 8, "char[8]", "nm", False), (2, 12, 8, "S1 *", "next", False)] and d["size"] == 20
        assert d["components"][1]["comment"] == "the name"
        # a user type by name, array/pointer syntax, errors
        await c.err("edit_struct", INVALID, path="/S1", op={"op": "add", "type": "nosuchtype"})
        await c.err("edit_struct", INVALID, path="/S1", op={"op": "add", "type": "S1"})  # direct cycle
        await c.err("edit_struct", INVALID, path="/S1", op={"op": "add", "type": "string"})  # dynamic length
        await c.err("edit_struct", INVALID, path="/S1", op={"op": "delete", "ordinal": 9})
        await c.err("edit_struct", INVALID, path="/S1", op={"op": "bogus"})
        await c.err("edit_struct", INVALID, path="/S1", op={"op": "move", "ordinal": 0, "to": 1})  # unpacked: fixed offsets
        await c.err("edit_struct", NOT_FOUND, path="/Nope", op={"op": "add", "type": "int"})
        await c.err("edit_struct", INVALID, path="/dword", op={"op": "add", "type": "int"})
        assert (await u())["undoName"] == "Edit S1: add"  # failures left nothing on the stack
        # resize adds undefined filler; set on a filler byte replaces it (consuming following filler)
        await c.ok("edit_struct", path="/S1", op={"op": "resize", "size": 32})
        d = await c.ok("get_data_type", path="/S1")
        assert d["size"] == 32 and [x["undefined"] for x in d["components"]] == [False] * 3 + [True] * 12 and d["components"][3]["offset"] == 20
        await c.ok("edit_struct", path="/S1", op={"op": "set", "ordinal": 3, "type": "dword", "name": "tail"})
        d = await c.ok("get_data_type", path="/S1")
        assert comps(d)[3] == (3, 20, 4, "dword", "tail", False) and d["size"] == 32
        await c.err("edit_struct", INVALID, path="/S1", op={"op": "set", "ordinal": 4, "name": "x"})  # filler needs a type
        # clear -> undefined filler (size kept); delete -> removed, later fields shift up
        await c.ok("edit_struct", path="/S1", op={"op": "clear", "ordinal": 0})
        d = await c.ok("get_data_type", path="/S1")
        assert d["size"] == 32 and d["components"][0]["undefined"] and d["components"][4]["name"] == "nm"
        await c.ok("edit_struct", path="/S1", op={"op": "set", "ordinal": 0, "type": "int", "name": "a"})
        await c.ok("edit_struct", path="/S1", op={"op": "delete", "ordinal": 0})
        d = await c.ok("get_data_type", path="/S1")
        assert d["size"] == 28 and d["components"][0]["name"] == "nm" and d["components"][0]["offset"] == 0
        # set: only the comment changes, the rest is kept; "" clears
        await c.ok("edit_struct", path="/S1", op={"op": "set", "ordinal": 0, "comment": "new"})
        await c.ok("edit_struct", path="/S1", op={"op": "set", "ordinal": 0, "name": "name2"})
        x = (await c.ok("get_data_type", path="/S1"))["components"][0]
        assert (x["name"], x["comment"], x["type"]) == ("name2", "new", "char[8]")
        await c.ok("edit_struct", path="/S1", op={"op": "set", "ordinal": 0, "comment": ""})
        assert (await c.ok("get_data_type", path="/S1"))["components"][0]["comment"] is None
        await c.ok("edit_struct", path="/S1", op={"op": "insert", "ordinal": 0, "type": "byte", "name": "first"})
        assert comps(await c.ok("get_data_type", path="/S1"))[:2] == [(0, 0, 1, "byte", "first", False), (1, 1, 8, "char[8]", "name2", False)]
        # pack: offsets become aligned, reorder works, unpack keeps the layout
        await c.ok("edit_struct", path="/S1", op={"op": "pack", "packed": True})
        d = await c.ok("get_data_type", path="/S1")
        assert d["packed"] is True and not any(x["undefined"] for x in d["components"]) and d["alignment"] == 8
        before = [x["name"] for x in d["components"]]
        await c.ok("edit_struct", path="/S1", op={"op": "move", "ordinal": 0, "to": 2})
        after = [x["name"] for x in (await c.ok("get_data_type", path="/S1"))["components"]]
        assert after == [before[1], before[2], before[0]] + before[3:]
        await c.err("edit_struct", INVALID, path="/S1", op={"op": "resize", "size": 99})  # packed: size is computed
        await c.ok("edit_struct", path="/S1", op={"op": "pack", "packed": True, "packingValue": 1})
        assert (await c.ok("get_data_type", path="/S1"))["packingValue"] == 1
        await c.ok("edit_struct", path="/S1", op={"op": "pack", "packed": False})
        assert (await c.ok("get_data_type", path="/S1"))["packed"] is False
        # union
        await c.ok("create_data_type", kind="union", name="U1")
        await c.ok("edit_struct", path="/U1", op={"op": "add", "type": "dword", "name": "i"})
        await c.ok("edit_struct", path="/U1", op={"op": "add", "type": "qword", "name": "q"})
        d = await c.ok("get_data_type", path="/U1")
        assert d["kind"] == "union" and d["size"] == 8 and [x["offset"] for x in d["components"]] == [0, 0]
        await c.ok("edit_struct", path="/U1", op={"op": "move", "ordinal": 1, "to": 0})
        assert [x["name"] for x in (await c.ok("get_data_type", path="/U1"))["components"]] == ["q", "i"]
        await c.ok("edit_struct", path="/U1", op={"op": "clear", "ordinal": 0})
        assert len((await c.ok("get_data_type", path="/U1"))["components"]) == 1
        # every edit above is one undo step: undo the last one and the previous layout is back exactly
        d1 = await c.ok("get_data_type", path="/S1")
        await c.ok("edit_struct", path="/S1", op={"op": "set", "ordinal": 0, "name": "zzz"})
        assert (await u())["undoName"] == "Edit S1: set"
        await c.ok("undo")
        assert await c.ok("get_data_type", path="/S1") == d1
        await c.ok("redo")
        assert (await c.ok("get_data_type", path="/S1"))["components"][0]["name"] == "zzz"
    run(with_prog(projects, go))


def test_enum_typedef_pointer_category_delete_rename(projects):
    async def go(c):
        await c.ok("create_data_type", kind="enum", name="E1", size=2)
        for name, v in (("A", "1"), ("B", "0x10"), ("NEG", "-1"), ("BIG", "0xffffffffffffffff")):
            await c.ok("edit_enum", path="/E1", op={"op": "set", "name": name, "value": v})
        d = await c.ok("get_data_type", path="/E1")
        assert d["kind"] == "enum" and d["size"] == 2
        assert {v["name"]: v["value"] for v in d["values"]}["NEG"] == "-1"
        assert [v["name"] for v in d["values"]][:2] == ["NEG", "BIG"] or [v["name"] for v in d["values"]][0] in ("NEG", "BIG")
        await c.ok("edit_enum", path="/E1", op={"op": "set", "oldName": "A", "name": "A2", "value": "3"})  # rename + new value
        vals = {v["name"]: v["value"] for v in (await c.ok("get_data_type", path="/E1"))["values"]}
        assert "A" not in vals and vals["A2"] == "3"
        await c.err("edit_enum", INVALID, path="/E1", op={"op": "set", "oldName": "A2", "name": "B", "value": "1"})  # duplicate
        await c.err("edit_enum", INVALID, path="/E1", op={"op": "set", "name": "X", "value": "nope"})
        await c.err("edit_enum", NOT_FOUND, path="/E1", op={"op": "remove", "name": "nope"})
        await c.ok("edit_enum", path="/E1", op={"op": "remove", "name": "B"})
        await c.ok("edit_enum", path="/E1", op={"op": "resize", "size": 8})
        d = await c.ok("get_data_type", path="/E1")
        assert d["size"] == 8 and "B" not in [v["name"] for v in d["values"]]
        await c.err("create_data_type", INVALID, kind="enum", name="E2", size=3)
        await c.err("edit_enum", INVALID, path="/E1", op={"op": "bogus"})
        await c.err("edit_enum", INVALID, path="/E1", op=5)
        # typedef / pointer / category
        assert bare(await c.ok("create_data_type", kind="typedef", name="mytype_t", base="E1 *")) == {"path": "/mytype_t"}
        t = await c.ok("get_data_type", path="/mytype_t")
        assert t["kind"] == "typedef" and t["base"] == "E1 *" and t["size"] == 8
        await c.err("create_data_type", INVALID, kind="typedef", name="bad", base="nosuchtype")
        assert (await c.ok("create_data_type", kind="pointer", base="E1"))["path"] == "/E1 *"
        assert (await c.ok("get_data_type", path="/E1 *"))["kind"] == "pointer"
        assert bare(await c.ok("create_data_type", kind="category", name="Mine")) == {"path": "/Mine"}
        assert bare(await c.ok("create_data_type", kind="struct", name="In", category="/Mine")) == {"path": "/Mine/In"}
        await c.err("create_data_type", INVALID, kind="category", name="Mine")
        kids = await c.ok("dt_children", path="/Mine")
        assert [t["path"] for t in kids["types"]] == ["/Mine/In"] and kids["categories"] == []
        assert any(c_["path"] == "/Mine" for c_ in (await c.ok("dt_children"))["categories"])
        await c.err("delete_data_type", INVALID, path="/Mine", category=True)  # not empty
        r = await c.ok("rename_data_type", path="/Mine/In", newName="Out")
        assert bare(r) == {"path": "/Mine/Out"}
        await c.err("rename_data_type", INVALID, path="/Mine/Out", newName="has space")
        await c.ok("delete_data_type", path="/Mine/Out")
        await c.ok("delete_data_type", path="/Mine", category=True)
        await c.err("get_data_type", NOT_FOUND, path="/Mine/Out")
        await c.err("dt_children", NOT_FOUND, path="/Mine")
        await c.ok("undo")  # category delete is undoable
        assert (await c.ok("dt_children", path="/Mine"))["types"] == []
        await c.ok("delete_data_type", path="/mytype_t")
        await c.err("delete_data_type", NOT_FOUND, path="/mytype_t")
    run(with_prog(projects, go))


async def first_string(c):
    return (await c.ok("list_strings", limit=1))["items"][0]


def test_apply_listing_decompiler_cache_undo_redo_persist(projects):
    """create struct, add fields, apply it to data, show it in listing + decompiler, undo all, redo all, save, reopen."""
    state = {}

    async def go(c):
        fns = await c.ok("list_functions")
        # a function with a retypeable local, decompiled once so its result is cached
        pick = None
        for f in sorted(fns, key=lambda f: -f["size"])[:40]:
            r = await c.ok("decompile", entry=f["entry"])
            v = [k for k in r["tokens"] if k["kind"] in ("variable", "param") and k.get("varName") and k["line"] > 0]
            if v:
                pick = (f, v[0]["varName"])
                break
        assert pick
        f, var = pick
        assert (await c.ok("decompile", entry=f["entry"]))["cached"] is True
        s = await first_string(c)
        a = s["address"]
        await c.ok("create_data_type", kind="struct", name="DtApply")
        # type changes clear the decompile cache as a whole (shortcut kept: decompiler output embeds other types' layouts)
        assert (await c.ok("decompile", entry=f["entry"]))["cached"] is False
        assert (await c.ok("decompile", entry=f["entry"]))["cached"] is True
        n = len(c.notes)
        await c.ok("edit_struct", path="/DtApply", op={"op": "add", "type": "dword", "name": "first"})
        ev = (await c.wait_note("program_changed", since=n))[0]
        assert "type" in ev["kinds"] and ev["ranges"] is None
        assert (await c.ok("decompile", entry=f["entry"]))["cached"] is False  # type change: nothing stale
        assert (await c.ok("decompile", entry=f["entry"]))["cached"] is True
        await c.ok("edit_struct", path="/DtApply", op={"op": "add", "type": "char[8]", "name": "second"})
        # apply (reuses define_data, by path) -> listing shows the struct
        n = len(c.notes)
        await c.ok("define_data", address=a, dataType="/DtApply")
        ev = (await c.wait_note("program_changed", since=n))[0]
        assert "data" in ev["kinds"]
        row = (await c.ok("listing_rows", address=a, count=1))[0]
        assert row["mnemonic"] == "DtApply" and row["length"] == 12, row
        # editing the struct while applied resizes the listing row (applied data follows the type)
        await c.ok("edit_struct", path="/DtApply", op={"op": "add", "type": "word", "name": "third"})
        row = (await c.ok("listing_rows", address=a, count=1))[0]
        assert row["mnemonic"] == "DtApply" and row["length"] in (12, 14), row
        # decompiler: retype a local to a pointer to the new struct
        await c.ok("retype_variable", entry=f["entry"], name=var, dataType="DtApply *")
        t = await c.ok("decompile", entry=f["entry"])
        assert t["cached"] is False and "DtApply" in t["text"], t["text"][:400]
        top = await c.ok("undo_state")
        assert top["undoName"].startswith("Retype")
        state.update(f=f["entry"], a=a, var=var, text=t["text"], length=row["length"])
        # undo everything one step at a time, then redo it all
        steps = 0
        while (await c.ok("undo_state"))["canUndo"]:
            await c.ok("undo")
            steps += 1
        assert steps == 6, steps  # create, add, add, define, add, retype
        await c.err("get_data_type", NOT_FOUND, path="/DtApply")
        assert (await c.ok("listing_rows", address=a, count=1))[0]["mnemonic"] != "DtApply"
        assert "DtApply" not in (await c.ok("decompile", entry=f["entry"]))["text"]
        for _ in range(steps):
            await c.ok("redo")
        d = await c.ok("get_data_type", path="/DtApply")
        assert [x["name"] for x in d["components"]] == ["first", "second", "third"]
        assert (await c.ok("listing_rows", address=a, count=1))[0]["mnemonic"] == "DtApply"
        assert "DtApply" in (await c.ok("decompile", entry=f["entry"]))["text"]
        assert (await c.ok("save"))["saved"] is True
    run(with_prog(projects, go))

    async def again(c):
        d = await c.ok("get_data_type", path="/DtApply")
        assert [x["name"] for x in d["components"]] == ["first", "second", "third"]
        row = (await c.ok("listing_rows", address=state["a"], count=1))[0]
        assert row["mnemonic"] == "DtApply" and row["length"] == state["length"]
        assert "DtApply" in (await c.ok("decompile", entry=state["f"]))["text"]
        assert (await c.ok("undo_state"))["dirty"] is False
    run(with_prog(projects, again))


def test_create_struct_from_data(projects):
    async def go(c):
        # two defined items back to back + undefined tail: int, short, then 2 undefined bytes
        fns = await c.ok("list_functions")
        s = await first_string(c)
        a = int(s["address"], 16)
        base_ = hex(a)
        await c.ok("define_data", address=base_, dataType="int")  # (no clear_code: on the Mach-O header it also wiped instructions elsewhere)
        await c.ok("define_data", address=hex(a + 4), dataType="short")
        n = len(c.notes)
        r = await c.ok("create_struct_from_data", address=base_, length=8, name="FromData")
        assert bare(r) == {"path": "/FromData"}
        ev = await change(c, n, "Create structure FromData")
        assert "type" in ev["kinds"] or "data" in ev["kinds"]
        d = await c.ok("get_data_type", path="/FromData")
        assert d["size"] == 8 and [(x["offset"], x["type"], x["undefined"]) for x in d["components"] if not x["undefined"]] == [(0, "int", False), (4, "short", False)]
        assert sum(1 for x in d["components"] if x["undefined"]) == 2
        row = (await c.ok("listing_rows", address=base_, count=1))[0]
        assert row["mnemonic"] == "FromData" and row["length"] == 8  # applied
        await c.err("create_struct_from_data", INVALID, address=base_, length=8, name="FromData")  # exists
        await c.err("create_struct_from_data", INVALID, address=base_, length=0, name="Zero")
        await c.err("create_struct_from_data", INVALID, address=hex(a + 2), length=4, name="Mid")  # starts inside an item
        await c.ok("undo")  # one transaction: type and its application go together
        await c.err("get_data_type", NOT_FOUND, path="/FromData")
        assert (await c.ok("listing_rows", address=base_, count=1))[0]["mnemonic"] != "FromData"
        # not applied, and instructions are refused
        await c.ok("create_struct_from_data", address=base_, length=8, name="NoApply", apply=False)
        assert (await c.ok("listing_rows", address=base_, count=1))[0]["mnemonic"] != "NoApply"
        await c.err("create_struct_from_data", INVALID, address=fns[5]["entry"], length=4, name="Code")
    run(with_prog(projects, go))


def test_auto_create_structure(projects):
    """FillOutStructureHelper on a decompiler variable: struct inferred from field accesses, variable retyped, one undo step."""
    async def go(c):
        fns = await c.ok("list_functions")
        await c.err("auto_create_structure", NOT_FOUND, entry=fns[0]["entry"], name="no_such_var")
        await c.err("auto_create_structure", INVALID, entry=fns[0]["entry"], name="x", structName="bad name")
        found = None
        for f in sorted(fns, key=lambda f: -f["size"])[:60]:
            r = await c.ok("decompile", entry=f["entry"])
            for v in sorted({k["varName"] for k in r["tokens"] if k["kind"] in ("param", "variable") and k.get("varName")}):
                base = (await c.ok("undo_state")).get("undoName")
                n = len(c.notes)
                res = await c.call("auto_create_structure", entry=f["entry"], name=v, structName="AutoS")
                if "result" in res:
                    found = (f, v, res["result"], n, base)
                    break
            if found:
                break
        assert found, "no variable with inferable field accesses in the 60 largest functions"
        f, v, res, n, base = found
        assert bare(res) == {"path": "/auto_structs/AutoS"}, res
        await c.wait_note("program_changed", since=n)  # (failed attempts fire their own rolled-back ones too)
        assert (await c.ok("undo_state"))["undoName"].startswith("Auto create structure")
        d = await c.ok("get_data_type", path=res["path"])
        assert d["kind"] == "struct" and d["size"] > 0 and any(not x["undefined"] for x in d["components"]), d
        t = await c.ok("decompile", entry=f["entry"])
        assert t["cached"] is False and "AutoS" in t["text"], t["text"][:400]
        await c.ok("undo")  # one transaction: struct, pointer and the variable's type go together
        assert (await c.ok("undo_state")).get("undoName") == base
        await c.err("get_data_type", NOT_FOUND, path=res["path"])
        assert "AutoS" not in (await c.ok("decompile", entry=f["entry"]))["text"]
        await c.ok("redo")
        assert "AutoS" in (await c.ok("decompile", entry=f["entry"]))["text"]
    run(with_prog(projects, go))

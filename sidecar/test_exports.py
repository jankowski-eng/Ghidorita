"""Exports: the JSON symbol map and the C header, after a rename and a new structure."""
import json, os, re

from testlib import Client, INVALID, Proc, run


def test_export_symbols_and_header_after_rename(env, tmp_path):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            target = next(f for f in fns if f["source"] != "user" and f["size"] > 8)
            await c.ok("rename_symbol", address=target["entry"], newName="renamed_for_export")
            await c.ok("create_data_type", kind="struct", name="ExportStruct")
            await c.ok("edit_struct", path="/ExportStruct", op={"op": "add", "name": "len", "type": "int"})
            a0 = (await c.ok("listing_info"))["ranges"][0]["start"]
            await c.ok("set_comment", address=a0, kind="plate", text="export comment")
            try:
                js, h = str(tmp_path / "syms.json"), str(tmp_path / "prog.h")
                r = await c.ok("export_symbols", path=js)
                m = json.load(open(js))
                assert r["functions"] == len(m["functions"]) >= len(fns) and m["data"] and m["labels"]
                f = next(x for x in m["functions"] if x["address"] == target["entry"])
                assert f["name"] == "renamed_for_export" and f["source"] == "user" and "renamed_for_export" in f["signature"], f
                assert {x["source"] for x in m["functions"]} <= {"user", "imported", "analysis", "default", "other"} and "user" in {x["source"] for x in m["functions"]}
                assert all({"address", "name", "type", "source"} <= set(d) for d in m["data"])
                assert {"address": a0, "kind": "plate", "text": "export comment"} in m["comments"]
                r = await c.ok("export_header", path=h)
                text = open(h).read()
                assert re.search(r"struct ExportStruct\s*\{", text) or "ExportStruct" in text, text[:400]
                assert re.search(r"\brenamed_for_export\s*\(", text), "prototype of the renamed function"
                assert r["functions"] > 10 and r["types"] >= 1
                await c.err("export_symbols", INVALID, path="relative.json")
                await c.err("export_header", INVALID, path=str(tmp_path / "no" / "such" / "x.h"))
            finally:
                for _ in range(4):  # comment, struct fields, struct, rename
                    await c.ok("undo")
    run(go())


def test_export_gzf_reopens_with_same_functions_and_unsaved_edit(env, tmp_path):
    """Ghidra archive of /bin/ls, taken with an unsaved rename: non-empty, and a second sidecar (own project) imports it with the same functions."""
    fns = env["fns"]
    gzf = str(tmp_path / "ls.gzf")
    async def go():
        async with Client(env["proc"].port) as c:
            target = next(f for f in fns if f["source"] != "user" and f["size"] > 8)
            await c.err("export_gzf", INVALID, path="relative.gzf")
            await c.err("export_gzf", INVALID, path=str(tmp_path / "no" / "such" / "x.gzf"))
            await c.err("export_gzf", INVALID, path=str(tmp_path))
            await c.ok("rename_symbol", address=target["entry"], newName="renamed_for_gzf")
            try:
                assert (await c.ok("undo_state"))["dirty"]
                r = await c.ok("export_gzf", path=gzf)
                assert r["path"] == gzf and r["bytes"] == os.path.getsize(gzf) > 100_000
                assert (await c.ok("undo_state"))["dirty"], "exporting must not save the program"
            finally:
                await c.ok("undo")
        proc2 = Proc(tmp_path / "projects2")
        try:
            async with Client(proc2.port) as c2:
                await c2.ok("open_binary", path=gzf)
                again = await c2.ok("list_functions")
                assert len(again) == len(fns), (len(again), len(fns))
                assert next(f for f in again if f["entry"] == target["entry"])["name"] == "renamed_for_gzf"
        finally:
            proc2.stop()
    run(go())

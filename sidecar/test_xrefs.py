"""Cross references."""

import pytest

from testlib import Client, INVALID, NOT_FOUND, Proc, run, win_exe


def test_xref_kinds_and_variables(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            kinds = set()
            tgt = None
            for fn in fns[:400]:
                for r in await c.ok("xrefs_to", address=fn["entry"]):
                    assert r["kind"] in ("call", "jump", "read", "write", "readwrite", "data", "flow", "other")
                    kinds.add(r["kind"])
                    if r["kind"] == "call" and tgt is None:
                        tgt = r
            assert "call" in kinds, kinds
            frm = await c.ok("xrefs_from", address=tgt["from"])
            assert frm and all(r["target"] in ("memory", "stack", "register", "external") and r["kind"] for r in frm)
            assert any(r["target"] == "memory" and r["to"].startswith("0x") and r["kind"] == "call" for r in frm)
            # variables: find any function whose parameters or locals have references (x86-64 stack locals / parameters)
            found = None
            for fn in sorted(fns, key=lambda f: -f["size"])[:40]:
                r = await c.call("decompile", entry=fn["entry"])
                for t in r["result"]["tokens"]:
                    if t.get("varName") and t["kind"] in ("variable", "param"):
                        xs = await c.ok("xrefs_to_variable", entry=fn["entry"], name=t["varName"])
                        assert isinstance(xs, list)
                        if xs and not found:
                            found = (fn, t["varName"], xs)
                if found:
                    break
            print("variable xrefs:", found and (found[0]["name"], found[1], len(found[2]), found[2][0]))
            if found:
                assert found[2][0]["kind"] in ("read", "write", "readwrite", "data") and found[2][0]["function"] == found[0]["name"]
            assert await c.ok("xrefs_to_variable", entry=fns[0]["entry"], name="no_such_variable") == []
            await c.err("xrefs_to_variable", NOT_FOUND, entry="0x1", name="a")
            await c.err("xrefs_to_variable", INVALID, entry=fns[0]["entry"], name=3)
    run(go())


def test_xrefs_from_external_on_pe(tmp_path):
    exe = win_exe()
    if not exe:
        pytest.skip("Ghidra's WinHelloCPP.exe exercise file is not in the install")
    proc = Proc(tmp_path / "projects")

    async def go():
        async with Client(proc.port) as c:
            await c.ok("open_binary", path=exe)
            addr = None
            rows = await c.ok("listing_rows", address="0x401000", count=1000)
            for row in rows:
                x = await c.ok("xrefs_from", address=row["address"])
                ext = [e for e in x if e["target"] == "external"]
                if ext:
                    addr, ext = row["address"], ext[0]
                    break
            assert addr, "no external reference in the first 1000 code units"
            assert ext["to"] is None and ext["label"] == "CreateWindowExA" and ext["type"]
            assert any(e["target"] == "memory" for e in x)  # the IAT slot is still a memory reference of the same instruction
            slot = next(e["to"] for e in x if e["target"] == "memory")
            assert any(r["from"] == addr for r in await c.ok("xrefs_to", address=slot))  # imports are found *to* via their IAT slot
    try:
        run(go())
    finally:
        proc.stop()

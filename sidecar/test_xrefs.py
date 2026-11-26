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



def test_call_graph_neighbourhood_and_routes(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            byname = {f["entry"]: f for f in fns}
            # a caller -> callee pair from the references themselves
            pair = None
            for fn in fns[:400]:
                for r in await c.ok("xrefs_to", address=fn["entry"]):
                    if r["kind"] == "call" and r.get("function"):
                        caller = (await c.ok("get_function_at", address=r["from"]))["entry"]
                        if caller != fn["entry"]:
                            pair = (caller, fn["entry"]); break
                if pair:
                    break
            caller, callee = pair
            g = await c.ok("call_graph", entry=caller)
            ids = {n["entry"] for n in g["nodes"]}
            assert caller in ids and callee in ids and g["truncated"] in (True, False)
            assert all(e["from"] in ids and e["to"] in ids and e["sites"] >= 1 for e in g["edges"])
            assert any(e["from"] == caller and e["to"] == callee for e in g["edges"]), g["edges"][:5]
            assert all(n["kind"] in ("function", "import") and n["name"] for n in g["nodes"])
            assert any(n["kind"] == "import" for n in g["nodes"]) or len(g["nodes"]) < 3, g["nodes"][:5]  # ls calls libc through stubs
            assert not [e for e in g["edges"] if e["from"] in {n["entry"] for n in g["nodes"] if n["kind"] == "import"}]  # imports are leaves
            up = await c.ok("call_graph", entry=callee, depth=1)
            assert any(e["from"] == caller and e["to"] == callee for e in up["edges"])  # callers come along
            # routes: the direct one at least; every node of a route lies on a path from caller to callee
            p = await c.ok("call_graph", entry=caller, to=callee)
            assert any(e["from"] == caller and e["to"] == callee for e in p["edges"])
            outs, ins = {e["from"] for e in p["edges"]}, {e["to"] for e in p["edges"]}
            for n in p["nodes"]:
                assert n["entry"] == caller or n["entry"] in ins, n
                assert n["entry"] == callee or n["entry"] in outs, n
            mids = {n["entry"] for n in p["nodes"]} - {caller, callee}  # a direct call: only routes of two calls besides it
            assert all((caller, m) in {(e["from"], e["to"]) for e in p["edges"]} and (m, callee) in {(e["from"], e["to"]) for e in p["edges"]} for m in mids), mids
            none = await c.ok("call_graph", entry=callee, to=caller, maxDepth=1)
            assert {callee, caller} <= {n["entry"] for n in none["nodes"]}  # both shown, a route only if the callee calls back
            await c.err("call_graph", NOT_FOUND, entry=hex(int(fns[0]["entry"], 16) + 1))
            await c.err("call_graph", INVALID, entry=caller, to=5)
            assert byname  # fns came from list_functions
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


def test_function_calls_on_ls(env):
    """/bin/ls: a function and the functions it calls agree with xrefs_to; thunks (import stubs) say what they forward to; sorted, entries unique."""
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            by = {f["entry"]: f for f in fns}
            best = None
            for f in fns[:400]:  # the first function with a call to something and a caller
                r = await c.ok("function_calls", entry=f["entry"])
                if r["callers"] and r["callees"]:
                    best = (f, r)
                    break
            assert best, "no function with callers and callees among the first 400"
            f, r = best
            for side in ("callers", "callees"):
                es = [e["entry"] for e in r[side] if e["entry"]]
                assert es == sorted(es, key=lambda a: int(a, 16)) and len(set(es)) == len(es)
            for caller in r["callers"]:
                assert caller["entry"] in by, caller
                callee_entries = [e["entry"] for e in (await c.ok("function_calls", entry=caller["entry"]))["callees"]]
                assert f["entry"] in callee_entries, "a caller lists the function among its callees"
                assert any(x["kind"] == "call" for x in await c.ok("xrefs_to", address=f["entry"])), "xrefs_to has the call too"
            thunks = [e for e in r["callees"] if e["thunk"]]
            for e in thunks:
                assert e["target"]["name"]
            await c.err("function_calls", NOT_FOUND, entry="0x10")
            await c.err("function_calls", INVALID, entry="zz")
    run(go())


# ---- call_graph on the scan lane: bounded, cancellable, never on R (in-process, a hand-built two-function program: f1 calls f2) ----
import asyncio, threading, time

from ghidrette.core.errors import RpcError
from ghidrette.domains import xrefs as xrefs_mod
from testlib import BASE, CANCELLED, X86, blob, inproc


async def two_functions(call, tmp_path):
    await call("open_binary", path=blob(tmp_path), loader="Raw Binary", language=X86, baseAddress=BASE, analysis="blocking")
    have = {f["entry"] for f in await call("list_functions")}
    f2 = "0x%x" % (int(BASE, 16) + 0x10)
    for entry, name in ((BASE, "f1"), (f2, "f2")):
        if entry not in have:
            await call("create_function", address=entry, name=name)
    return BASE, f2


def test_call_graph_bounds_truncate(sc, tmp_path, monkeypatch):
    async def go():
        async with inproc(tmp_path, monkeypatch) as (ctx, call):
            f1, f2 = await two_functions(call, tmp_path)
            g = await call("call_graph", entry=f1)
            assert g["truncated"] is False and {n["entry"] for n in g["nodes"]} == {f1, f2}, g
            r = await call("call_graph", entry=f1, to=f2)
            assert r["truncated"] is False and [(e["from"], e["to"]) for e in r["edges"]] == [(f1, f2)], r
            with monkeypatch.context() as patch:
                patch.setattr(xrefs_mod, "CALL_GRAPH_MAX_VISITED", 1)  # depth 2 needs two visits per side, a route search two as well
                assert (await call("call_graph", entry=f1))["truncated"] is True
                assert (await call("call_graph", entry=f1, to=f2))["truncated"] is True
            with monkeypatch.context() as patch:
                patch.setattr(xrefs_mod, "CALL_GRAPH_MAX_SECS", -1.0)
                assert (await call("call_graph", entry=f1))["truncated"] is True
            assert (await call("call_graph", entry=f1))["truncated"] is False  # the bounds are per request
    run(go())


def test_call_graph_cancel_and_listing_stays_responsive(sc, tmp_path, monkeypatch):
    entered = threading.Event()

    def endless(self, prog, f, scan):  # a traversal that takes as long as it is allowed to
        entered.set()
        while True:
            scan.check()
            time.sleep(0.01)

    async def go():
        async with inproc(tmp_path, monkeypatch) as (ctx, call):
            f1, f2 = await two_functions(call, tmp_path)
            with monkeypatch.context() as patch:
                patch.setattr(xrefs_mod.Xrefs, "_callees", endless)
                req = asyncio.create_task(call("call_graph", rid=9, entry=f1))
                assert await asyncio.to_thread(entered.wait, 5)
                for _ in range(5):
                    assert await asyncio.wait_for(call("listing_rows", address=f1, count=5), 1)  # R is free
                assert await asyncio.wait_for(call("undo_state"), 1) is not None
                assert await call("cancel_search", id=9) == {"cancelled": True}
                with pytest.raises(RpcError) as caught:
                    await asyncio.wait_for(req, 3)
                assert caught.value.code == CANCELLED
            assert (await call("call_graph", entry=f1))["truncated"] is False  # the scan lane is free again
    run(go())

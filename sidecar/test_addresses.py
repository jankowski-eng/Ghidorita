"""Round 8 addresses: a blob above 2^63 and an overlay block, every address-carrying method round-trips the exact unsigned/qualified
address; xrefs for decompiler globals and temporaries. In-process on a hand-built x86-64 program (see inproc.py)."""
import re

import pytest

from inproc import build

HI = 0xFFFFFFFF80000000
H = lambda o: "0x%x" % (HI + o)
# f @0: G += param_1 (rip-relative global at +0x100); t = g(); return t + (t + param_1)     g @0x40: return G
F = bytes.fromhex("488b05f900000048 01f8 488905ef000000 e82a000000 4801c7 488d0438 c3".replace(" ", ""))
G = bytes.fromhex("488b05b9000000 c3".replace(" ", ""))
HI_BLOB = F + bytes(0x40 - len(F)) + G + bytes(0x100 - 0x40 - len(G)) + bytes(8) + bytes(0xF8) + b"hello_high\0" + bytes(0x300 - 0x20b)
OVL = bytes.fromhex("e80b000000 c3".replace(" ", "")) + bytes(0xA) + bytes.fromhex("31c0c3") + bytes(0x30)  # h @OVL::1000 calls h2 @OVL::1010


def jobs(sc):
    from ghidrette.core.lanes import Job, Scan
    return Job(sc.ses.epoch), Scan(sc.ses.epoch)


@pytest.fixture(scope="module")
def prog(sc):
    from ghidra.program.model.data import PointerDataType, StringDataType
    from ghidra.program.model.symbol import RefType, SourceType
    from ghidra.app.cmd.data import CreateDataCmd
    p = build(sc, "t_hi", [("hi", HI, HI_BLOB, False), ("ovl", 0x1000, OVL, True)])
    ovl = next(b for b in p.getMemory().getBlocks() if b.isOverlay()).getStart()
    ovs = "%s::%x" % (ovl.getAddressSpace().getName(), ovl.getOffset())
    ov = lambda o: "%s::%x" % (ovl.getAddressSpace().getName(), 0x1000 + o)
    for a in (H(0), H(0x40), ov(0), ov(0x10)):  # create_function disassembles undefined bytes itself
        sc.create_function(a, None)
    sc.rename_symbol(H(0), "fn_f")
    sc.rename_symbol(H(0x40), "fn_g")
    sc.rename_symbol(H(0x100), "g_counter")  # disassembly already made a DAT_ label there
    sc.define_data(H(0x100), "qword")
    sc.edit("str", lambda pr: CreateDataCmd(sc.addr(H(0x200)), StringDataType.dataType).applyTo(pr))
    # references between the overlay and the default space, in both directions
    rm = p.getReferenceManager()
    sc.edit("refs", lambda pr: (rm.addMemoryReference(sc.addr(ov(0)), sc.addr(H(0x100)), RefType.DATA, SourceType.USER_DEFINED, 0),
                                rm.addMemoryReference(sc.addr(H(0x1d)), sc.addr(ov(0x10)), RefType.DATA, SourceType.USER_DEFINED, 0)))
    return p, ovs, ov


def test_listing_and_functions(sc, prog):
    p, ovs, ov = prog
    info = sc.listing_info()
    assert [r["start"] for r in info["ranges"]] and H(0) in [r["start"] for r in info["ranges"]] and ovs in [r["start"] for r in info["ranges"]]
    rows = sc.listing_rows(H(0), 10)
    assert rows[0]["address"] == H(0) and all(not r["address"].startswith("-") for r in rows)
    assert sc.listing_rows(ovs, 3)[0]["address"] == ovs
    fns = sc.list_functions()
    entries = [f["entry"] for f in fns]
    assert {H(0), H(0x40), ov(0), ov(0x10)} <= set(entries), entries
    assert not any(e.startswith("-") for e in entries)
    assert sc.get_function_at(H(0x1d))["entry"] == H(0)
    assert sc.get_function_at(ov(2))["entry"] == ov(0)  # a byte inside the overlay function
    assert sc.get_function_at(H(0x300 - 1)) is None


def test_xrefs_symbols_strings_search(sc, prog):
    p, ovs, ov = prog
    xs = sc.xrefs_to(H(0x100))
    frm = {(x["from"], x["kind"]) for x in xs}
    assert (H(0), "read") in frm and (H(0xa), "write") in frm and (H(0x40), "read") in frm, frm
    assert any(x["from"] == ov(0) for x in xs)  # overlay -> default space
    assert all(not x["from"].startswith("-") for x in xs) and any(x.get("function") == "fn_f" for x in xs)
    assert any(x["from"] == H(0x1d) for x in sc.xrefs_to(ov(0x10)))  # default space -> overlay
    assert any(r["to"] == H(0x40) and r["kind"] == "call" for r in sc.xrefs_from(H(0x11)))
    assert any(r["to"] == ov(0x10) for r in sc.xrefs_from(H(0x1d)))
    assert any(r["to"] == H(0x100) for r in sc.xrefs_from(ov(0)))
    _, scan = jobs(sc)
    syms = {s["name"]: s["address"] for s in sc.list_symbols(limit=200, scan=scan)["items"]}
    assert syms["fn_f"] == H(0) and syms["g_counter"] == H(0x100)
    assert any(a == ov(0) for a in syms.values())
    assert any(s["address"] == H(0x40) for s in sc.search_symbols("fn_g", scan=jobs(sc)[1]))
    st = sc.list_strings(minLength=4, scan=jobs(sc)[1])
    assert any(i["address"] == H(0x200) and i["value"] == "hello_high" for i in st["items"]), st
    m = sc.search_memory("hello_high", kind="text", scan=jobs(sc)[1])
    assert [i["address"] for i in m["items"]] == [H(0x200)] and m["next"] is None
    m = sc.search_memory("31 c0 c3", scan=jobs(sc)[1])  # in the overlay
    assert [i["address"] for i in m["items"]] == [ov(0x10)]
    m = sc.search_memory("48 8b 05", start=H(0x10), scan=jobs(sc)[1])  # resumes at an unsigned start above 2^63
    assert [i["address"] for i in m["items"]] == [H(0x40)]


def test_decompiler_tokens_globals_and_temporaries(sc, prog):
    p, ovs, ov = prog
    job, _ = jobs(sc)
    r = sc.decompile(H(0), job=job)
    toks = r["tokens"]
    assert toks and all(not t.get("address", "0x0").startswith("-") for t in toks), r["text"]
    assert any(t.get("address") == H(0) or t.get("address", "").startswith("0xffffffff8000") for t in toks)
    g = [t for t in toks if t.get("varAddress")]
    assert g and {t["varAddress"] for t in g} == {H(0x100)}, (r["text"], toks)
    assert {t["varName"] for t in toks if t.get("varName") == "g_counter"} == {"g_counter"} and all(t.get("varAddress") for t in toks if t.get("varName") == "g_counter")  # also the target of a store
    assert all(t["kind"] in ("variable", "param") for t in g)
    # xrefs on the global's address: what X does on that token
    assert {x["from"] for x in sc.xrefs_to(g[0]["varAddress"])} >= {H(0), H(0xa), H(0x40)}
    # a decompiler temporary has no program variable, but uses
    temps = sorted({t["varName"] for t in toks if t.get("varName") and re.fullmatch(r"[a-z]Var\d+", t["varName"])})
    assert temps, r["text"]
    for name in temps:
        assert sc.xrefs_to_variable(H(0), name) == []
        uses = sc.variable_uses(H(0), name, job=jobs(sc)[0])
        assert all(not u["from"].startswith("-") and u["function"] == "fn_f" for u in uses)
        assert [u["from"] for u in uses] == sorted((u["from"] for u in uses), key=lambda a: int(a, 16))
        if name == "lVar1":  # lVar1 = fn_g() at +0x11 (the call defines it), read by the multiply at +0x16
            assert [(u["from"], u["kind"], u["type"]) for u in uses] == [(H(0x11), "write", "CALL"), (H(0x16), "read", "INT_MULT")], uses
    assert "lVar1" in temps and "g_counter" not in temps
    # the cache: a second variable of the same function is a hit, an edit in the function clears it
    assert sc.decompile(H(0), job=jobs(sc)[0])["cached"] is True
    assert sc.variable_uses(H(0), "no_such", job=jobs(sc)[0]) == []
    with pytest.raises(Exception):
        sc.variable_uses(H(0x10), "x", job=jobs(sc)[0])  # not a function entry


def test_overlay_function_decompiles(sc, prog):
    p, ovs, ov = prog
    r = sc.decompile(ov(0), job=jobs(sc)[0])
    assert r["text"] and all(":" in t["address"] or t["address"].startswith("0x") for t in r["tokens"] if t.get("address"))
    assert sc.decompile(ov(0), job=jobs(sc)[0])["cached"] is True
    sc.set_comment(ov(0), "pre", "edited")  # a change in the overlay clears only what it covers
    assert sc.decompile(ov(0), job=jobs(sc)[0])["cached"] is False


# ---- the same through the real raw-blob import path and the WebSocket protocol ----
def test_raw_blob_above_2_63_over_the_wire(tmp_path):
    import asyncio
    from testlib import Client, Proc, run
    raw = tmp_path / "hi.bin"
    raw.write_bytes(HI_BLOB)
    proc = Proc(tmp_path / "projects")
    try:
        async def go():
            async with Client(proc.port) as c:
                await c.ok("open_binary", path=str(raw), loader="Raw Binary", language="x86:LE:64:default", baseAddress=H(0))
                info = await c.ok("listing_info")
                assert info["ranges"] == [{"start": H(0), "size": len(HI_BLOB)}]
                rows = await c.ok("listing_rows", address=H(0x2FF), count=5)
                assert [r["address"] for r in rows] == [H(0x2FF)]  # the last byte, no wrap past 2^64 or into negative addresses
                assert (await c.ok("listing_rows", address=H(0), count=1))[0]["address"] == H(0)
                for a, n in ((H(0), "fn_f"), (H(0x40), "fn_g")):
                    await c.ok("create_function", address=a, name=n)
                assert [f["entry"] for f in await c.ok("list_functions")] == [H(0), H(0x40)]
                assert (await c.ok("get_function_at", address=H(0x1d)))["entry"] == H(0)
                xs = await c.ok("xrefs_to", address=H(0x100))
                assert {H(0), H(0xa), H(0x40)} <= {x["from"] for x in xs}
                assert [i["address"] for i in (await c.ok("search_memory", pattern="hello_high", kind="text"))["items"]] == [H(0x200)]
                r = await c.ok("decompile", entry=H(0))
                assert {t["varAddress"] for t in r["tokens"] if t.get("varAddress")} == {H(0x100)}
                assert not any(t.get("address", "").startswith("-") for t in r["tokens"])
                temp = next(t["varName"] for t in r["tokens"] if t.get("varName", "").endswith("Var1"))
                uses = await c.ok("variable_uses", entry=H(0), name=temp)
                assert {u["kind"] for u in uses} == {"write", "read"} and all(u["from"].startswith("0xffffffff8000") for u in uses)
                # cancel right after sending: either the cancel won (Cancelled, nothing cached) or the answer was already on its way; never a hang, and a later call is right
                await c.ok("undo_state")
                rid = await c.send("variable_uses", entry=H(0x40), name="x")
                cancelled = await c.ok("cancel_decompile", id=rid)
                r2 = await c.reply(rid)
                assert ("error" in r2 and r2["error"]["code"] == -32002 and cancelled["cancelled"]) or "result" in r2, r2
                assert await c.ok("variable_uses", entry=H(0), name=temp) == uses
                await c.err("variable_uses", -32004, entry=H(5), name=temp)  # NotFound: not a function entry
                await c.err("listing_rows", -32602, address="0x10000000000000000", count=1)  # 2^64: out of range
        run(go())
    finally:
        proc.stop()


def test_segmented_real_mode(sc):
    """x86 16-bit real mode (segmented default space): linear and seg:off forms name the same byte; a function and its xrefs round-trip."""
    from inproc import INVALID
    from ghidrette.core.errors import RpcError
    code = bytes.fromhex("e80300c3") + bytes([0x90] * 2) + bytes.fromhex("b80100c3")  # call +3 (-> 0x6); ret; 2 nops; mov ax,1; ret
    p = build(sc, "t_seg", [("code", 0x10000, code, False)], lang="x86:LE:16:Real Mode")
    f = sc.fmtr(p)
    assert f(sc.addr("1000:0004")) == f(sc.addr("0x10004")) == "0x10004"
    assert f(sc.addr("0x10004")) == "0x10004"
    for bad in ("zz:0004", "1000:", "12345:0004"):
        with pytest.raises(RpcError) as e:
            sc.addr(bad)
        assert e.value.code == INVALID
    sc.create_function("1000:0000", "seg_main")
    fn = sc.list_functions()
    assert [x["name"] for x in fn] == ["seg_main"] and fn[0]["entry"] == "0x10000"
    assert sc.get_function_at("1000:0002")["entry"] == "0x10000"
    assert sc.listing_rows("1000:0000", 1)[0]["address"] == "0x10000"
    assert any(r["to"] == "0x10006" for r in sc.xrefs_from("0x10000")), sc.xrefs_from("0x10000")
    assert [x["from"] for x in sc.xrefs_to("1000:0006")] == ["0x10000"]


def test_aarch64_blob_above_2_63(sc):
    """AArch64 code at 0xffffffff80000000: bl +0x10; ret; ... ; mov w0,#1; ret. Function, xrefs, decompile addresses."""
    code = bytes.fromhex("04000094c0035fd6") + bytes(8) + bytes.fromhex("20008052c0035fd6") + bytes(0x30)
    p = build(sc, "t_a64", [("hi", HI, code, False)], lang="AARCH64:LE:64:v8A")
    sc.create_function(H(0), "a64_main")
    sc.create_function(H(0x10), "a64_leaf")
    assert [f["entry"] for f in sc.list_functions()] == [H(0), H(0x10)]
    assert [x["from"] for x in sc.xrefs_to(H(0x10))] == [H(0)] and sc.xrefs_to(H(0x10))[0]["kind"] == "call"
    assert sc.get_function_at(H(0x14))["entry"] == H(0x10)
    r = sc.decompile(H(0), job=jobs(sc)[0])
    assert r["tokens"] and not any(t.get("address", "").startswith("-") for t in r["tokens"])
    assert any(t.get("targetFunction") == H(0x10) for t in r["tokens"]), r["text"]

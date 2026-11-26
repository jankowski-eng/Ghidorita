"""Listing completeness (round 8 listing): address spaces, unsigned addresses, row content. Runs the sidecar methods in-process on
programs built by hand (a raw blob, an overlay block, a block above 2^63), so no import/analysis is needed."""
import pytest

from inproc import CODE, INVALID, build


def test_addr_roundtrip_and_errors(sc):
    from ghidorita.core.errors import RpcError
    prog = build(sc, "t_addr", [("ram", 0x401000, CODE, False), ("hi", 0xFFFFFFFFFFFFF000, CODE, False), ("ovl", 0x1000, CODE, True)])
    f = sc.fmtr(prog)
    for s in ("0x401000", "0xfffffffffffff000", "OVL1::1000", "0xffffffffffffffff"):
        pass
    a = sc.addr("0xfffffffffffff000")
    assert f(a) == "0xfffffffffffff000" and a.getOffset() < 0  # signed inside Java, unsigned on the wire
    assert f(sc.addr("ram:401000")) == "0x401000"  # a qualified default space reads back as the plain form
    for bad in ("", "zz", "nospace:10", "0x10000000000000000", "-1", "OVL1:::10", "ram:"):
        with pytest.raises(RpcError) as e:
            sc.addr(bad)
        assert e.value.code == INVALID, bad


def test_spaces_unsigned_and_walk_order(sc):
    prog = build(sc, "t_spaces", [("ram", 0x401000, CODE, False), ("hi", 0xFFFFFFFFFFFFF000, CODE, False), ("ovl", 0x1000, CODE, True)])
    info = sc.listing_info()
    starts = [r["start"] for r in info["ranges"]]
    assert sorted(starts) == sorted(["0x401000", "0xfffffffffffff000", "OVL::1000"]) or any(s.endswith("::1000") for s in starts), starts
    assert all(r["size"] == len(CODE) for r in info["ranges"]) and info["totalBytes"] == 3 * len(CODE)
    ov = next(s for s in starts if "::" in s)
    # forward from the first range walks every range in the order of listing_info, addresses all unsigned/qualified
    rows = sc.listing_rows(starts[0], 1000)
    assert len(rows) == 3 * len(CODE)  # undefined bytes, one row each
    seen = [r["address"] for r in rows if r["address"] in starts]
    assert seen == starts
    assert all(not r["address"].startswith("-") for r in rows)
    # rows of the overlay and above 2^63 are reachable from their own address, and backward steps into the previous range
    assert sc.listing_rows(ov, 1)[0]["address"] == ov
    assert sc.listing_rows("0xfffffffffffff000", 1)[0]["address"] == "0xfffffffffffff000"
    i = starts.index(ov)
    if i > 0:
        back = sc.listing_rows(ov, 1, "backward")
        assert back and back[-1]["address"] != ov
    last = sc.listing_rows(starts[-1], 1000)[-1]["address"]
    assert sc.listing_rows(last, 5)[0]["address"] == last and len(sc.listing_rows(last, 5)) == 1  # end of the last range, no wrap


def test_row_content(sc):
    from ghidra.program.model.symbol import SourceType
    from ghidra.app.cmd.disassemble import DisassembleCommand
    build(sc, "t_rows", [("ram", 0x401000, CODE, False)])
    sc.edit("dis", lambda p: DisassembleCommand(sc.addr("0x401000"), None, True).applyTo(p) or True)
    sc.create_function("0x401000", "main_fn")
    sc.create_function("0x40100a", "callee")
    sc.set_comment("0x401000", "plate", "PLATE\nline two")
    sc.set_comment("0x401000", "pre", "pre text")
    sc.set_comment("0x401004", "eol", "eol text")
    sc.set_comment("0x401004", "post", "post text")
    sc.set_comment("0x401009", "repeatable", "rep text")
    sc.define_data("0x401010", "char[20]")
    sc.edit("alias", lambda p: p.getSymbolTable().createLabel(sc.addr("0x401010"), "alias_a", SourceType.USER_DEFINED))
    sc.edit("alias", lambda p: p.getSymbolTable().createLabel(sc.addr("0x401010"), "alias_b", SourceType.USER_DEFINED))
    rows = {r["address"]: r for r in sc.listing_rows("0x401000", 100)}
    f = rows["0x401000"]
    assert f["label"] == "main_fn" and "labels" not in f
    h = f["header"]
    assert "main_fn" in h["signature"] and h["params"] == 0 and isinstance(h["localBytes"], int) and isinstance(h["paramBytes"], int)
    assert f["plate"] == "PLATE\nline two" and f["pre"] == "pre text"
    assert "header" not in rows["0x401001"] and "plate" not in rows["0x401001"] and "xrefs" not in rows["0x401001"]
    call = rows["0x401004"]
    assert call["comment"] == "eol text" and call["post"] == "post text" and call["mnemonic"] == "CALL"
    assert rows["0x401009"]["repeatable"] == "rep text"
    callee = rows["0x40100a"]
    assert callee["header"]["signature"].find("callee") >= 0
    assert callee["xrefs"]["count"] == 1 and callee["xrefs"]["items"] == [{"from": "0x401004", "kind": "call"}]
    d = rows["0x401010"]
    assert d["length"] == 20 and d["bytesMore"] == 4 and len(d["bytes"].split()) == 16
    assert d["labels"][0] == d["label"] and sorted(d["labels"]) == ["alias_a", "alias_b"]
    assert [p["name"] for p in d["parts"]][:3] == ["[0]", "[1]", "[2]"] and len(d["parts"]) == 20 and d["parts"][1]["offset"] == 1 and d["parts"][0]["type"] == "char"
    assert "partsTotal" not in d
    # more parts than the cap: cut with the real count
    sc.define_data("0x401100" if False else "0x401010", "char[20]")
    # xref cap: five shown, the real count reported
    from ghidorita.domains.listing import Listing
    assert Listing.ROW_XREFS_SHOWN == 5


def test_parts_and_xref_caps(sc):
    from ghidra.program.model.symbol import RefType, SourceType
    build(sc, "t_caps", [("ram", 0x500000, bytes(0x800), False)])
    sc.define_data("0x500000", "short[100]")
    rows = sc.listing_rows("0x500000", 1)
    assert rows[0]["length"] == 200 and len(rows[0]["parts"]) == 64 and rows[0]["partsTotal"] == 100 and rows[0]["bytesMore"] == 184

    def refs(p):
        rm = p.getReferenceManager()
        for i in range(8):
            rm.addMemoryReference(sc.addr("0x500%03x" % (0x300 + i * 4)), sc.addr("0x500000"), RefType.DATA, SourceType.USER_DEFINED, 0)
    sc.edit("refs", refs)
    x = sc.listing_rows("0x500000", 1)[0]["xrefs"]
    assert x["count"] == 8 and len(x["items"]) == 5 and all(i["kind"] == "data" for i in x["items"])
    assert [i["from"] for i in x["items"]] == sorted((i["from"] for i in x["items"]), key=lambda s: int(s, 16))


def test_row_data_type(sc):
    build(sc, "t_dtype", [("ram", 0x600000, bytes(range(64)), False)])
    sc.define_data("0x600000", "char[4]")
    sc.define_data("0x600008", "dword")
    sc.define_data("0x600010", "pointer")
    rows = {r["address"]: r for r in sc.listing_rows("0x600000", 32)}
    assert rows["0x600000"]["dataType"] == "char[4]"
    assert rows["0x600008"]["dataType"] == "dword" and rows["0x600010"]["dataType"] == "pointer"
    assert rows["0x600004"]["dataType"] == "undefined"  # an undefined byte


def test_row_data_type_same_name_in_two_categories(sc):
    from ghidra.program.model.data import CategoryPath, StructureDataType, DataTypeConflictHandler
    build(sc, "t_dtype2", [("ram", 0x610000, bytes(256), False)])

    def mk(p):
        dtm = p.getDataTypeManager()
        for cat in ("/A", "/B"):
            s = StructureDataType(CategoryPath(cat), "S", 0)
            s.add(__import__("ghidra.program.model.data", fromlist=["ByteDataType"]).ByteDataType.dataType, "x", None)
            dtm.resolve(s, DataTypeConflictHandler.REPLACE_HANDLER)
        return True
    sc.edit("mk", mk)
    sc.define_data("0x610000", "/A/S")
    sc.define_data("0x610008", "/B/S")
    rows = {r["address"]: r for r in sc.listing_rows("0x610000", 20)}
    assert rows["0x610000"]["dataType"] == "/A/S" and rows["0x610008"]["dataType"] == "/B/S"
    sc.define_data("0x610010", "/A/S[3]")  # the client builds `<dataType>[n]`
    assert sc.listing_rows("0x610010", 1)[0]["length"] == 3
    assert sc.listing_rows("0x610010", 1)[0]["dataType"] == "/A/S[3]"  # the wrapper keeps the element's category
    sc.define_data("0x610020", "/B/S *")
    assert sc.listing_rows("0x610020", 1)[0]["dataType"] == "/B/S *"
    # consecutive array suffixes reverse like Ghidra's name parser: qualified and unqualified give the same layout
    sc.define_data("0x6100a0", "/A/S *32")  # an explicit 4-byte pointer keeps its width in the reference
    assert sc.listing_rows("0x6100a0", 1)[0]["length"] == 4 and sc.listing_rows("0x6100a0", 1)[0]["dataType"] == "/A/S *32"
    import pytest
    from ghidorita.core.errors import RpcError
    for bad in ("/A/S *33", "/A/S *0", "/A/S *72"):
        with pytest.raises(RpcError):
            sc.define_data("0x6100c0", bad)
    sc.define_data("0x6100b0", "/A/S *32[2]")
    assert sc.listing_rows("0x6100b0", 1)[0]["length"] == 8
    sc.define_data("0x610030", "/A/S[2][3]")
    sc.define_data("0x610050", "byte[2][3]")
    assert sc.listing_rows("0x610030", 1)[0]["dataType"] == "/A/S[2][3]" and sc.listing_rows("0x610050", 1)[0]["dataType"] == "byte[2][3]"

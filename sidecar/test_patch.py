"""Patching one instruction (capability `patch`), in-process on a hand-built x86-64 program: assemble, write, disassembly, original bytes, undo."""
import pytest

from inproc import CODE, INVALID, build


def prog(sc, name):
    from ghidra.app.cmd.disassemble import DisassembleCommand
    p = build(sc, name, [("ram", 0x401000, CODE, False)])
    sc.edit("dis", lambda q: DisassembleCommand(sc.addr("0x401000"), None, True).applyTo(q) or True)
    sc.ses.undo_snap  # the setup edit stays on the undo stack; the tests undo only their own patch
    return p


def scan(sc):
    from ghidorita.core.lanes import Scan
    return Scan(sc.ses.epoch)


def mnemonics(sc):
    return [r["mnemonic"] for r in sc.listing_rows("0x401000", 5)[:4]]


def test_nop_patch_assembles_writes_disassembles_and_undoes(sc):
    prog(sc, "t_patch_nop")
    assert mnemonics(sc)[0] == "PUSH"
    a = sc.assemble_instruction("0x401000", "NOP", scan=scan(sc))
    assert a == {"address": "0x401000", "bytes": "90", "length": 1, "oldBytes": "55", "oldLength": 1, "overwrites": 0}
    assert sc.get_bytes("0x401000", 1)["bytes"] == "55"  # assembling writes nothing
    assert sc.list_patches() == []
    r = sc.patch_instruction("0x401000", a["bytes"])
    assert r == {"address": "0x401000", "length": 1, "replaced": 1, "overwritten": 0}
    assert sc.get_bytes("0x401000", 4)["bytes"] == "90 48 89 e5"
    assert sc.listing_rows("0x401000", 1)[0]["mnemonic"] == "NOP" and sc.listing_rows("0x401001", 1)[0]["mnemonic"] == "MOV"
    assert sc.list_patches() == [{"address": "0x401000", "length": 1, "original": "55", "current": "90"}]
    assert sc.undo_state()["undoName"] == "Patch instruction at 0x401000"
    sc.undo()
    assert sc.get_bytes("0x401000", 1)["bytes"] == "55" and sc.listing_rows("0x401000", 1)[0]["mnemonic"] == "PUSH"
    assert sc.list_patches() == []
    sc.redo()
    assert sc.get_bytes("0x401000", 1)["bytes"] == "90" and sc.list_patches()[0]["original"] == "55"
    # patching the same byte again keeps the first original; patching back to it drops the mark
    sc.patch_instruction("0x401000", "cc")
    assert sc.list_patches() == [{"address": "0x401000", "length": 1, "original": "55", "current": "cc"}]
    sc.patch_instruction("0x401000", "55")
    assert sc.list_patches() == []


def test_longer_bytes_need_an_explicit_overwrite_and_it_is_counted(sc):
    from ghidorita.core.errors import RpcError
    prog(sc, "t_patch_long")
    a = sc.assemble_instruction("0x401001", "MOV EAX,0x12345678", scan=scan(sc))  # 5 bytes over the 3-byte MOV, eating the CALL at 0x401004
    assert a["bytes"] == "b8 78 56 34 12" and a["oldLength"] == 3 and a["oldBytes"] == "48 89 e5" and a["overwrites"] == 1
    with pytest.raises(RpcError) as e:
        sc.patch_instruction("0x401001", a["bytes"])
    assert e.value.code == INVALID and "overwriteFollowing" in str(e.value) and sc.get_bytes("0x401001", 5)["bytes"] == "48 89 e5 e8 01"
    r = sc.patch_instruction("0x401001", a["bytes"], overwriteFollowing=True)
    assert r["overwritten"] == 1 and r["replaced"] == 3 and r["length"] == 5
    assert sc.get_bytes("0x401001", 5)["bytes"] == a["bytes"]
    rows = sc.listing_rows("0x401001", 3)
    assert rows[0]["mnemonic"] == "MOV" and rows[0]["length"] == 5 and rows[1]["address"] == "0x401006"  # the CALL is gone, what is left of it disassembles from there
    sc.undo()
    assert sc.get_bytes("0x401001", 8)["bytes"] == "48 89 e5 e8 01 00 00 00" and sc.listing_rows("0x401004", 1)[0]["mnemonic"] == "CALL"


def test_errors_and_busy(sc):
    from ghidorita.core.errors import BUSY, RpcError
    prog(sc, "t_patch_err")
    with pytest.raises(RpcError) as e:
        sc.assemble_instruction("0x401000", "FROB RAX,RBX", scan=scan(sc))
    assert e.value.code == INVALID and "FROB" in str(e.value)
    for bad in ("0x401002",):  # inside the 3-byte MOV
        with pytest.raises(RpcError) as e:
            sc.assemble_instruction(bad, "NOP", scan=scan(sc))
        assert e.value.code == INVALID
    for bad in ("", "zz", "90 9", "90 " * 17):
        with pytest.raises(RpcError) as e:
            sc.patch_instruction("0x401000", bad)
        assert e.value.code == INVALID, bad
    with pytest.raises(RpcError) as e:
        sc.patch_instruction("0x500000", "90")
    assert e.value.code == INVALID
    sc.ses.analyzing = True
    try:
        with pytest.raises(RpcError) as e:
            sc.patch_instruction("0x401000", "90")
        assert e.value.code == BUSY
    finally:
        sc.ses.analyzing = False
    assert sc.get_bytes("0x401000", 1)["bytes"] == "55"

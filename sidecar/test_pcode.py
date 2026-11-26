"""P-code of one function (capability `pcode`) and, below, the value trail (`valueTrail`): in-process on a small hand-built x86-64 program.
f @0x401000: RCX += 5; g(RCX); return        g @0x40100a: RAX = RCX; return"""
import pytest

from inproc import build

F = bytes.fromhex("488d4905" "e801000000" "c3" "4889c8" "c3".replace(" ", ""))  # lea rcx,[rcx+5]; call +1 (g); ret; mov rax,rcx; ret
CODE = F + bytes(0x40 - len(F))
G = 0x401000 + 4 + 5 + 1  # lea(4) + call(5) + ret(1)


@pytest.fixture(scope="module")
def prog(sc):
    p = build(sc, "t_pcode", [("ram", 0x401000, CODE, False)])
    for a in ("0x401000", "0x%x" % G):
        sc.create_function(a, None)
    sc.rename_symbol("0x401000", "fn_f")
    sc.rename_symbol("0x%x" % G, "fn_g")
    sc.set_function_signature("0x%x" % G, "long fn_g(long a)")
    sc.set_function_signature("0x401000", "long fn_f(long x)")
    return p


def jobs(sc):
    from ghidorita.core.lanes import Job
    return Job(sc.ses.epoch)


def test_raw_pcode_of_a_known_instruction_and_high_pcode_inside_the_function(sc, prog):
    r = sc.pcode("0x401000", job=jobs(sc))
    assert r["truncated"] is False
    by = {x["address"]: x for x in r["raw"]}
    assert list(by) == ["0x401000", "0x401004", "0x401009"], list(by)  # one entry per instruction, keyed by its address
    lea = by["0x401000"]
    assert lea["asm"] == "LEA RCX,[RCX + 0x5]"
    assert any("INT_ADD" in o and "RCX" in o and "0x5" in o for o in lea["ops"]), lea["ops"]
    assert any(o.startswith("RCX = ") for o in lea["ops"]), lea["ops"]
    assert any(o.startswith("CALL ") for o in by["0x401004"]["ops"]) and any(o.startswith("RETURN ") for o in by["0x401009"]["ops"])
    f = sc.get_function_at("0x401000")
    lo, hi = 0x401000, 0x401000 + f["size"] - 1
    assert r["high"] and all(lo <= int(o["address"], 16) <= hi for o in r["high"]), r["high"]
    assert any("CALL " in o["text"] and o["address"] == "0x401004" for o in r["high"]), r["high"]
    assert any("INT_ADD" in o["text"] for o in r["high"])
    assert [o["block"] for o in r["high"]] == sorted(o["block"] for o in r["high"])
    assert sc.pcode("0x401000", job=jobs(sc)) == r  # the second one is served from the decompile cache (its own entry, like function_graph)


def test_pcode_errors(sc, prog):
    from ghidorita.core.errors import NOT_FOUND, RpcError
    with pytest.raises(RpcError) as e:
        sc.pcode("0x401002", job=jobs(sc))
    assert e.value.code == NOT_FOUND

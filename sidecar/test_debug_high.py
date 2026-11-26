"""The debugger above 2^63 and its stepping rules, in-process (inproc.py) on a hand-built x86-64 program at 0xffffffff80000000 with a fake gdb
(no QEMU): values and typed memory at high addresses, a statement step over a call, a signal that is not the step's trap."""
import threading

import pytest

from inproc import build
from test_addresses import H, HI, HI_BLOB

RIP, RSP = 0, 1


class FakeG:
    """What Debug needs of a Gdb: registers 0 (pc) and 1 (sp), memory, and a resume that replays the pcs and stop replies it was given."""
    def __init__(self, mem, stops, sp=0x7FFF0000):
        self.mem, self.stops, self.i, self.sp, self.log = mem, list(stops), 0, sp, []
        self.closed = self.running = False
        self.ctl = threading.Lock()
        self.sync = None

    def request(self, p, timeout=5.0):
        self.log.append(p)
        if p[0] == "p":
            n = int(p[1:], 16)
            return (self.stops[self.i][0] if n == RIP else self.sp).to_bytes(8, "little").hex()
        if p[0] == "m":
            a, n = (int(x, 16) for x in p[1:].split(","))
            if a < 0 or a + n > 1 << 64:
                return "E14"
            return bytes(self.mem.get(a + k, 0) for k in range(n)).hex()
        return "OK"

    def resume(self, payload, wait=False, timeout=5.0, before=None):
        if before is not None and not before():
            return "T02"  # vetoed: nothing is sent
        self.log.append(payload)
        self.i = min(self.i + 1, len(self.stops) - 1)
        return self.stops[self.i][1]

    def interrupt(self):
        pass

    def close(self, polite=True):
        self.closed = True


@pytest.fixture(scope="module")
def dbg(sc):
    p = build(sc, "t_hi_dbg", [("hi", HI, HI_BLOB, False)])
    for a in (H(0), H(0x40)):
        sc.create_function(a, None)
    sc.rename_symbol(H(0x100), "g_counter")
    sc.define_data(H(0x100), "qword")
    d = next(x for x in sc.app.domains if type(x).__name__ == "Debug")
    d.regs, d.names, d.pc, d.sp, d.big = [("RIP", RIP, 64), ("RSP", RSP, 64)], {RIP: "RIP", RSP: "RSP"}, "RIP", "RSP", False
    return d


def attach(dbg, sc, g, pc):
    dbg.g, dbg.sid, dbg.offset = g, sc.ses.session_id, 0
    dbg.state, dbg.address, dbg.deferred, dbg.signal = "stopped", pc, [], None
    dbg.registers = [{"name": "RIP", "value": "0x%016x" % pc}, {"name": "RSP", "value": "0x%016x" % g.sp}]
    dbg.stops += 1


def test_values_and_typed_memory_above_2_63(sc, dbg):
    from ghidrette.core.lanes import Scan
    mem = {HI + 0x100 + k: b for k, b in enumerate(bytes.fromhex("8877665544332211"))}  # little endian 0x1122334455667788
    attach(dbg, sc, FakeG(mem, [(HI, "T05")]), HI)
    v = dbg.debug_values(H(0), scan=Scan(sc.ses.epoch))
    g = next(i for i in v["items"] if i["kind"] == "global")
    assert g["where"] == H(0x100) and g["raw"] == "0x1122334455667788", v  # the global's offset is negative as a Java long: read at the unsigned address
    m = dbg.debug_memory(H(0x100), dataType="qword")
    assert m["address"] == H(0x100) and m["items"][0]["value"] == str(0x1122334455667788), m  # the type is applied at an address a Java long cannot hold


def test_statement_step_runs_over_a_call_at_a_high_pc(sc, dbg):
    # F: 0 mov, 7 add, 0xa mov, 0x11 call g (@0x40), 0x16 add, 0x19 lea, 0x1d ret. Replies: after each step or continue the next pc.
    stops = [(HI, "T05"), (HI + 7, "T05"), (HI + 0xA, "T05"), (HI + 0x11, "T05"), (HI + 0x40, "T05"), (HI + 0x16, "T05"), (HI + 0x19, "T05")]
    g = FakeG({}, stops)
    attach(dbg, sc, g, HI)
    dbg.cancel.clear()
    dbg.worker = True
    dbg._statement(g, HI, {HI + 0x19}, "statement")
    assert dbg.state == "stopped" and dbg.address == HI + 0x19 and not g.closed, (dbg.state, hex(dbg.address or 0), g.log)
    assert "c" in g.log and any(p.startswith("Z0,") and p.split(",")[1] == "%x" % (HI + 0x16) for p in g.log), g.log  # the call was run over with a breakpoint after it
    assert dbg.signal is None


def test_a_signal_other_than_the_trap_stops_the_step_and_is_reported(sc, dbg):
    stops = [(HI, "T05"), (HI + 7, "T0b")]  # SIGSEGV after the first step
    g = FakeG({}, stops)
    attach(dbg, sc, g, HI)
    dbg.cancel.clear()
    dbg.worker = True
    dbg._statement(g, HI, {HI + 0x19}, "statement")
    assert dbg.state == "stopped" and dbg.address == HI + 7 and dbg.signal == 11, (dbg.state, dbg.signal)
    assert dbg.snapshot()["signal"] == 11


def test_a_pause_before_the_resume_is_not_lost(sc, dbg):
    g = FakeG({}, [(HI, "T05"), (HI + 7, "T05"), (HI + 0xA, "T05")])
    attach(dbg, sc, g, HI)
    dbg.cancel.set()  # F6 arrived between two instructions: no interrupt can be sent (nothing runs), the next resume must not start
    dbg.worker = True
    dbg._statement(g, HI, {HI + 0x19}, "statement")
    assert g.log.count("s") == 0 and dbg.state == "stopped" and dbg.address == HI, g.log

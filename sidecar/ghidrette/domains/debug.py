"""Debugger: attaches to a GDB Remote Serial Protocol server (QEMU's gdbstub) with core/gdb.py. Protocol: protocol.md "Debugger".

- the program's addresses are the runtime addresses minus `offset` (0 for now: a raw image loaded at the base it runs at); breakpoints,
  the stop address and the registers' pc go through it, register values stay runtime values;
- register names come from the program's language (Ghidra), the gdb numbers from the target's target.xml; a target register the language
  does not know is not listed;
- a stop reply arrives on the gdb reader thread; a worker thread reads the registers and publishes `debug_state`. The state is per
  program session: a different session drops the connection.
Every RPC is on thread R (it needs the language); none waits for the target to run."""
import threading

from ..core.errors import BUSY, INVALID, TARGET, RpcError, log
from ..core.gdb import Gdb, GdbError
from ..core.rpc import rpc

# gdb architecture name -> Ghidra processor, for the "unknown architecture" check (an architecture missing here is only checked by its pc)
PROCESSORS = {"arm": "ARM", "aarch64": "AARCH64", "riscv": "RISCV", "i386": "x86", "mips": "MIPS", "powerpc": "PowerPC", "xtensa": "Xtensa", "m68k": "68000", "sparc": "sparc"}
ALIASES = {"xpsr": "cpsr"}  # a gdb register name Ghidra spells differently (Cortex-M's program status)
MAX_BITS = 128
MAX_STEPS, CALL_SECS, MAX_BOUNDARIES = 20000, 60, 5000  # a statement step gives up after this many instructions (it stops where it is)  # wider registers (vectors) are not shown


class Debug:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session
        self.lock = threading.RLock()
        self.g = None
        self.sid = None
        self.state, self.target, self.error = "detached", "", ""
        self.offset = 0
        self.cancel = threading.Event()  # pause during a statement step
        self.stops = 0  # stops announced since the process started: a client tells a new stop from a repeated state (a breakpoint toggled while stopped)
        self.address, self.registers, self.bps = None, [], []  # bps: program addresses (ints) in the order they were set
        self.regs, self.pc, self.big, self.bp_kind = [], None, False, 4
        ctx.shutdown_hooks.append(self.close)

    # ---- state ----
    def snapshot(self):
        st = {"state": self.state, "target": self.target, "offset": hex(self.offset), "stop": self.stops, "breakpoints": [hex(a) for a in self.bps]}
        if self.address is not None and self.state == "stopped":
            st["address"], st["registers"] = hex(self.address), self.registers
        if self.error:
            st["error"] = self.error
        return st

    def publish(self):
        self.ctx.notify("debug_state", {"sessionId": self.sid or self.ses.session_id, **self.snapshot()})

    def _drop(self, error=""):
        """Close the connection and become detached (published); breakpoints stay for the next attach."""
        with self.lock:
            g, self.g = self.g, None
            self.state, self.error, self.address, self.registers = "detached", error, None, []
        if g is not None:
            g.close(polite=False)
        self.publish()

    def _live(self):
        """The connection, or raise; a connection of another program session is closed first."""
        with self.lock:
            if self.g is not None and self.sid != self.ses.session_id:
                self._drop()
            if self.g is None:
                raise RpcError(TARGET, "Not attached to a target")
            return self.g

    def close(self):  # shutdown hook
        if self.g is not None:
            self._drop()

    # ---- gdb helpers ----
    def _req(self, g, payload):
        try:
            return g.request(payload)
        except GdbError as e:
            raise RpcError(TARGET, str(e))

    def _read_registers(self, g):
        out = []
        for name, num, bits in self.regs:
            r = self._req(g, "p%x" % num)
            if len(r) != bits // 4 or "x" in r:  # E.., empty or "xxxx" (unavailable)
                continue
            v = int.from_bytes(bytes.fromhex(r), "big" if self.big else "little")
            out.append({"name": self.names[num], "value": "0x%0*x" % (bits // 4, v)})
        return out

    def _stopped(self, g, packet):
        """Worker thread after a stop reply: registers, then publish."""
        try:
            if packet[0] in "WX":
                what = "exited with status %d" % int(packet[1:3], 16) if packet[0] == "W" else "was terminated by signal %d" % int(packet[1:3], 16)
                if self.g is g:
                    self._drop("The target %s" % what)
                return
            with self.lock:
                if self.g is not g:
                    return
                regs = self._read_registers(g)
                pc = next((int(r["value"], 16) for r in regs if r["name"] == self.pc), None)
                if pc is None:
                    raise RpcError(TARGET, "The target did not report its program counter")
                self.state, self.error, self.registers, self.address = "stopped", "", regs, pc - self.offset
                self.stops += 1
            self.publish()
        except RpcError as e:
            if self.g is g:
                self._drop(str(e))

    # ---- RPCs ----
    @rpc(lane="R")
    def debug_attach(self, host="localhost", port=1234):
        prog = self.ses.need()
        if not isinstance(host, str) or not host.strip() or isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
            raise RpcError(INVALID, "A host and a port from 1 to 65535 are needed")
        with self.lock:
            if self.g is not None:
                self._live()  # of another session: closed
            if self.g is not None:
                raise RpcError(BUSY, "Already attached to %s" % self.target)
            lang = prog.getLanguage()
            self.names = {}  # gdb register number -> the language's name
            try:
                g = Gdb(host.strip(), port, lambda p: threading.Thread(target=self._stopped, args=(g, p), daemon=True, name="debug-stop").start(), lambda: self._lost(g))
            except GdbError as e:
                raise RpcError(TARGET, str(e))
            try:
                sup = self._req(g, "qSupported:multiprocess+;swbreak+;hwbreak+")
                arch, regs = g.registers() if "qXfer:features:read+" in sup else ("", [])
                proc = str(lang.getProcessor())
                if not regs or (arch.split(":")[0] in PROCESSORS and PROCESSORS[arch.split(":")[0]] != proc):
                    raise RpcError(TARGET, "Unknown architecture: the target is %s, the program is %s" % (arch or "unknown", lang.getLanguageID()))
                known = {}
                for name, num, bits in regs:
                    r = lang.getRegister(name) or lang.getRegister(name.lower()) or lang.getRegister(name.upper()) or lang.getRegister(ALIASES.get(name, name))
                    if r is not None and bits <= MAX_BITS:
                        known[num] = (str(r.getName()), bits)
                pcreg = lang.getProgramCounter()
                pc = str(pcreg.getName()) if pcreg is not None else None
                if pc is None or pc not in [n for n, _ in known.values()]:
                    raise RpcError(TARGET, "Unknown architecture: the program counter of %s is not among the target's registers" % lang.getLanguageID())
                self.regs = [(name, num, bits) for name, num, bits in regs if num in known]
                self.names = {num: known[num][0] for num in known}
                self.pc, self.big = pc, bool(lang.isBigEndian())
                self.bp_kind = 2 if "Cortex" in str(lang.getLanguageID()) else 4
                stop = self._req(g, "?")
                if stop[:1] not in ("T", "S"):
                    raise RpcError(TARGET, "The target is not stopped (%s)" % (stop or "no reply"))
                self.g, self.sid, self.target, self.error = g, self.ses.session_id, "%s:%d" % (host.strip(), port), ""
                for a in self.bps:
                    self._z(g, "Z", a)
            except (RpcError, GdbError, ValueError) as e:
                g.close(polite=False)
                self.g = None
                raise e if isinstance(e, RpcError) else RpcError(TARGET, str(e))
            self.state = "running"  # _stopped publishes the first stop
            self._stopped(g, stop)
            return {}

    def _lost(self, g):
        if self.g is g:
            self._drop("Lost the connection to the target")

    def _z(self, g, op, addr):
        r = self._req(g, "%s0,%x,%d" % (op, addr + self.offset, self.bp_kind))
        if r != "OK":
            raise RpcError(TARGET, "The target refused the breakpoint at 0x%x" % addr)

    @rpc(lane="R")
    def debug_detach(self):
        with self.lock:
            g = self.g
            if g is not None:
                g.close(polite=True)
                self.g = None
                self.state, self.error, self.address, self.registers = "detached", "", None, []
                self.publish()
            return {}

    @rpc(lane="R")
    def debug_status(self):
        with self.lock:
            if self.g is not None and self.sid != self.ses.session_id:
                self._drop()
            return self.snapshot()

    @rpc(lane="R")
    def debug_breakpoint(self, address):
        """Toggle a breakpoint at the program address."""
        self.ses.need()
        try:
            a = int(address, 16) if isinstance(address, str) and address.lower().startswith("0x") else None
        except ValueError:
            a = None
        if a is None or a < 0:
            raise RpcError(INVALID, "A breakpoint needs an address like 0x1000")
        with self.lock:
            if self.g is not None:
                g = self._live()
                if self.state != "stopped":
                    raise RpcError(BUSY, "Pause the target before changing breakpoints")
                self._z(g, "z" if a in self.bps else "Z", a)
            (self.bps.remove if a in self.bps else self.bps.append)(a)
            self.publish()
            return {}

    def _single_step(self, g, pc):
        """One instruction, waited for, with a breakpoint at the pc taken out meanwhile (like gdb); returns the stop reply."""
        at = pc in self.bps
        if at:
            self._z(g, "z", pc)
        try:
            return g.resume("s", wait=True)
        finally:
            if at and not g.closed:
                self._z(g, "Z", pc)

    def _pc_of(self, g):
        r = self._req(g, "p%x" % next(n for n, name in self.names.items() if name == self.pc))
        return int.from_bytes(bytes.fromhex(r), "big" if self.big else "little") - self.offset

    @rpc(lane="R")
    def debug_step(self, mode="instruction", boundaries=None):
        """One instruction, or (mode "statement") up to the next of `boundaries` (program addresses where a statement of the pc's function
        starts, from the client's decompiler mapping); the stop arrives as debug_state."""
        if mode not in ("instruction", "statement"):
            raise RpcError(INVALID, "mode is instruction or statement")
        if mode == "statement":
            try:
                starts = {int(a, 16) for a in boundaries[:MAX_BOUNDARIES]} if isinstance(boundaries, list) and boundaries and all(isinstance(a, str) and a.lower().startswith("0x") for a in boundaries) else None
            except ValueError:
                starts = None
            if starts is None:
                raise RpcError(INVALID, "A statement step needs the statement start addresses (boundaries)")
        with self.lock:
            g = self._live()
            if self.state != "stopped":
                raise RpcError(BUSY, "The target is running")
            pc = self.address
            if mode == "statement":
                self.cancel.clear()
                self.state, self.address, self.registers, self.error = "running", None, [], ""
                self.publish()
                threading.Thread(target=self._statement, args=(g, pc, starts), daemon=True, name="debug-statement").start()
                return {}
            try:
                r = self._single_step(g, pc)
            except GdbError as e:
                if g.running:  # no stop reply yet (an instruction that waits): it will arrive on its own
                    self.state, self.address, self.registers = "running", None, []
                    self.publish()
                raise RpcError(TARGET, str(e))
            self._stopped(g, r)
            return {}

    def _statement(self, g, pc, starts):
        """Worker: instruction by instruction until the pc is at a statement start, a user breakpoint, outside the function (a call is run over
        to the instruction after it; a return stops in the caller), or pause. shortcut: the temporary breakpoint after a call also stops a
        recursive callee's return to the same address; upgrade: compare sp."""
        r = "T05"
        try:
            prog = self.ses.need()
            func = prog.getFunctionManager().getFunctionContaining(prog.getAddressFactory().getDefaultAddressSpace().getAddress(pc))
            body = func.getBody() if func is not None else None
            listing, space = prog.getListing(), prog.getAddressFactory().getDefaultAddressSpace()
            for _ in range(MAX_STEPS):
                ins = listing.getInstructionAt(space.getAddress(pc))
                r = self._single_step(g, pc)
                if r[0] in "WX" or self.cancel.is_set():
                    break
                npc = self._pc_of(g)
                if npc in self.bps or (body is not None and body.contains(space.getAddress(npc)) and npc in starts):
                    break
                if body is None or ins is None or body.contains(space.getAddress(npc)):
                    pc = npc
                    if body is None:
                        break
                    continue
                if not ins.getFlowType().isCall():  # left the function by a return or a jump: stop there
                    break
                after = ins.getFallThrough()
                if after is None:
                    break
                back, temp = after.getOffset(), after.getOffset() not in self.bps
                if temp:
                    self._z(g, "Z", back)
                try:
                    r = g.resume("c", wait=True, timeout=CALL_SECS)
                finally:
                    if temp and not g.closed:
                        self._z(g, "z", back)
                if r[0] in "WX" or self.cancel.is_set():
                    break
                pc = self._pc_of(g)
                if pc != back or pc in self.bps or pc in starts:  # a user breakpoint or pause inside the callee, or the next statement begins right after the call
                    break
            self._stopped(g, r)
        except (GdbError, RpcError) as e:
            if g.running:  # the stop will still arrive (on_stop) when the target stops
                return
            if self.g is g:
                self._drop(str(e))
        except Exception as e:  # noqa: a bug here must not leave the UI on "running"
            log("statement step failed:", repr(e))
            if self.g is g:
                self._drop("The statement step failed: %s" % e)

    @rpc(lane="R")
    def debug_continue(self):
        with self.lock:
            g = self._live()
            if self.state != "stopped":
                raise RpcError(BUSY, "The target is already running")
            try:
                if self.address in self.bps:  # off the breakpoint first, or it would hit again at once
                    r = self._single_step(g, self.address)
                    if r[0] in "WX" or self._pc_of(g) in self.bps:
                        self._stopped(g, r)
                        return {}
                g.resume("c")
            except GdbError as e:
                raise RpcError(TARGET, str(e))
            self.state, self.address, self.registers, self.error = "running", None, [], ""
            self.publish()
            return {}

    @rpc(lane="R")
    def debug_pause(self):
        with self.lock:
            g = self._live()
            if self.state != "running":
                raise RpcError(BUSY, "The target is not running")
            try:
                self.cancel.set()  # a statement step ends after its current instruction
                if g.running:
                    g.interrupt()
            except GdbError as e:
                raise RpcError(TARGET, str(e))
            return {}

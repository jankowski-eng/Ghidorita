"""Debugger: attaches to a GDB Remote Serial Protocol server (QEMU's gdbstub) with core/gdb.py. Protocol: protocol.md "Debugger".

- the program's addresses are the runtime addresses minus `offset` (0 for now: a raw image loaded at the base it runs at); breakpoints,
  the stop address and the registers' pc go through it, register values stay runtime values;
- register names come from the program's language (Ghidra), the gdb numbers from the target's target.xml; a target register the language
  does not know is not listed;
- a stop reply arrives on the gdb reader thread; a worker thread reads the registers and publishes `debug_state`. The state is per
  program session: a different session drops the connection.
Every RPC is on thread R (it needs the language); none waits for the target to run."""
import queue, threading

from ..core.errors import BUSY, INVALID, NOT_FOUND, TARGET, RpcError, log
from ..core.gdb import Gdb, GdbError
from ..core.rpc import rpc

# gdb architecture name -> Ghidra processor, for the "unknown architecture" check (an architecture missing here is only checked by its pc)
PROCESSORS = {"arm": "ARM", "aarch64": "AARCH64", "riscv": "RISCV", "i386": "x86", "mips": "MIPS", "powerpc": "PowerPC", "xtensa": "Xtensa", "m68k": "68000", "sparc": "sparc"}
ALIASES = {"xpsr": "cpsr"}  # a gdb register name Ghidra spells differently (Cortex-M's program status)
MAX_BITS = 128
MAX_STEPS, CALL_SECS, MAX_BOUNDARIES = 20000, 60, 5000
MEM_MAX, VALUE_MAX, ITEMS_MAX = 4096, 64, 256  # bytes per debug_memory, bytes per variable value, typed items per debug_memory  # a statement step gives up after this many instructions (it stops where it is)  # wider registers (vectors) are not shown


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
        self.regs, self.pc, self.sp, self.big, self.bp_kind = [], None, None, False, 4
        self.worker = False  # a statement step is running on its own thread
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
    def debug_attach(self, host="localhost", port=1234, offset="0x0"):
        prog = self.ses.need()
        if not isinstance(host, str) or not host.strip() or isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
            raise RpcError(INVALID, "A host and a port from 1 to 65535 are needed")
        try:
            off = int(offset, 16) if isinstance(offset, str) and offset.lower().lstrip("-").startswith("0x") else int(offset)
        except (ValueError, TypeError):
            raise RpcError(INVALID, "The offset is a hex number like 0x40000000 (runtime address minus program address)")
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
                sp = prog.getCompilerSpec().getStackPointer()
                self.sp = str(sp.getName()) if sp is not None else None
                self.bp_kind = 2 if "Cortex" in str(lang.getLanguageID()) else 4
                stop = self._req(g, "?")
                if stop[:1] not in ("T", "S"):
                    raise RpcError(TARGET, "The target is not stopped (%s)" % (stop or "no reply"))
                self.g, self.sid, self.offset, self.target, self.error = g, self.ses.session_id, off, "%s:%d" % (host.strip(), port), ""
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
                if self.state == "running" and not self.worker:  # like a debugger: stop the target, change the breakpoint, go on, without announcing a stop
                    q = queue.Queue()
                    g.sync = q
                    try:
                        g.interrupt()
                        r = q.get(timeout=5)
                    except (GdbError, queue.Empty):
                        raise RpcError(TARGET, "The target did not stop to change the breakpoint")
                    finally:
                        g.sync = None
                    if r is None or r[0] in "WX":
                        raise RpcError(TARGET, "The target stopped running")
                    try:
                        self._z(g, "z" if a in self.bps else "Z", a)
                    finally:
                        g.resume("c")
                elif self.state != "stopped" or self.worker:
                    raise RpcError(BUSY, "Pause the target before changing breakpoints")
                else:
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

    def _sp_of(self, g):
        n = next((n for n, name in self.names.items() if name == self.sp), None)
        return None if n is None else int.from_bytes(bytes.fromhex(self._req(g, "p%x" % n)), "big" if self.big else "little")

    def _pc_of(self, g):
        r = self._req(g, "p%x" % next(n for n, name in self.names.items() if name == self.pc))
        return int.from_bytes(bytes.fromhex(r), "big" if self.big else "little") - self.offset

    @rpc(lane="R")
    def debug_step(self, mode="instruction", boundaries=None):
        """mode "instruction": one instruction. "statement" (over calls), "into" (stops in a called function) and "out" (to the return) step
        instruction by instruction on a worker until the pc is at one of `boundaries` (program addresses where a statement of the pc's
        function starts, from the client's decompiler mapping; not needed for "out"); the stop arrives as debug_state."""
        if mode not in ("instruction", "statement", "into", "out"):
            raise RpcError(INVALID, "mode is instruction, statement, into or out")
        starts = set()
        if mode in ("statement", "into"):
            try:
                starts = {int(a, 16) for a in boundaries[:MAX_BOUNDARIES]} if isinstance(boundaries, list) and boundaries and all(isinstance(a, str) and a.lower().startswith("0x") for a in boundaries) else None
            except ValueError:
                starts = None
            if starts is None:
                raise RpcError(INVALID, "A statement step needs the statement start addresses (boundaries)")
        with self.lock:
            g = self._live()
            if self.state != "stopped" or self.worker:
                raise RpcError(BUSY, "The target is running")
            pc = self.address
            if mode != "instruction":
                self.cancel.clear()
                self.worker = True
                self.state, self.address, self.registers, self.error = "running", None, [], ""
                self.publish()
                threading.Thread(target=self._statement, args=(g, pc, starts, mode), daemon=True, name="debug-statement").start()
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

    def _statement(self, g, pc, starts, mode):
        """Worker: instruction by instruction until the pc is at a statement start (statement, into), a user breakpoint, outside the function
        (a return, or "into" a callee; "out" and "statement" run a call over to the instruction after it), or pause. A call is run over with a
        temporary breakpoint after it, ignoring returns of deeper (recursive) frames by comparing sp."""
        r = "T05"
        try:
            prog = self.ses.need()
            space = prog.getAddressFactory().getDefaultAddressSpace()
            func = prog.getFunctionManager().getFunctionContaining(space.getAddress(pc))
            body, listing = (func.getBody() if func is not None else None), prog.getListing()
            for _ in range(MAX_STEPS):
                ins = listing.getInstructionAt(space.getAddress(pc))
                sp0 = self._sp_of(g)
                r = self._single_step(g, pc)
                if r[0] in "WX" or self.cancel.is_set():
                    break
                npc = self._pc_of(g)
                inside = body is not None and body.contains(space.getAddress(npc))
                if npc in self.bps or (inside and npc in starts):
                    break
                if body is None:
                    break
                if inside or ins is None:
                    pc = npc
                    continue
                if not ins.getFlowType().isCall() or mode == "into":  # left the function by a return or a jump (or into a callee): stop there
                    break
                after = ins.getFallThrough()
                if after is None:
                    break
                back, temp = after.getOffset(), after.getOffset() not in self.bps
                if temp:
                    self._z(g, "Z", back)
                try:
                    while True:
                        r = g.resume("c", wait=True, timeout=CALL_SECS)
                        if r[0] in "WX" or self.cancel.is_set():
                            break
                        pc = self._pc_of(g)
                        sp = self._sp_of(g)
                        if pc != back or pc in self.bps or sp0 is None or sp is None or sp >= sp0:  # a deeper frame returning to the same address has a lower sp
                            break
                finally:
                    if temp and not g.closed:
                        self._z(g, "z", back)
                if r[0] in "WX" or self.cancel.is_set() or pc != back or pc in self.bps or pc in starts:  # a breakpoint or pause inside the callee, or the next statement begins right after the call
                    break
            self.worker = False  # before the stop is announced: the client's next step must find the target free
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
        finally:
            self.worker = False

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

    # ---- memory and variable values ----
    def _read_mem(self, g, addr, n):
        out = b""
        while len(out) < n:
            k = min(1024, n - len(out))
            r = self._req(g, "m%x,%x" % (addr + len(out), k))
            if len(r) != 2 * k or r[:1] == "E":
                raise RpcError(TARGET, "Cannot read %d bytes of the target's memory at 0x%x" % (k, addr + len(out)))
            out += bytes.fromhex(r)
        return out

    def _stopped_live(self):
        with self.lock:
            g = self._live()
            if self.state != "stopped":
                raise RpcError(BUSY, "The target is running")
            return g

    def _represent(self, prog, dt, data, addr):
        """A Ghidra data type's display value for bytes of target memory."""
        from jpype import JArray, JByte
        from ghidra.program.model.mem import ByteMemBufferImpl
        from ghidra.docking.settings import SettingsImpl
        buf = ByteMemBufferImpl(prog.getAddressFactory().getDefaultAddressSpace().getAddress(addr), JArray(JByte)([b - 256 if b > 127 else b for b in data]), self.big)
        from ghidra.program.model.scalar import Scalar
        v = dt.getValue(buf, SettingsImpl.NO_SETTINGS, len(data))
        if isinstance(v, Scalar):  # integers in decimal (the default representation is hex with an "h")
            return str(int(v.getSignedValue() if v.isSigned() else v.getUnsignedValue()))
        return str(dt.getRepresentation(buf, SettingsImpl.NO_SETTINGS, len(data)))

    @rpc(lane="R")
    def debug_memory(self, address, length=None, dataType=None):
        """Bytes of the target's memory at a runtime address (up to 4096), as hex, and with `dataType` the Ghidra data type applied to them:
        a structure or array gives one item per component (at most 256), anything else one item."""
        from ghidra.program.model.data import Array, Structure
        from ghidra.util.data import DataTypeParser
        from ghidra.util.data.DataTypeParser import AllowedDataTypes
        prog = self.ses.need()
        try:
            a = int(address, 16) if isinstance(address, str) and address.lower().startswith("0x") else None
        except ValueError:
            a = None
        if a is None or a < 0:
            raise RpcError(INVALID, "A memory address looks like 0x20000000")
        dt = None
        if dataType:
            dtm = prog.getDataTypeManager()
            try:
                dt = dtm.getDataType(dataType) if dataType.startswith("/") else None
                dt = dt or DataTypeParser(dtm, dtm, None, AllowedDataTypes.ALL).parse(dataType)
            except Exception as e:  # noqa  (ParseException, or anything the parser throws on junk)
                raise RpcError(INVALID, "unknown data type %r: %s" % (dataType, e))
        n = length if length is not None else (int(dt.getLength()) if dt is not None and dt.getLength() > 0 else 64)
        if isinstance(n, bool) or not isinstance(n, int) or not 0 < n <= MEM_MAX:
            raise RpcError(INVALID, "length is 1 to %d bytes" % MEM_MAX)
        g = self._stopped_live()
        data = self._read_mem(g, a, n)
        out = {"address": hex(a), "bytes": data.hex()}
        if dt is not None:
            comps = []
            if isinstance(dt, Structure):
                comps = [(int(c.getOffset()), c.getDataType(), str(c.getFieldName() or "field%d" % i)) for i, c in enumerate(dt.getDefinedComponents())]
            elif isinstance(dt, Array):
                el = dt.getDataType()
                comps = [(i * int(dt.getElementLength()), el, "[%d]" % i) for i in range(min(int(dt.getNumElements()), ITEMS_MAX))]
            else:
                comps = [(0, dt, "")]
            items = []
            for off, cdt, name in comps[:ITEMS_MAX]:
                ln = int(cdt.getLength()) if cdt.getLength() > 0 else n - off
                if off + ln > n or ln <= 0:
                    continue
                items.append({"offset": off, "length": ln, "type": str(cdt.getName()), "name": name, "value": self._represent(prog, cdt, data[off:off + ln], a + off)})
            out["items"] = items
        return out

    @rpc(lane="scan")
    def debug_values(self, entry, scan=None):
        """The variables of the function at `entry` (the decompiler's parameters, locals and the globals it uses) with their values in the
        target now: [{name, kind param|local|global, type, size, where, value, raw}]. Stack variables sit at sp-at-entry + offset (sp-at-entry
        from Ghidra's stack depth analysis for the pc); a variable in a register is the register's value at the stop, which is only
        meaningful where the decompiler keeps it live (shortcut: no liveness check). Stack variables need Ghidra's stack depth at the pc: where it is unknown (AArch64 prologues with writeback, for one) they are left out; upgrade: unwind analysis. Variables Ghidra holds in no fixed place are left out."""
        from ghidra.app.cmd.function import CallDepthChangeInfo
        from ghidra.util.task import TaskMonitor
        from .decompile import decompile_for_edit
        g = self._stopped_live()
        with self.lock:
            pc, regs = self.address, {r["name"]: int(r["value"], 16) for r in self.registers}
        with self.ctx.lanes.scanning(scan) as prog:
            func = prog.getFunctionManager().getFunctionAt(self.ses.addr(entry, prog))
            if func is None:
                raise RpcError(NOT_FOUND, "no function at %s" % entry)
            space = prog.getAddressFactory().getDefaultAddressSpace()
            sp = regs.get(self.sp)
            depth = None
            if sp is not None and pc is not None:
                try:
                    d = CallDepthChangeInfo(func, TaskMonitor.DUMMY).getDepth(space.getAddress(pc))
                    depth = int(d) if abs(int(d)) < 0x100000 else None  # Function.UNKNOWN_STACK_DEPTH_CHANGE is huge
                except Exception:  # noqa
                    depth = None
            places = []
            with decompile_for_edit(self.ctx, prog, func, 30, scan) as (hf, d, mon):
                syms = [(k, s) for k, s in (("local", s) for s in hf.getLocalSymbolMap().getSymbols())] + \
                       [("global", s) for s in hf.getGlobalSymbolMap().getSymbols()]
                for kind, sym in syms:
                    st = sym.getStorage()
                    if st is None or st.isUniqueStorage() or st.isHashStorage() or st.isBadStorage() or st.isVoidStorage():
                        continue
                    size = int(sym.getSize())
                    if not 0 < size <= VALUE_MAX:
                        continue
                    places.append((("param" if sym.isParameter() else kind), str(sym.getName()), sym.getDataType(), size, st))
            items = []
            for kind, name, dt, size, st in places[:ITEMS_MAX]:
                where, raw = None, None
                try:
                    if st.isStackStorage():
                        if sp is None or depth is None:
                            continue
                        addr = (sp - depth + int(st.getStackOffset())) & ((1 << 64) - 1)
                        where, data = "stack%+d" % int(st.getStackOffset()), self._read_mem(g, addr, size)
                    elif st.isRegisterStorage():
                        reg = st.getRegister()
                        base = reg.getBaseRegister()
                        v = regs.get(str(base.getName()))
                        if v is None:
                            continue
                        where = str(reg.getName())
                        data = (((v >> int(reg.getLeastSignificantBit())) & ((1 << (size * 8)) - 1))).to_bytes(size, "big" if self.big else "little")
                    elif st.isMemoryStorage():
                        addr = int(st.getMinAddress().getOffset())
                        where, data = hex(addr), self._read_mem(g, addr + self.offset, size)
                    else:
                        continue
                except RpcError:
                    continue  # unreadable (an unmapped address): leave it out
                try:
                    value = self._represent(prog, dt, data, 0)
                except Exception:  # noqa
                    value = "0x" + int.from_bytes(data, "big" if self.big else "little").to_bytes(size, "big").hex()
                items.append({"name": name, "kind": kind, "type": str(dt.getName()), "size": size, "where": where, "value": value,
                              "raw": "0x" + int.from_bytes(data, "big" if self.big else "little").to_bytes(size, "big").hex()})
            return {"pc": hex(pc) if pc is not None else None, "items": items}

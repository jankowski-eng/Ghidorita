"""Patching one instruction (capability `patch`): assemble text with Ghidra's assembler for the program's language, write the bytes as one
transaction, and keep the original bytes in a program property map so they survive save and reopen and follow undo/redo."""
import re, threading

from ..core.errors import INVALID, NOT_FOUND, RpcError
from ..core.args import text_arg
from ..core.rpc import rpc

ORIGINAL = "ghidorita.patch.original"  # IntPropertyMap: address of a patched byte -> its first-seen (unpatched) value
MAX_BYTES, MAX_RUNS = 16, 10000


def _hex(bs):
    return " ".join("%02x" % (b & 0xFF) for b in bs)


class Patch:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session
        self.asm_lock = threading.Lock()  # Ghidra builds a language's assembler lazily and not thread-safely: two scan workers racing on the first call get a null parser

    def _unit(self, prog, a, address):
        """The code unit that starts at `a` (a patch always replaces whole units): its length and old bytes."""
        mem = prog.getMemory()
        if not mem.getLoadedAndInitializedAddressSet().contains(a):
            raise RpcError(INVALID, "address %s is not in initialized memory" % address)
        cu = prog.getListing().getCodeUnitContaining(a)
        if cu is None:
            raise RpcError(NOT_FOUND, "no code unit at %s" % address)
        if not cu.getMinAddress().equals(a):
            raise RpcError(INVALID, "address %s is inside the unit at %s; patch from its start" % (address, self.ses.fmt(cu.getMinAddress(), prog)))
        return cu

    def _overwrites(self, prog, a, old_len, new_len):
        """Defined units (instructions, data) after the first one that a patch of new_len bytes would replace; the end of the last one touched."""
        if new_len <= old_len:
            return 0, a.add(old_len - 1)
        end, n, last = a.add(new_len - 1), 0, a.add(old_len - 1)
        cu = prog.getListing().getCodeUnitAfter(last)
        while cu is not None and cu.getMinAddress().compareTo(end) <= 0:
            if not hasattr(cu, "isDefined") or cu.isDefined():
                n += 1
            last = cu.getMaxAddress()
            cu = prog.getListing().getCodeUnitAfter(last)
        return n, (last if last.compareTo(end) > 0 else end)

    @rpc(lane="scan")
    def assemble_instruction(self, address, text, scan=None):
        """Assembles `text` at `address` with Ghidra's assembler for the program's language (the first call per language builds its grammar,
        seconds on x86: scan lane, cancellable with cancel_search). Nothing is written. Result {address, bytes, length, oldBytes, oldLength,
        overwrites}: `oldLength` is the unit at `address` that a patch replaces, `overwrites` the following instructions a longer patch would also
        overwrite (0 when the bytes fit). InvalidArgument names what Ghidra rejected (syntax, an operand, an unknown mnemonic)."""
        import jpype
        from ghidra.app.plugin.assembler import Assemblers
        text_arg(text, "text")
        if not text.strip() or "\n" in text:
            raise RpcError(INVALID, "text must be one instruction")
        with self.ctx.lanes.scanning(scan) as prog:
            a = self.ses.addr(address, prog)
            cu = self._unit(prog, a, address)
            old = cu.getBytes()
            try:
                with self.asm_lock:
                    scan.check()  # cancelled while waiting for an earlier (slow, first-time) assembly
                    asm = Assemblers.getAssembler(prog)
                    ctx = asm.getContextAt(a).fillMask()
                    out = bytes(x & 0xFF for x in asm.assembleLine(a, text.strip(), ctx))
            except jpype.JException as e:
                raise RpcError(INVALID, "cannot assemble %r: %s" % (text.strip(), str(e.getMessage() or e.getClass().getSimpleName()).strip()))
            scan.check()
            n, _ = self._overwrites(prog, a, cu.getLength(), len(out))
            return {"address": address, "bytes": _hex(out), "length": len(out), "oldBytes": _hex(old), "oldLength": int(cu.getLength()), "overwrites": n}

    @rpc(lane="R")
    def patch_instruction(self, address, bytes, overwriteFollowing=False):
        """Writes `bytes` ("90" or "48 89 e5", from assemble_instruction) over the unit at `address` in one transaction "Patch instruction at <address>"
        and disassembles the range again. Refused (InvalidArgument) when they are longer than that unit, unless `overwriteFollowing` is true: then the
        following units they cover are cleared too and counted in `overwritten`. Shorter bytes leave the rest of the old unit as it was (it is
        disassembled again too, as Ghidra's own Patch Instruction does). Busy while the analysis runs. Result {address, length, replaced, overwritten}.
        The first-seen value of every byte written is kept in a property map (list_patches)."""
        from ghidra.app.cmd.disassemble import DisassembleCommand
        from ghidra.program.model.address import AddressSet
        from jpype import JArray, JByte, JInt
        text_arg(bytes, "bytes")
        if not isinstance(overwriteFollowing, bool):
            raise RpcError(INVALID, "overwriteFollowing must be a boolean")
        if not re.fullmatch(r"[0-9a-fA-F]{2}( [0-9a-fA-F]{2})*", bytes) or len(bytes.split()) > MAX_BYTES:
            raise RpcError(INVALID, "bytes must be 1 to %d hex bytes like '48 89 e5'" % MAX_BYTES)
        data = [int(x, 16) for x in bytes.split()]
        prog = self.ses.need()
        a = self.ses.addr(address, prog)
        cu = self._unit(prog, a, address)
        old_len, n = int(cu.getLength()), len(data)
        over, last = self._overwrites(prog, a, old_len, n)
        if n > old_len and not overwriteFollowing:
            raise RpcError(INVALID, "%d bytes do not fit the %d-byte unit at %s; it would overwrite the following %d instruction(s) (overwriteFollowing)" % (n, old_len, address, over))
        if not prog.getMemory().getLoadedAndInitializedAddressSet().contains(a, a.add(n - 1)):
            raise RpcError(INVALID, "the bytes run past initialized memory")
        span = AddressSet(a, last)  # the new bytes, the rest of the old unit, and the units the longer patch ate

        def go(p):
            pm = p.getUsrPropertyManager()
            orig = pm.getIntPropertyMap(ORIGINAL) or pm.createIntPropertyMap(ORIGINAL)
            for i in range(n):
                b = a.add(i)
                if not orig.hasProperty(b):
                    orig.add(b, JInt(p.getMemory().getByte(b) & 0xFF))
            p.getListing().clearCodeUnits(a, last, False)
            p.getMemory().setBytes(a, JArray(JByte)([x - 256 if x > 127 else x for x in data]))
            DisassembleCommand(span, span, True).applyTo(p)
        self.ses.edit("Patch instruction at %s" % address, go)
        self.ctx.events.record({"code", "data"}, [self.ses.rng(a, last)])
        return {"address": address, "length": n, "replaced": old_len, "overwritten": over if n > old_len else 0}

    @rpc(lane="R")
    def list_patches(self):
        """The bytes of the program that differ from what the file had, as runs of adjacent addresses in address order: [{address, length, original,
        current}] (hex). A byte patched back to its original value is not listed. At most 10000 runs (shortcut: no paging)."""
        prog = self.ses.need()
        orig = prog.getUsrPropertyManager().getIntPropertyMap(ORIGINAL)
        if orig is None:
            return []
        mem, fa, runs, last = prog.getMemory(), self.ses.fmtr(prog), [], None
        for b in orig.getPropertyIterator():
            was, now = int(orig.getInt(b)) & 0xFF, int(mem.getByte(b)) & 0xFF
            if was == now:
                continue
            if last is not None and runs and b.equals(last.next()):
                r = runs[-1]
                r["length"] += 1; r["original"] += " %02x" % was; r["current"] += " %02x" % now
            else:
                if len(runs) >= MAX_RUNS:
                    break
                runs.append({"address": fa(b), "length": 1, "original": "%02x" % was, "current": "%02x" % now})
            last = b
        return runs

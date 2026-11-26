"""The open program and what every domain needs to touch it: need(), addr(), edit() (one transaction), the undo snapshot."""
import re, threading

from .args import MASK64
from .errors import INVALID, NO_PROGRAM, NOT_FOUND, RpcError, java_error


def undo_state(prog):
    o = {"canUndo": bool(prog.canUndo()), "canRedo": bool(prog.canRedo()), "dirty": bool(prog.isChanged())}
    if o["canUndo"]:
        o["undoName"] = str(prog.getUndoName())
    if o["canRedo"]:
        o["redoName"] = str(prog.getRedoName())
    return o


def clean_undo():
    return {"canUndo": False, "canRedo": False, "dirty": False}


class Session:
    def __init__(self):
        self.program = self.results = self.consumer = None
        self.program_id = None
        self.epoch = 0                    # bumped whenever the program changes (open/close); guarded by lock
        self.lock = threading.Lock()      # the program swap: program + epoch (+ lanes.running/active)
        self.undo_snap = clean_undo()
        self.save_lock = threading.Lock()  # held for the duration of every save; shutdown never exits while it is held

    def need(self):
        if self.program is None:
            raise RpcError(NO_PROGRAM, "no program open")
        return self.program

    def addr(self, s, prog=None):
        """Address string (protocol.md: "0x401000", "code:1000", "OVL1::1000") -> Ghidra Address; offsets up to 2^64-1."""
        prog = prog or self.need()
        try:
            f = prog.getAddressFactory()
            name, _, h = s.rpartition(":") if ":" in s else ("", "", s)
            sp = f.getAddressSpace(name[:-1] if name.endswith(":") else name) if name else f.getDefaultAddressSpace()
            if sp is None or not re.fullmatch(r"(0[xX])?[0-9a-fA-F]{1,16}", h):
                raise ValueError(s)
            off = int(h, 16)
            return sp.getAddress(off - (1 << 64) if off >= 1 << 63 else off)
        except Exception:
            raise RpcError(INVALID, "bad address %r" % (s,))

    def fmtr(self, prog=None):
        """-> function Address -> protocol string (the default space as "0x..", others space-qualified); one lookup of the default space."""
        dsid = (prog or self.need()).getAddressFactory().getDefaultAddressSpace().getSpaceID()

        def f(a):
            sp = a.getAddressSpace()
            off = a.getOffset() & MASK64
            if sp.getSpaceID() == dsid:
                return "0x%x" % off
            return "%s%s%x" % (sp.getName(), "::" if sp.isOverlaySpace() else ":", off)
        return f

    def fmt(self, a, prog=None):
        return self.fmtr(prog)(a)

    @staticmethod
    def rng(lo, hi):
        """Pending change range: (space name, first offset, last offset), unsigned."""
        return (str(lo.getAddressSpace().getName()), lo.getOffset() & MASK64, hi.getOffset() & MASK64)

    def refresh_undo(self, prog=None):
        self.undo_snap = undo_state(prog or self.need())
        return self.undo_snap

    # ---- edits (thread R). One transaction each; its name is the undo label. ----
    def edit(self, name, fn):
        """Run fn(prog) in one transaction, then flush Ghidra's event queue so the cache invalidation (listener) has
        happened before the reply is sent: a decompile requested after the reply can never see a stale entry."""
        import jpype
        prog = self.need()
        tx, ok = prog.startTransaction(name), False
        try:
            r = fn(prog)
            ok = True
        except jpype.JException as e:
            raise java_error(e)
        finally:
            prog.endTransaction(tx, ok)  # not ok => rolled back, nothing on the undo stack
            prog.flushEvents()  # also on rollback: a decompile that saw the half-applied state must not be cached
        self.refresh_undo(prog)
        return r

    @staticmethod
    def cmd(cmd):
        """A Ghidra Command as an edit() body."""
        def run(prog):
            if not cmd.applyTo(prog):
                raise RpcError(INVALID, str(cmd.getStatusMsg() or "command failed"))
        return run

    def function(self, entry):
        prog = self.need()
        f = prog.getFunctionManager().getFunctionAt(self.addr(entry))
        if f is None:
            raise RpcError(NOT_FOUND, "no function at %s" % entry)
        return prog, f

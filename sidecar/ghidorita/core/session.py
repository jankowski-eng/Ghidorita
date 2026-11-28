"""The open program and what every domain needs to touch it: need(), addr(), edit() (one transaction), the undo snapshot."""
import re, threading, uuid

from .args import MASK64
from .errors import BUSY, INVALID, NO_PROGRAM, NOT_FOUND, RpcError, java_error


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
        self.program_id = self.session_id = self.name = None
        self.epoch = 0                    # bumped whenever the program changes (open/close); guarded by lock
        self.revision = 0                 # bumped after every write; protects prepared variable edits
        self.lock = threading.Lock()      # the program swap: program + epoch (+ lanes.running/active)
        self.undo_snap = clean_undo()
        self._tl = threading.local()      # the current call's cell: the undo name of the edit it committed (begin_call / take_committed; lanes.on_r hands it to thread R)
        self.save_lock = threading.Lock()  # held for the duration of every save; shutdown never exits while it is held
        self.analyzing = False            # an analysis owns the program's one open transaction: edits, undo and redo are Busy (domains/analysis.py)

    def publish(self, program, key, name):
        with self.lock:
            self.epoch += 1
            self.program, self.program_id, self.name = program, key, name
            self.session_id = uuid.uuid4().hex
            return self._descriptor()

    def _descriptor(self):
        return {"sessionId": self.session_id, "programId": self.program_id, "name": self.name} if self.program is not None else None

    def active(self):
        with self.lock:
            return self._descriptor()

    def need(self):
        if self.program is None:
            raise RpcError(NO_PROGRAM, "no program open")
        return self.program

    def addr(self, s, prog=None):
        """Address string (protocol.md: "0x401000", "code:1000", "OVL1::1000") -> Ghidra Address; offsets up to 2^64-1.
        A program whose default space is segmented (x86 real mode) also takes Ghidra's "1000:0042" (segment:offset); it is sent back as the
        linear "0x10042" (the flat offset round-trips: the same byte, the canonical segment is Ghidra's choice)."""
        prog = prog or self.need()
        try:
            f = prog.getAddressFactory()
            name, _, h = s.rpartition(":") if ":" in s else ("", "", s)
            sp = f.getAddressSpace(name[:-1] if name.endswith(":") else name) if name else f.getDefaultAddressSpace()
            if sp is None and re.fullmatch(r"[0-9a-fA-F]{1,4}:[0-9a-fA-F]{1,4}", s):
                from ghidra.program.model.address import SegmentedAddressSpace
                if isinstance(f.getDefaultAddressSpace(), SegmentedAddressSpace):
                    a = f.getAddress(s)
                    if a is not None:
                        return a
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
        if self.analyzing:  # a second transaction would join the analysis one: not undoable alone, and a rollback would abort the analysis
            raise RpcError(BUSY, "analysis running")
        tx, ok = prog.startTransaction(name), False
        try:
            r = fn(prog)
            ok = True
        except jpype.JException as e:
            raise java_error(e)
        finally:
            prog.endTransaction(tx, ok)  # not ok => rolled back, nothing on the undo stack
            prog.flushEvents()  # also on rollback: a decompile that saw the half-applied state must not be cached
            with self.lock:
                self.revision += 1
        self.refresh_undo(prog)
        cell = getattr(self._tl, "cell", None)
        if cell is not None:
            cell["undoName"] = self.undo_snap.get("undoName")  # what `undo {expect}` compares with
        return r

    def begin_call(self):
        self._tl.cell = {}

    def current_cell(self):
        return getattr(self._tl, "cell", None)

    def adopt_cell(self, cell):
        """A call that hops to another thread (lanes.on_r) continues in the caller's cell."""
        self._tl.cell = cell

    def take_committed(self):
        """The undo name of the last transaction this call committed through edit(), or None (a read, or a failed edit)."""
        cell, self._tl.cell = getattr(self._tl, "cell", None), None
        return cell.get("undoName") if cell else None

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

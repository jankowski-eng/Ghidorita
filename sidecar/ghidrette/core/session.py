"""The open program and what every domain needs to touch it: need(), addr(), edit() (one transaction), the undo snapshot."""
import threading

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
        prog = prog or self.need()
        try:
            off = int(s, 16)
            # shortcut: single default address space only, upgrade when segmented/overlay binaries matter
            return prog.getAddressFactory().getDefaultAddressSpace().getAddress(off)
        except Exception:
            raise RpcError(INVALID, "bad address %r" % (s,))

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

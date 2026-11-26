"""Decompiling: the decompiler pool's `decompile` (thread D, each worker owns a DecompInterface), the result cache, the tokenizer.

The cache is shared by the pool and invalidated through events.subscribe (comment/code changes by range, anything else clears it).
decompile_for_edit is the one function other domains may call (highvars): a decompile for an edit, run on the caller's thread."""
import contextlib, threading
from collections import OrderedDict

from ..core.args import hx, lim
from ..core.errors import CANCELLED, INTERNAL, NO_PROGRAM, NOT_FOUND, TIMEOUT, RpcError
from ..core.rpc import rpc

KINDS = {0: "keyword", 1: "comment", 2: "type", 3: "function", 4: "variable", 5: "const",
         6: "param", 7: "variable", 8: "default", 9: "default", 10: "default"}
# kinds whose cache effect is fully described by their ranges (everything else clears the whole decompile cache)
RANGE_ONLY_KINDS = {"comment", "code"}


@contextlib.contextmanager
def decompile_for_edit(ctx, prog, func, timeoutSecs, job):
    """Decompile `func` with a short-lived DecompInterface on the CALLING thread (R) and yield the HighFunction; the interface is
    disposed when the with block ends. `job` is registered for cancel_decompile (its monitor is the one the decompile runs under).
    Raises Cancelled / Timeout / Internal exactly like the pool's decompile. See highvars._high_edit for why this is not the pool."""
    from ghidra.app.decompiler import DecompInterface
    from ghidra.pyghidra import PyGhidraTaskMonitor
    mon = PyGhidraTaskMonitor(None, None)
    with ctx.lanes.mon_lock:
        job.mon = mon
        if job.cancelled:
            mon.cancel()
    d = DecompInterface()
    try:
        if not d.openProgram(prog):
            raise RpcError(INTERNAL, "decompiler failed to open program: %s" % d.getLastMessage())
        res = d.decompileFunction(func, timeoutSecs, mon)
        if res.isCancelled() or mon.isCancelled():
            raise RpcError(CANCELLED, "decompile cancelled")
        if res.isTimedOut():
            raise RpcError(TIMEOUT, "decompile timed out after %ss" % timeoutSecs)
        if not res.decompileCompleted():
            raise RpcError(INTERNAL, "decompile failed: %s" % res.getErrorMessage())
        yield res.getHighFunction()
    finally:
        d.dispose()


class Decompile:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session
        self.cache = OrderedDict()   # entry offset -> (lo, hi, result); cache_lock
        self.cache_ver = 0
        self.cache_lock = threading.Lock()
        ctx.events.subscribe(self._invalidate)

    def _invalidate(self, kinds, ranges, broad):
        # decompile output embeds names/types of other symbols, so only comment/code changes are ranged; shortcut:
        # symbol/function/data/type/other changes clear the whole cache, upgrade by tracking referenced addresses per entry.
        if broad or not kinds <= RANGE_ONLY_KINDS:
            self.cache_clear()
        else:
            self.cache_invalidate(ranges)

    # ---- decompile cache (shared by the pool and by the event listener) ----
    def cache_clear(self):
        with self.cache_lock:
            self.cache.clear()
            self.cache_ver += 1

    def cache_invalidate(self, ranges):
        with self.cache_lock:
            for k in [k for k, (lo, hi, _) in self.cache.items() if any(s <= hi and e >= lo for s, e in ranges)]:
                del self.cache[k]
            self.cache_ver += 1  # also stops in-flight decompiles from storing a pre-edit result

    # ---- decompile (pool worker) ----
    @rpc(lane="decomp")
    def decompile(self, entry, timeoutSecs=30, job=None):
        from ghidra.app.decompiler import DecompInterface
        from ghidra.pyghidra import PyGhidraTaskMonitor
        w = self.ctx.lanes.worker()
        timeoutSecs = lim(timeoutSecs, 30)
        with self.ses.lock:
            prog, epoch = self.ses.program, self.ses.epoch
            if job.cancelled or job.epoch != epoch:  # cancelled while queued, or the program was closed/swapped meanwhile
                raise RpcError(CANCELLED, "decompile cancelled")
            if prog is None:
                raise RpcError(NO_PROGRAM, "no program open")
            w.busy = True
            self.ctx.lanes.running.add(job)
        try:
            a = self.ses.addr(entry, prog)
            func = prog.getFunctionManager().getFunctionAt(a)
            if func is None:
                raise RpcError(NOT_FOUND, "no function at %s" % entry)
            key = a.getOffset()
            with self.cache_lock:
                ver = self.cache_ver
                hit = self.cache.get(key)
                if hit is not None:
                    self.cache.move_to_end(key)
                    return {**hit[2], "cached": True}
            if w.decomp is None or w.epoch != epoch:
                self.ctx.lanes.dispose(w)
                d = DecompInterface()
                if not d.openProgram(prog):
                    raise RpcError(INTERNAL, "decompiler failed to open program: %s" % d.getLastMessage())
                w.decomp, w.epoch = d, epoch
            mon = PyGhidraTaskMonitor(None, None)
            with self.ctx.lanes.mon_lock:
                job.mon = mon
                if job.cancelled:
                    mon.cancel()
            res = w.decomp.decompileFunction(func, timeoutSecs, mon)
            if res.isCancelled() or mon.isCancelled():
                raise RpcError(CANCELLED, "decompile cancelled")
            if res.isTimedOut():
                raise RpcError(TIMEOUT, "decompile timed out after %ss" % timeoutSecs)
            if not res.decompileCompleted():
                raise RpcError(INTERNAL, "decompile failed: %s" % res.getErrorMessage())
            out = self._tokens(prog, res)
            body = func.getBody()
            with self.cache_lock:
                if self.cache_ver == ver:  # an edit/invalidation during the decompile means this result may be stale: don't store
                    self.cache[key] = (body.getMinAddress().getOffset(), body.getMaxAddress().getOffset(), out)
                    if len(self.cache) > 256:
                        self.cache.popitem(last=False)
            return {**out, "cached": False}
        finally:
            with self.ses.lock:
                w.busy = False
                self.ctx.lanes.running.discard(job)

    def _tokens(self, prog, res):
        from ghidra.app.decompiler import ClangFuncNameToken, ClangFieldToken, ClangLabelToken
        from ghidra.app.decompiler.component import DecompilerUtils
        from ghidra.program.model.pcode import PcodeOp
        fm = prog.getFunctionManager()
        lines_out, tokens = [], []
        for ln, line in enumerate(DecompilerUtils.toLines(res.getCCodeMarkup())):
            indent = str(line.getIndentString())
            col = len(indent)
            text = indent
            for t in line.getAllTokens():
                s = str(t.getText())
                start, col = col, col + len(s)  # Java String length == UTF-16 units, as protocol wants
                text += s
                if not s.strip():
                    continue
                kind = KINDS.get(int(t.getSyntaxType()), "default")
                if isinstance(t, ClangFieldToken):
                    kind = "field"
                elif isinstance(t, ClangLabelToken):
                    kind = "label"
                tok = {"line": ln, "colStart": start, "colEnd": col, "kind": kind}
                ma = t.getMinAddress()
                if ma is not None:
                    tok["address"] = hx(ma.getOffset())
                if kind in ("variable", "param"):
                    tok["varName"] = s
                if isinstance(t, ClangFuncNameToken):
                    # only tokens that belong to a call op; the function's own name in its signature has no op
                    op = t.getPcodeOp()
                    if op is not None and op.getOpcode() == PcodeOp.CALL:
                        f = fm.getFunctionAt(op.getInput(0).getAddress())
                        if f is not None:
                            tok["targetFunction"] = hx(f.getEntryPoint().getOffset())
                tokens.append(tok)
            lines_out.append(text)
        return {"text": "\n".join(lines_out), "tokens": tokens}

    # ---- loop-thread side ----
    @rpc(lane="loop")
    def cancel_decompile(self, id):
        """Cancel the decompile request with this JSON-RPC id, queued or running. False if unknown/finished."""
        job = self.ctx.lanes.dj.get(id)
        if job is None:
            return {"cancelled": False}
        with self.ctx.lanes.mon_lock:
            job.cancelled = True
            if job.mon is not None:
                job.mon.cancel()
        return {"cancelled": True}

"""Decompiling: the decompiler pool's `decompile` (thread D, each worker owns a DecompInterface), the result cache, the tokenizer.

The cache is shared by the pool and invalidated through events.subscribe (comment/code changes by range, anything else clears it).
decompile_for_edit is the one function other domains may call (highvars): a decompile for an edit, run on the caller's scan worker."""
import contextlib, threading
from collections import OrderedDict

from ..core.args import MASK64, akey, lim, text_arg
from ..core.errors import CANCELLED, INTERNAL, NO_PROGRAM, NOT_FOUND, TIMEOUT, RpcError
from ..core.rpc import rpc

KINDS = {0: "keyword", 1: "comment", 2: "type", 3: "function", 4: "variable", 5: "const",
         6: "param", 7: "variable", 8: "default", 9: "default", 10: "default"}
# kinds whose cache effect is fully described by their ranges (everything else clears the whole decompile cache)
RANGE_ONLY_KINDS = {"comment", "code"}


@contextlib.contextmanager
def decompile_for_edit(ctx, prog, func, timeoutSecs, job, timed=False):
    """Yield the high function, decompiler and monitor on the scan worker. A timed monitor
    also bounds any follow-up decompiles and analysis in the caller's with block."""
    from java.util.concurrent import TimeUnit
    from ghidra.app.decompiler import DecompInterface
    from ghidra.pyghidra import PyGhidraTaskMonitor
    from ghidra.util.exception import CancelledException
    from ghidra.util.task import TimeoutTaskMonitor
    mon = TimeoutTaskMonitor.timeoutIn(timeoutSecs, TimeUnit.SECONDS) if timed else PyGhidraTaskMonitor(None, None)
    d = DecompInterface()
    with ctx.lanes.mon_lock:
        job.mon = mon
        if job.cancelled:
            mon.cancel()
    try:
        mon.checkCancelled()
        opened = d.openProgram(prog)
        mon.checkCancelled()
        if not opened:
            raise RpcError(INTERNAL, "decompiler failed to open program: %s" % d.getLastMessage())
        res = d.decompileFunction(func, timeoutSecs, mon)
        mon.checkCancelled()
        if res.isTimedOut():
            raise RpcError(TIMEOUT, "decompile timed out after %ss" % timeoutSecs)
        if res.isCancelled():
            raise RpcError(CANCELLED, "decompile cancelled")
        if not res.decompileCompleted():
            raise RpcError(INTERNAL, "decompile failed: %s" % res.getErrorMessage())
        yield res.getHighFunction(), d, mon
        mon.checkCancelled()
    except CancelledException as e:
        if timed and mon.didTimeout() and not job.cancelled:
            raise RpcError(TIMEOUT, "structure inference timed out after %ss" % timeoutSecs) from e
        raise RpcError(CANCELLED, "decompile cancelled") from e
    finally:
        with ctx.lanes.mon_lock:
            job.mon = None
        if timed:
            mon.cancel()
        d.dispose()


class Decompile:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session
        self.cache = OrderedDict()   # (space, entry offset) -> (space, lo, hi, result); cache_lock
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
        """ranges: (space name, first offset, last offset), as events.record gives them."""
        with self.cache_lock:
            for k in [k for k, (sp, lo, hi, _) in self.cache.items() if any(sp == rs and s <= hi and e >= lo for rs, s, e in ranges)]:
                del self.cache[k]
            self.cache_ver += 1  # also stops in-flight decompiles from storing a pre-edit result

    # ---- decompile (pool worker) ----
    @rpc(lane="decomp")
    def decompile(self, entry, timeoutSecs=30, job=None):
        out, hit = self._run(entry, timeoutSecs, job, (), lambda prog, func, res: self._tokens(prog, res))
        return {**out, "cached": hit}

    @rpc(lane="decomp")
    def variable_uses(self, entry, name, timeoutSecs=30, job=None):
        """Where the decompiler's variable `name` (iVar1, a register temporary, a global...) is written and read inside the function at
        `entry`: [{from, type, kind: "write"|"read", function}] sorted by address. The uses of every variable of the function are
        computed from one decompile and cached with the decompile cache (same invalidation), so a second variable costs nothing."""
        text_arg(name, "name")
        uses, _ = self._run(entry, timeoutSecs, job, ("uses",), self._uses)
        return uses.get(name, [])

    def _run(self, entry, timeoutSecs, job, tag, work):
        """The pool worker's decompile: returns (work(prog, func, results), cached). The cache key is the entry's (space, offset) plus `tag`."""
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
            key = (str(a.getAddressSpace().getName()), a.getOffset() & MASK64) + tag
            with self.cache_lock:
                ver = self.cache_ver
                hit = self.cache.get(key)
                if hit is not None:
                    self.cache.move_to_end(key)
                    return hit[3], True
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
            out = work(prog, func, res)
            body = func.getBody()
            with self.cache_lock:
                if self.cache_ver == ver:  # an edit/invalidation during the decompile means this result may be stale: don't store
                    self.cache[key] = (key[0], body.getMinAddress().getOffset() & MASK64, body.getMaxAddress().getOffset() & MASK64, out)
                    if len(self.cache) > 256:
                        self.cache.popitem(last=False)
            return out, False
        finally:
            with self.ses.lock:
                w.busy = False
                self.ctx.lanes.running.discard(job)

    def _uses(self, prog, func, res):
        """name -> sorted [{from, type, kind, function}] for every high variable of the function: the defining op of each varnode
        instance is a write, each op reading it a read. Instruction address of the op; phi (MULTIEQUAL) and INDIRECT ops are not uses.
        Locals only (globals have an address: xrefs_to), whose p-code includes the decompiler's own save/restore copies."""
        from ghidra.program.model.pcode import PcodeOp
        hf, fa, fname = res.getHighFunction(), self.ses.fmtr(prog), str(func.getName())
        skip = (PcodeOp.MULTIEQUAL, PcodeOp.INDIRECT)
        out = {}
        for sym in hf.getLocalSymbolMap().getSymbols():  # locals only: a global's references are xrefs_to its address
            hv = sym.getHighVariable()
            if hv is None:
                continue
            seen = {}
            for vn in hv.getInstances():
                d = vn.getDef()
                if d is not None and d.getOpcode() not in skip:
                    seen.setdefault((fa(d.getSeqnum().getTarget()), "write"), str(d.getMnemonic()))
                for op in vn.getDescendants():
                    if op.getOpcode() not in skip:
                        seen.setdefault((fa(op.getSeqnum().getTarget()), "read"), str(op.getMnemonic()))
            rows = [{"from": a, "type": ty, "kind": k, "function": fname} for (a, k), ty in seen.items()]
            rows.sort(key=lambda r: (akey(r["from"]), r["kind"]))
            out.setdefault(str(sym.getName()), rows)
        return out

    def _tokens(self, prog, res):
        from ghidra.app.decompiler import ClangFuncNameToken, ClangFieldToken, ClangLabelToken
        from ghidra.app.decompiler.component import DecompilerUtils
        from ghidra.program.model.pcode import PcodeOp
        fm, fa, hf = prog.getFunctionManager(), self.ses.fmtr(prog), res.getHighFunction()
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
                    tok["address"] = fa(ma)
                if kind in ("variable", "param"):
                    tok["varName"] = s
                    ga = self._global_addr(t, hf, fa)
                    if ga is not None:
                        tok["varAddress"] = ga
                if isinstance(t, ClangFuncNameToken):
                    # only tokens that belong to a call op; the function's own name in its signature has no op
                    op = t.getPcodeOp()
                    if op is not None and op.getOpcode() == PcodeOp.CALL:
                        f = fm.getFunctionAt(op.getInput(0).getAddress())
                        if f is not None:
                            tok["targetFunction"] = fa(f.getEntryPoint())
                tokens.append(tok)
            lines_out.append(text)
        return {"text": "\n".join(lines_out), "tokens": tokens}

    @staticmethod
    def _global_addr(t, hf, fa):
        """Memory address of the variable a ClangVariableToken shows when it is a global, else None. The high symbol decides: the varnode of
        a store's destination (`g = ...`) can be the register that holds the value."""
        from ghidra.app.decompiler import ClangVariableToken
        if not isinstance(t, ClangVariableToken):
            return None
        sym = t.getHighSymbol(hf)
        if sym is not None and sym.isGlobal():
            a = sym.getStorage().getMinAddress()
            return fa(a) if a is not None and a.isMemoryAddress() else None
        vn = t.getVarnode()  # no symbol: a varnode that lives in memory (stack, register and unique varnodes are not memory addresses)
        if vn is not None and not vn.isConstant() and vn.getAddress().isMemoryAddress():
            return fa(vn.getAddress())
        return None

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

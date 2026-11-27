"""Decompiling: the decompiler pool's `decompile` (thread D, each worker owns a DecompInterface), the result cache, the tokenizer.

The cache is shared by the pool and invalidated through events.subscribe (comment/code changes by range, anything else clears it).
decompile_for_edit is the one function other domains may call (highvars): a decompile for an edit, run on the caller's scan worker."""
import contextlib, re, threading
from collections import OrderedDict

from ..core.args import MASK64, akey, lim, text_arg
from ..core.errors import CANCELLED, INTERNAL, INVALID, NO_PROGRAM, NOT_FOUND, TIMEOUT, RpcError
from ..core.rpc import rpc

KINDS = {0: "keyword", 1: "comment", 2: "type", 3: "function", 4: "variable", 5: "const",
         6: "param", 7: "variable", 8: "default", 9: "default", 10: "default"}
# kinds whose cache effect is fully described by their ranges (everything else clears the whole decompile cache)
RANGE_ONLY_KINDS = {"comment", "code", "bookmark"}
# the decompiler's auto-generated comments (Funcdata::warning: "WARNING: ..." or "WARNING (jumptable): ..."); a whole line of them
WARNING_ONE = re.compile(r"/\*\s*(WARNING(?:(?!\*/).)*?)\s*\*/")  # the body never crosses a "*/"
WARNING_LINE = re.compile(r"(?:/\*\s*WARNING(?:(?!\*/).)*\*/\s*)+")
WARNINGS_MAX = 50
PCODE_MAX_INSNS, PCODE_MAX_OPS = 5000, 30000  # shortcut: a larger function is cut and `truncated` says so; upgrade with paging
GRAPH_MAX_BLOCKS, GRAPH_MAX_LINES = 2000, 200  # shortcut: larger functions are cut, upgrade with a "truncated" flag in the result


def union_of(tok):
    """The union data type a decompiler token stands for (Ghidra's ForceUnionAction.findUnion), else None: a field token of a union, or a token
    whose variable is a union, a pointer to one or a part of one (typedefs looked through)."""
    from ghidra.app.decompiler import ClangFieldToken
    from ghidra.program.model.data import Pointer, TypeDef, Union
    from ghidra.program.model.pcode import PartialUnion
    base = lambda dt: dt.getBaseDataType() if isinstance(dt, TypeDef) else dt
    if isinstance(tok, ClangFieldToken):
        dt = tok.getDataType()
        if dt is not None and isinstance(base(dt), Union):
            return base(dt)
    vn = tok.getVarnode()
    high = vn.getHigh() if vn is not None else None  # a volatile load never gets a high variable
    if high is None:
        return None
    dt = base(high.getDataType())
    dt = base(dt.getDataType()) if isinstance(dt, Pointer) else base(dt.getParent()) if isinstance(dt, PartialUnion) else dt
    return dt if isinstance(dt, Union) else None


@contextlib.contextmanager
def decompile_for_edit(ctx, prog, func, timeoutSecs, job, timed=False):
    """Yield the high function, decompiler, monitor and the decompile results on the scan worker. A timed monitor
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
        yield res.getHighFunction(), d, mon, res
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

    @rpc(lane="decomp")
    def function_graph(self, entry, timeoutSecs=30, job=None):
        """Basic blocks of the function at `entry` with their decompiled C (or assembly) and the flow edges between them; see protocol.md."""
        return self._run(entry, timeoutSecs, job, ("graph",), self._graph)[0]

    @rpc(lane="decomp")
    def pcode(self, entry, timeoutSecs=30, job=None):
        """P-code of the function at `entry`: `raw` = Instruction.getPcode() per instruction (address order, keyed by the instruction's address),
        `high` = the decompiler's HighFunction ops in block order, each with the address of its instruction. Same lane, pool, cache and
        cancellation (cancel_decompile) as `decompile`: the high p-code is part of one decompile."""
        return self._run(entry, timeoutSecs, job, ("pcode",), self._pcode)[0]

    @rpc(lane="decomp")
    def value_trail(self, entry, name=None, line=None, colStart=None, timeoutSecs=30, job=None):
        """The value trail of a decompiler variable inside the function at `entry`: the p-code ops its value flows to (`forward`, downstream) and
        comes from (`backward`, upstream), and the C tokens of the same ops and varnodes, from Ghidra's own slice utilities
        (DecompilerUtils.getForward/BackwardSliceToPCodeOps and getForward/BackwardSlice). The seed is the varnode of the token at `line`/`colStart`
        (0-based, as in decompile's tokens) when given and the token has one, else every instance of the variable `name`. The slice stops at
        calls (the CALL op is in the forward slice, its result is not followed) and does not leave the function. Decompiler lane, cancellable
        with cancel_decompile, cached with the decompile cache (one entry per seed). NotFound: no function, or no such variable."""
        if name is not None:
            text_arg(name, "name")
        if line is not None and (isinstance(line, bool) or not isinstance(line, int) or line < 0 or isinstance(colStart, bool) or not isinstance(colStart, int) or colStart < 0):
            raise RpcError(INVALID, "line and colStart must be non-negative integers")
        if name is None and line is None:
            raise RpcError(INVALID, "name or line/colStart is required")
        return self._run(entry, timeoutSecs, job, ("trail", name, line, colStart), lambda prog, func, res: self._trail(prog, res, name, line, colStart))[0]

    def _trail(self, prog, res, name, line, col):
        from ghidra.app.decompiler import ClangVariableToken
        from ghidra.app.decompiler.component import DecompilerUtils
        from ghidra.program.model.pcode import PcodeOp
        from java.util import HashSet
        hf, fa = res.getHighFunction(), self.ses.fmtr(prog)
        toks, ln = [], 0  # (line, start, end, ClangToken), numbered exactly as _tokens does (lines of nothing but WARNING comments are not lines)
        for ln_toks in DecompilerUtils.toLines(res.getCCodeMarkup()):
            c, here, text = len(str(ln_toks.getIndentString())), [], str(ln_toks.getIndentString())
            for t in ln_toks.getAllTokens():
                n = len(str(t.getText()))
                text += str(t.getText())
                if str(t.getText()).strip():
                    here.append((ln, c, c + n, t))
                c += n
            if WARNING_LINE.fullmatch(text.strip()) and WARNING_ONE.findall(text):
                continue
            toks += here
            ln += 1
        seeds = []
        if line is not None:
            for ln, a, b, t in toks:
                if ln == line and a <= col < b:
                    vn = DecompilerUtils.getVarnodeRef(t)
                    if vn is not None:
                        seeds.append(vn)
                    elif name is None and t.getVarnode() is not None:
                        seeds.append(t.getVarnode())
                    break
        if not seeds and name is not None:
            for sym in hf.getLocalSymbolMap().getSymbols():
                hv = sym.getHighVariable()
                if hv is not None and str(sym.getName()) == name:
                    seeds.extend(hv.getInstances())
        if not seeds:
            raise RpcError(NOT_FOUND, "no variable %s at that place in the function" % (name or "(token)"))
        skip = (PcodeOp.MULTIEQUAL, PcodeOp.INDIRECT)
        vns = {"forward": HashSet(), "backward": HashSet()}
        ops = {"forward": HashSet(), "backward": HashSet()}
        for sd in seeds:
            vns["forward"].addAll(DecompilerUtils.getForwardSlice(sd))
            vns["backward"].addAll(DecompilerUtils.getBackwardSlice(sd))
            ops["forward"].addAll(DecompilerUtils.getForwardSliceToPCodeOps(sd))
            ops["backward"].addAll(DecompilerUtils.getBackwardSliceToPCodeOps(sd))
        seed_set = HashSet()
        for sd in seeds:
            seed_set.add(sd)
        out_ops, seen = [], set()
        for d in ("backward", "forward"):
            for op in ops[d]:
                if op.getOpcode() in skip:
                    continue
                k = (fa(op.getSeqnum().getTarget()), str(op.getMnemonic()), d)
                if k not in seen:
                    seen.add(k)
                    out_ops.append({"address": k[0], "op": k[1], "dir": d})
        out_ops.sort(key=lambda o: (akey(o["address"]), o["dir"], o["op"]))
        out_toks = []
        for ln, a, b, t in toks:
            vn, d = DecompilerUtils.getVarnodeRef(t), None
            if vn is not None:  # a variable (or parameter declaration): by its varnode
                d = "seed" if seed_set.contains(vn) else "forward" if vns["forward"].contains(vn) else "backward" if vns["backward"].contains(vn) else None
            elif not isinstance(t, ClangVariableToken):  # an operator or a call's name: by the op it belongs to
                op = t.getPcodeOp()
                if op is not None and op.getOpcode() not in skip:
                    d = "forward" if ops["forward"].contains(op) else "backward" if ops["backward"].contains(op) else None
            if d is not None:
                out_toks.append({"line": ln, "colStart": a, "colEnd": b, "dir": d})
        return {"ops": out_ops, "tokens": out_toks}

    @staticmethod
    def _vn(vn, lang):
        """One varnode as text: a register by name, a constant as hex, any other space as space[0xoffset]:size; a high variable's name follows."""
        if vn is None:
            return "_"
        a, size = vn.getAddress(), vn.getSize()
        if vn.isConstant():
            t = "0x%x" % (vn.getOffset() & ((1 << 64) - 1))
        elif vn.isRegister():
            r = lang.getRegister(a, size)
            t = str(r.getName()) if r is not None else "reg[0x%x]:%d" % (a.getOffset() & MASK64, size)
        else:
            off = a.getOffset()
            t = "%s[%s0x%x]:%d" % (a.getAddressSpace().getName(), "-" if off < 0 and a.getAddressSpace().isStackSpace() else "", abs(off) if off < 0 and a.getAddressSpace().isStackSpace() else off & MASK64, size)
        h = vn.getHigh() if hasattr(vn, "getHigh") else None
        n = h.getName() if h is not None else None
        return "%s (%s)" % (t, n) if n and str(n) != "UNNAMED" and not vn.isConstant() else t

    def _op(self, op, lang):
        out, ins = op.getOutput(), [self._vn(op.getInput(i), lang) for i in range(op.getNumInputs())]
        return ("%s = " % self._vn(out, lang) if out is not None else "") + "%s %s" % (op.getMnemonic(), ", ".join(ins))

    def _pcode(self, prog, func, res):
        """{raw: [{address, asm, ops[]}], high: [{block, address, text}], truncated}. High ops come from the decompile that is cached anyway."""
        fa, lang, hf = self.ses.fmtr(prog), prog.getLanguage(), res.getHighFunction()
        raw, n, cut = [], 0, False
        for ins in prog.getListing().getInstructions(func.getBody(), True):
            if len(raw) >= PCODE_MAX_INSNS or n >= PCODE_MAX_OPS:
                cut = True
                break
            ops = [self._op(o, lang) for o in ins.getPcode()]
            n += len(ops)
            raw.append({"address": fa(ins.getAddress()), "asm": str(ins), "ops": ops, "length": int(ins.getLength())})
        high, n = [], 0
        for bi, b in enumerate(hf.getBasicBlocks()):
            for op in b.getIterator():
                if n >= PCODE_MAX_OPS:
                    cut = True
                    break
                n += 1
                high.append({"block": bi, "address": fa(op.getSeqnum().getTarget()), "text": self._op(op, lang)})
        return {"raw": raw, "high": high, "truncated": cut}

    def _graph(self, prog, func, res):
        """Blocks: Ghidra's BasicBlockModel. C lines go to the block holding their first addressed token (lines without an address follow the
        previous line; the header before the first addressed line is dropped); a block that gets no C line shows its instructions.
        shortcut: a C line that spans several blocks is shown once, in its first; upgrade by splitting on token addresses."""
        from ghidra.program.model.block import BasicBlockModel
        from ghidra.util.task import TaskMonitor
        mon, fa, lst = TaskMonitor.DUMMY, self.ses.fmtr(prog), prog.getListing()
        model, body = BasicBlockModel(prog), func.getBody()
        blocks, it = [], model.getCodeBlocksContaining(body, mon)
        while it.hasNext() and len(blocks) < GRAPH_MAX_BLOCKS:
            blocks.append(it.next())
        blocks.sort(key=lambda b: akey(fa(b.getMinAddress())))
        starts = {fa(b.getMinAddress()): i for i, b in enumerate(blocks)}
        c_lines = [[] for _ in blocks]
        parsed = self._tokens(prog, res, keep_warnings=True)  # the graph has no warnings bar: the comments stay in the blocks
        first = {}
        for t in parsed["tokens"]:
            if "address" in t:
                first.setdefault(t["line"], t["address"])
        owner = None
        for ln, text in enumerate(parsed["text"].split("\n")):
            if ln in first:
                b = model.getFirstCodeBlockContaining(self.ses.addr(first[ln], prog), mon)
                owner = starts.get(fa(b.getMinAddress())) if b is not None else owner
            if owner is not None:
                c_lines[owner].append(text)
        out, edges = [], []
        for i, b in enumerate(blocks):
            asm = ["%s  %s" % (fa(x.getAddress()), x) for x in lst.getInstructions(b, True)][:GRAPH_MAX_LINES]
            out.append({"start": fa(b.getMinAddress()), "end": fa(b.getMaxAddress()), "kind": "c" if c_lines[i] else "asm", "lines": c_lines[i][:GRAPH_MAX_LINES] or asm})
            last = lst.getInstructionContaining(b.getMaxAddress())
            cond = last is not None and last.getFlowType().isConditional()
            seen, dests = set(), b.getDestinations(mon)
            while dests.hasNext():
                r = dests.next()
                to = fa(r.getDestinationAddress())
                if r.getFlowType().isCall() or to not in starts or to in seen:
                    continue
                seen.add(to)
                kind = "uncond" if not cond else "false" if r.getDestinationAddress().equals(b.getMaxAddress().next()) else "true"
                edges.append({"from": out[i]["start"], "to": to, "kind": kind})
        return {"blocks": out, "edges": edges}

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
            if job.cancelled or mon.isCancelled():  # cancelled while the result was being extracted: neither cache nor return it
                raise RpcError(CANCELLED, "decompile cancelled")
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

    def _tokens(self, prog, res, keep_warnings=False):
        from ghidra.app.decompiler import ClangFuncNameToken, ClangFieldToken, ClangLabelToken, ClangVariableToken
        from ghidra.app.decompiler.component import DecompilerUtils
        from ghidra.program.model.pcode import PcodeOp
        fm, fa, hf = prog.getFunctionManager(), self.ses.fmtr(prog), res.getHighFunction()
        lines_out, tokens, warnings, split_memo = [], [], [], {}
        # a non-fatal message of a completed decompile (empty when everything is fine), then the decompiler's own WARNING comments
        msg = str(res.getErrorMessage() or "").strip()
        if msg:
            warnings.append(msg)
        for line in DecompilerUtils.toLines(res.getCCodeMarkup()):
            ln = len(lines_out)
            line_tokens = []
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
                if kind in ("field", "variable", "param"):
                    u = union_of(t)
                    op = t.getPcodeOp()
                    if u is not None and op is not None:  # a field token has no address of its own: the access is named by its p-code op's instruction
                        tok["union"], tok["unionAt"] = str(u.getPathName()), fa(op.getSeqnum().getTarget())
                if kind == "const" and isinstance(t, ClangVariableToken):
                    vn = t.getVarnode()
                    if vn is not None and vn.isConstant() and 0 < vn.getSize() <= 8:  # an operand's scalar: Set Equate needs it
                        tok["constValue"], tok["constSize"] = str(vn.getOffset() & MASK64), int(vn.getSize())
                if kind in ("variable", "param"):
                    tok["varName"] = s
                    if self._splittable(t, split_memo):
                        tok["split"] = True
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
                line_tokens.append(tok)
            found = WARNING_LINE.fullmatch(text.strip()) and WARNING_ONE.findall(text)
            if found and not keep_warnings:  # a line of nothing but WARNING comments moves to `warnings` (shown once, above the code)
                warnings += [w for w in found if w not in warnings]
                continue
            tokens += line_tokens
            lines_out.append(text)
        out = {"text": "\n".join(lines_out), "tokens": tokens}
        if warnings:
            out["warnings"] = warnings[:WARNINGS_MAX]
        return out

    @staticmethod
    def _splittable(t, memo):
        """IsolateVariableAction's test: a local whose uses the decompiler merged from more than one merge group and that is not isolated yet."""
        from ghidra.program.model.pcode import HighLocal
        hv = t.getHighVariable()
        if not isinstance(hv, HighLocal) or hv.getSymbol() is None:
            return False
        key = str(hv.getSymbol().getName())
        if key not in memo:
            memo[key] = not hv.getSymbol().isIsolated() and len({v.getMergeGroup() for v in hv.getInstances()}) > 1
        return memo[key]

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

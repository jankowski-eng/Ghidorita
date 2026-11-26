"""Cross references: to an address, to a stack/register variable, from a code unit (thread R); function_calls and the call graph (scan lane, cancellable)."""
import time
from collections import deque

from ..core.args import akey, lim, ref_kind, text_arg
from ..core.errors import INVALID, NOT_FOUND, RpcError

from ..core.rpc import rpc

CALL_GRAPH_MAX_NODES = 300     # nodes in the answer
CALL_GRAPH_MAX_VISITED = 20000  # functions whose callers/callees were read: bounds the traversal itself (a route search walks backward over the whole program)
CALL_GRAPH_MAX_SECS = 30.0      # wall-clock bound of one call_graph


class _Bound(Exception):
    """A call_graph traversal bound was hit: what was found so far is returned with truncated."""


class Xrefs:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    def _xref_to_item(self, fm, r):
        fa = r.getFromAddress()
        rt = r.getReferenceType()
        o = {"from": self.ses.fmt(fa), "type": str(rt.getName()), "kind": ref_kind(rt)}
        f = fm.getFunctionContaining(fa)
        if f is not None:
            o["function"] = str(f.getName())
        return o

    @rpc(lane="R")
    def xrefs_to(self, address, limit=500):
        """Memory references to `address` (calls, jumps, data reads/writes, pointers). Stack/register references target variables: see xrefs_to_variable."""
        prog = self.ses.need()
        limit, a, out = lim(limit, 500, 10000), self.ses.addr(address), []
        fm = prog.getFunctionManager()
        for r in prog.getReferenceManager().getReferencesTo(a):
            if len(out) >= limit:
                break
            out.append(self._xref_to_item(fm, r))
        out.sort(key=lambda o: akey(o["from"]))
        return out

    @rpc(lane="R")
    def xrefs_to_variable(self, entry, name, limit=500):
        """References to a stack or register variable of the function at `entry` that the program has (a parameter or a stack local such as
        `param_1`, `local_10`, or one the user renamed), found by name. A variable the decompiler invents (`iVar1`, a register temporary)
        has no program variable: the result is empty."""
        prog = self.ses.need()
        text_arg(name, "name")
        limit, out = lim(limit, 500, 10000), []
        fm = prog.getFunctionManager()
        f = fm.getFunctionAt(self.ses.addr(entry))
        if f is None:
            raise RpcError(NOT_FOUND, "no function at %s" % entry)
        for v in f.getAllVariables():
            if str(v.getName()) == name:
                for r in prog.getReferenceManager().getReferencesTo(v):
                    if len(out) < limit:
                        out.append(self._xref_to_item(fm, r))
                break
        out.sort(key=lambda o: akey(o["from"]))
        return out

    @rpc(lane="scan")
    def function_calls(self, entry, scan=None):
        """Callers and callees of the function at `entry` (Function.getCallingFunctions / getCalledFunctions). Each is {name, entry, external, thunk, target?}:
        `entry` is null for an external function (not navigable); a thunk carries `target`, the function it finally forwards to (the same fields
        without `thunk`), so a client can show `_printf` and `printf` together. Memory entries ascending, externals last by name. NotFound if no
        function at `entry`. Cancellable like the other scans.
        shortcut: no cap on the lists and no call-site addresses (Ghidra's calls-API has none); upgrade with xrefs_to when a site list is needed."""
        with self.ctx.lanes.scanning(scan) as prog:
            f = prog.getFunctionManager().getFunctionAt(self.ses.addr(entry, prog))
            if f is None:
                raise RpcError(NOT_FOUND, "no function at %s" % entry)
            fa = self.ses.fmtr(prog)

            def ref(g):
                ext = bool(g.isExternal())
                return {"name": str(g.getName()), "entry": None if ext else fa(g.getEntryPoint()), "external": ext}

            def item(g):
                o = ref(g)
                o["thunk"] = bool(g.isThunk())
                if o["thunk"]:
                    t = g.getThunkedFunction(True)
                    if t is not None:
                        o["target"] = ref(t)
                return o
            key = lambda o: (o["external"], akey(o["entry"]) if o["entry"] else 0, o["name"])
            return {"callers": sorted((item(g) for g in scan.java(f.getCallingFunctions)), key=key),
                    "callees": sorted((item(g) for g in scan.java(f.getCalledFunctions)), key=key)}

    @rpc(lane="R")
    def xrefs_from(self, address):
        prog = self.ses.need()
        a = self.ses.addr(address)
        cu = prog.getListing().getCodeUnitContaining(a)
        a = cu.getMinAddress() if cu is not None else a
        out = []
        for r in prog.getReferenceManager().getReferencesFrom(a):
            rt = r.getReferenceType()
            o = {"type": str(rt.getName()), "kind": ref_kind(rt)}
            if r.isStackReference():
                off = int(r.getStackOffset())
                o.update(to=None, target="stack", label="Stack[%s0x%x]" % ("-" if off < 0 else "", abs(off)))
            elif r.isExternalReference():
                o.update(to=None, target="external", label=str(r.getLabel()))
            elif r.isRegisterReference():
                o.update(to=None, target="register", label=str(prog.getRegister(r.getToAddress()) or r.getToAddress()))
            else:
                o.update(to=self.ses.fmt(r.getToAddress()), target="memory")
            out.append(o)
        return out

    # ---- call graph ----

    def _is_import(self, f):
        """An external function, or a thunk (stub) to one: shown as a leaf, never expanded."""
        if f.isExternal():
            return True
        t = f.getThunkedFunction(True) if f.isThunk() else None
        return t is not None and t.isExternal()

    def _callees(self, prog, f, scan):
        """{called function: number of call sites in f}; empty for an import. Checks `scan` while it reads (a huge function)."""
        out = {}
        if self._is_import(f):
            return out
        fm, rm = prog.getFunctionManager(), prog.getReferenceManager()
        it, n = rm.getReferenceSourceIterator(f.getBody(), True), 0
        while it.hasNext():
            n += 1
            if n & 255 == 0:
                scan.check()
            for r in rm.getReferencesFrom(it.next()):
                if not r.getReferenceType().isCall():
                    continue
                t = fm.getFunctionAt(r.getToAddress()) or fm.getReferencedFunction(r.getToAddress())
                if t is not None:
                    out[t] = out.get(t, 0) + 1
        return out

    def _callers(self, prog, f, scan):
        """{calling function: number of call sites to f's entry}."""
        out, fm = {}, prog.getFunctionManager()
        for n, r in enumerate(prog.getReferenceManager().getReferencesTo(f.getEntryPoint())):
            if n & 255 == 0:
                scan.check()
            if r.getReferenceType().isCall():
                c = fm.getFunctionContaining(r.getFromAddress())
                if c is not None:
                    out[c] = out.get(c, 0) + 1
        return out

    @rpc(lane="scan")
    def call_graph(self, entry, depth=2, to=None, maxDepth=10, scan=None):
        """Without `to`: the functions within `depth` calls of `entry`, callers above and callees below. With `to`: every route from `entry` to
        `to` of at most `maxDepth` calls (the union of all such paths). Imports (external functions and thunks to them) are leaves.
        Routes longer than the shortest one plus one call are left out, so the answer is the few real alternatives, not most of the program.
        Edges carry `sites`, the number of call instructions. At most CALL_GRAPH_MAX_NODES nodes in the answer, and the traversal itself reads at
        most CALL_GRAPH_MAX_VISITED functions within CALL_GRAPH_MAX_SECS; `truncated` says a bound hit and the answer may be incomplete.
        Scan lane: cancellable with cancel_search (Cancelled), never delays listing_rows, save or close."""
        with self.ctx.lanes.scanning(scan) as prog:
            return self._call_graph(prog, entry, depth, to, maxDepth, scan)

    def _call_graph(self, prog, entry, depth, to, maxDepth, scan):
        depth, maxDepth = lim(depth, 2, 6), lim(maxDepth, 10, 30)
        fm, visited, deadline = prog.getFunctionManager(), 0, time.monotonic() + CALL_GRAPH_MAX_SECS
        def visit(step, f):
            """The callers/callees of f, counted against the traversal bounds; checks for cancel first."""
            nonlocal visited
            scan.check()
            visited += 1
            if visited > CALL_GRAPH_MAX_VISITED or time.monotonic() > deadline:
                raise _Bound()
            return step(prog, f, scan)
        def func(a):
            f = fm.getFunctionAt(self.ses.addr(a, prog))
            if f is None:
                raise RpcError(NOT_FOUND, "no function at %s" % a)
            return f
        root = func(entry)
        key = lambda f: (str(f.getEntryPoint().getAddressSpace().getName()), f.getEntryPoint().getOffset())
        nodes, edges, truncated = {key(root): root}, {}, False
        def add(f):
            nonlocal truncated
            if key(f) in nodes:
                return True
            if len(nodes) >= CALL_GRAPH_MAX_NODES:
                truncated = True
                return False
            nodes[key(f)] = f
            return True
        def edge(a, b, n):
            if add(a) and add(b):
                edges[(key(a), key(b))] = n
        if to is not None and not isinstance(to, str):
            raise RpcError(INVALID, "to must be an address")
        target = func(to) if to is not None else None
        try:
            if target is None:
                for step, near in ((self._callees, lambda u, v, n: edge(u, v, n)), (self._callers, lambda u, v, n: edge(v, u, n))):
                    frontier, seen = [root], {key(root)}
                    for _ in range(depth):
                        nxt = []
                        for u in frontier:
                            for v, n in visit(step, u).items():
                                near(u, v, n)
                                if key(v) not in seen and key(v) in nodes:
                                    seen.add(key(v)); nxt.append(v)
                        frontier = nxt
            else:
                add(target)  # shown even when no route reaches it
                back, q = {key(target): 0}, deque([target])  # calls from each function to the target, along callers
                while q:
                    v = q.popleft()
                    if back[key(v)] >= maxDepth:
                        continue
                    for u in visit(self._callers, v):
                        if key(u) not in back:
                            back[key(u)] = back[key(v)] + 1
                            q.append(u)
                if key(root) in back:  # forward from the root, only through functions that can still reach the target in time
                    maxDepth = min(maxDepth, back[key(root)] + 1)  # the shortest route and those one call longer
                    fwd, q = {key(root): 0}, deque([root])
                    while q:
                        u = q.popleft()
                        for v, n in visit(self._callees, u).items():
                            d = fwd[key(u)] + 1
                            if key(v) in back and d + back[key(v)] <= maxDepth:
                                edge(u, v, n)
                                if key(v) not in fwd:
                                    fwd[key(v)] = d
                                    q.append(v)
        except _Bound:
            truncated = True  # shortcut: the route search keeps what it found, an unfinished backward walk may miss routes; upgrade: iterative deepening
        fmt = self.ses.fmtr(prog)
        out = [{"entry": fmt(f.getEntryPoint()), "name": str(f.getName()), "kind": "import" if self._is_import(f) else "function"} for f in nodes.values()]
        return {"nodes": out, "edges": [{"from": fmt(nodes[a].getEntryPoint()), "to": fmt(nodes[b].getEntryPoint()), "sites": n} for (a, b), n in edges.items()],
                "truncated": truncated}

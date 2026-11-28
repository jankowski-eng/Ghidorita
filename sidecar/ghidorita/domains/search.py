"""Slow reads on the scan workers (thread S): symbol search and table, strings, memory search; cancel_search on the loop.
They never run on R, so a long scan cannot delay listing fetches. Results are cached as snapshots until the program changes."""
import functools, json, threading
from collections import OrderedDict

from ..core import jscans
from ..core.args import lim, text_arg
from ..core.errors import CANCELLED, INVALID, RpcError
from ..core.rpc import rpc



class StaleRead(Exception):
    """A slow read met an object an edit deleted after its snapshot was taken."""


def retry_stale(fn):
    """A page read racing an edit: the snapshot is dropped by the edit's program_changed, so one retry sees fresh data. Twice stale in a row =
    a second edit raced it: documented Cancelled (protocol.md, Concurrency), the client refetches on program_changed anyway."""
    @functools.wraps(fn)
    def run(self, *a, **kw):
        try:
            return fn(self, *a, **kw)
        except StaleRead:
            self.snap_clear()
        try:
            return fn(self, *a, **kw)
        except StaleRead as e:
            raise RpcError(CANCELLED, "program changed while reading, retry: %s" % e)
    return run


class _SymSnap:
    """list_symbols default view: the live by-address iterator and the rows pulled from it so far."""
    def __init__(self, it, total):
        self.it, self.total, self.syms, self.lock = it, total, [], threading.Lock()


class Search:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session
        self.snaps = OrderedDict()   # (kind, ...) -> snapshot of a slow read, LRU; snap_lock. Dropped on any program change.
        self.snap_ver = 0
        self.snap_lock = threading.Lock()
        ctx.events.subscribe(lambda kinds, ranges, broad: self.snap_clear())

    def snap_clear(self):
        with self.snap_lock:
            self.snaps.clear()
            self.snap_ver += 1

    def snap(self, key, build):
        """Cached result of a slow read (LRU of 8). build() runs without locks, since it may take seconds; its result is stored only if
        the program did not change meanwhile. shortcut: two identical concurrent first requests both build; upgrade with a per-key future."""
        with self.snap_lock:
            hit = self.snaps.get(key)
            if hit is not None:
                self.snaps.move_to_end(key)
                return hit
            ver = self.snap_ver
        val = build()
        with self.snap_lock:
            if self.snap_ver == ver:
                self.snaps[key] = val
                while len(self.snaps) > 8:
                    self.snaps.popitem(last=False)
        return val

    @staticmethod
    def _sym_kind(prog, s):
        from ghidra.program.model.symbol import SymbolType
        t = s.getSymbolType()
        if t == SymbolType.FUNCTION:
            return "function"
        if t == SymbolType.LOCAL_VAR or t == SymbolType.PARAMETER:
            return "variable"
        if s.isExternal():
            return "external"
        if t == SymbolType.LABEL:
            d = prog.getListing().getDefinedDataAt(s.getAddress())
            return "data" if d is not None else "label"
        return "other"

    @rpc(lane="scan")
    def search_symbols(self, query, limit=100, exact=False, scan=None):
        """Name substring match (also a hex address: symbols there, else a bare hit if mapped). The match runs inside Ghidra
        (SymbolTable.getSymbolIterator with a glob, so `*`/`?` in the query are wildcards): only hits cross into Python.
        shortcut: Ghidra has no name index for substrings, so this is still a linear scan, in Java; upgrade with an in-sidecar index on > ~1M symbols.
        `exact=true` (capability exactSymbolSearch): the symbols named exactly `query` (case-sensitive, every namespace, memory addresses only), by address,
        through Ghidra's name index (SymbolTable.getSymbols(name)): every one of them is returned however many other symbols contain the text."""
        with self.ctx.lanes.scanning(scan) as prog:
            text_arg(query, "query")
            if not isinstance(exact, bool):
                raise RpcError(INVALID, "exact must be a boolean")
            limit = lim(limit, 100, 5000)
            st, out, seen, fa = prog.getSymbolTable(), [], set(), self.ses.fmtr(prog)
            refs = prog.getReferenceManager().getReferenceCountTo
            q = query.strip()
            if not q:
                return []
            if exact:
                found = [s for s in st.getSymbols(q) if s.getAddress().isMemoryAddress()]
                found.sort(key=lambda s: (str(s.getAddress().getAddressSpace().getName()), int(s.getAddress().getOffset()) & ((1 << 64) - 1)))
                return [{"name": str(s.getName()), "address": fa(s.getAddress()), "kind": self._sym_kind(prog, s), "refs": int(refs(s.getAddress()))} for s in found[:limit]]
            try:
                a = self.ses.addr(q if q.lower().startswith("0x") else "0x" + q, prog)
                if prog.getMemory().contains(a):
                    syms = list(st.getSymbols(a))
                    for s in syms:
                        out.append({"name": str(s.getName()), "address": fa(a), "kind": self._sym_kind(prog, s), "refs": int(refs(a))})
                    if not syms:
                        out.append({"name": fa(a), "address": fa(a), "kind": "other", "refs": int(refs(a))})
                    seen.update(o["name"] + o["address"] for o in out)
            except RpcError:
                pass
            n = 0
            for s in st.getSymbolIterator("*" + q + "*", False):
                if len(out) >= limit:
                    break
                n += 1
                if n & 255 == 0:
                    scan.check()
                a = s.getAddress()
                if not a.isMemoryAddress():
                    continue
                o = {"name": str(s.getName()), "address": fa(a), "kind": self._sym_kind(prog, s), "refs": int(refs(a))}
                if o["name"] + o["address"] not in seen:
                    out.append(o)
            return out[:limit]

    @rpc(lane="scan")
    def top_symbols(self, limit=30, scan=None):
        """What an empty command bar suggests: the program's entry points, then the `limit` most referenced imports (functions that thunk an
        external function) and the `limit` most referenced other functions, each by reference count to its entry (callers and other references)."""
        with self.ctx.lanes.scanning(scan) as prog:
            limit = lim(limit, 30, 500)
            st, rm, fa = prog.getSymbolTable(), prog.getReferenceManager(), self.ses.fmtr(prog)
            out, seen = [], set()
            for a in st.getExternalEntryPointIterator():
                sym = st.getPrimarySymbol(a)
                if sym is not None and a.isMemoryAddress():
                    seen.add(fa(a))
                    out.append({"name": str(sym.getName()), "address": fa(a), "kind": self._sym_kind(prog, sym), "refs": int(rm.getReferenceCountTo(a)), "group": "entry"})
            groups = {"import": [], "function": []}
            for n, f in enumerate(prog.getFunctionManager().getFunctions(True)):
                if n & 255 == 0:
                    scan.check()
                a = f.getEntryPoint()
                if f.isExternal() or not a.isMemoryAddress() or fa(a) in seen:
                    continue
                th = f.getThunkedFunction(True) if f.isThunk() else None
                groups["import" if th is not None and th.isExternal() else "function"].append((int(rm.getReferenceCountTo(a)), str(f.getName()), fa(a)))
            for g, rows in groups.items():
                rows.sort(key=lambda r: -r[0])
                out += [{"name": n, "address": a, "kind": "function", "refs": r, "group": g} for r, n, a in rows[:limit] if r > 0]
            return out

    SYM_SORTS = ("name", "address", "kind", "namespace", "source")

    SYM_KINDS = ("function", "label", "data", "external", "variable", "other")

    SOURCES = {"USER_DEFINED": "user", "ANALYSIS": "analysis", "IMPORTED": "imported", "DEFAULT": "default"}

    def _sym_item(self, prog, s):
        a, ns = s.getAddress(), s.getParentNamespace()
        return {"name": str(s.getName()), "address": self.ses.fmt(a, prog) if a.isMemoryAddress() else None, "kind": self._sym_kind(prog, s),
                "namespace": "" if ns.isGlobal() else str(ns.getName(True)), "source": self.SOURCES.get(str(s.getSource()), "other")}

    @rpc(lane="scan")
    @retry_stale
    def list_symbols(self, offset=0, limit=100, query="", kinds=None, sort="address", desc=False, scan=None):
        """One page of the symbol table, in `sort` order. `total` counts all rows after the filters.
        Default view (address order, no filter): the Ghidra by-address iterator is advanced lazily and kept, so page 1 costs `limit` rows
        and total is counted once inside Java. Any filter or other order builds a snapshot of the Java Symbol objects once (cached until the program
        changes): the name filter runs inside Ghidra (glob iterator), kinds and sort keys cost a few calls per symbol.
        shortcut: a deep offset in the default view walks the iterator from where it stopped; upgrade with getSymbolIterator(address) from a sampled index."""
        with self.ctx.lanes.scanning(scan) as prog:
            offset, limit = lim(offset, 0), lim(limit, 100, 1000)
            text_arg(query, "query")
            if sort not in self.SYM_SORTS:
                raise RpcError(INVALID, "sort must be one of %s" % ", ".join(self.SYM_SORTS))
            if kinds is None:
                kinds = []
            if not isinstance(kinds, list) or any(k not in self.SYM_KINDS for k in kinds):
                raise RpcError(INVALID, "kinds must be a list of %s" % ", ".join(self.SYM_KINDS))
            q, desc, kinds = query.strip(), bool(desc), tuple(sorted(set(kinds)))
            st = prog.getSymbolTable()
            if sort == "address" and not desc and not q and not kinds:
                def lazy():  # getNumSymbols() also counts variable symbols the by-address iterator skips, so count inside Java (Guava)
                    from com.google.common.collect import Iterators
                    return _SymSnap(st.getSymbolIterator(True), int(Iterators.size(st.getSymbolIterator(True))))
                sn = self.snap(("sym-lazy",), lazy)
                with sn.lock:
                    n = 0
                    while len(sn.syms) < offset + limit and sn.it is not None:
                        if sn.it.hasNext():
                            sn.syms.append(sn.it.next())
                        else:
                            sn.it, sn.total = None, len(sn.syms)
                        n += 1
                        if n & 255 == 0:
                            scan.check()
                    syms, total = sn.syms[offset:offset + limit], sn.total
            else:
                scans = jscans.scans()
                mask = sum(1 << self.SYM_KINDS.index(k) for k in kinds)  # K_FUNCTION=1, K_LABEL=2, ... in SYM_KINDS order
                build = lambda: scan.java(scans.symbols, prog, q, mask, sort)  # filter + sort inside Java, GIL released
                full = self.snap(("sym", q.lower(), kinds, sort), build)
                total = len(full)
                syms = scans.slice(full, offset, limit, desc)
            try:
                items = [self._sym_item(prog, s) for s in syms]
            except Exception as e:  # noqa  a symbol of a stale snapshot was deleted by an edit meanwhile
                raise StaleRead(str(e))
            return {"total": total, "items": items}

    @rpc(lane="scan")
    def list_strings(self, offset=0, limit=500, minLength=4, query="", referencedOnly=False, scan=None):
        """Defined strings in address order. The full scan is cached per `minLength` until the next program change (first call on a
        big binary takes seconds, on a scan worker); `query` is a case-insensitive substring filter over the cached values; `total` is the
        count after the filters. `referencedOnly` keeps strings something references. Each item has `refs` (reference count) and, when refs > 0,
        `refFrom` (the first 3 referencing addresses with their function). Values are cut at 1000 UTF-16 units, `length` stays the byte length of the defined string.
        shortcut: one full scan per minLength (in Java, GIL released), upgrade to an index or lazy paging on huge binaries."""
        with self.ctx.lanes.scanning(scan) as prog:
            offset, limit, minLength = lim(offset, 0), lim(limit, 500, 5000), lim(minLength, 4)
            text_arg(query, "query")
            scans = jscans.scans()
            strings = self.snap(("str", minLength), lambda: scan.java(scans.strings, prog, minLength))  # Java object: the 164k values stay in the JVM
            # the query filter runs in Java too (it keeps the hits of the last query, so paging a query is cheap); not part of the snapshot key
            if not isinstance(referencedOnly, bool):
                raise RpcError(INVALID, "referencedOnly must be a boolean")
            page = json.loads(str(strings.page(offset, limit, query.strip().lower(), referencedOnly)))
            fm, rm = prog.getFunctionManager(), prog.getReferenceManager()
            for it in page["items"]:
                if it["refs"] > 0:
                    it["refFrom"] = self._ref_from(fm, rm, self.ses.addr(it["address"]))
            return page

    def _ref_from(self, fm, rm, a, n=3):
        """The first `n` references to `a` as {from, function?} (shortcut: the first Ghidra returns, not the lowest addresses; xrefs_to has the full list)."""
        out = []
        for r in rm.getReferencesTo(a):
            fa = r.getFromAddress()
            o = {"from": self.ses.fmt(fa)}
            f = fm.getFunctionContaining(fa)
            if f is not None:
                o["function"] = str(f.getName())
            out.append(o)
            if len(out) >= n:
                break
        return out

    @rpc(lane="scan")
    def list_undefined_refs(self, offset=0, limit=500, scan=None):
        """Data references (read, write, pointer) whose target is undefined bytes: initialized memory where the code unit is neither an instruction nor
        defined data. Calls and jumps are not listed. Items are in target order, then referring address: {address (target), type, from, function?}.
        The full scan is cached until the next program change (a scan worker, cancellable with cancel_search); `total` counts every reference."""
        with self.ctx.lanes.scanning(scan) as prog:
            offset, limit = lim(offset, 0), lim(limit, 500, 5000)
            items = self.snap(("undef",), lambda: self._undefined_refs(prog, scan))
            return {"total": len(items), "items": items[offset:offset + limit]}

    def _undefined_refs(self, prog, scan):
        from ghidra.program.model.listing import Instruction
        rm, lst, fm, fa = prog.getReferenceManager(), prog.getListing(), prog.getFunctionManager(), self.ses.fmtr(prog)
        out, n = [], 0
        dests = rm.getReferenceDestinationIterator(prog.getMemory().getAllInitializedAddressSet(), True)
        while dests.hasNext():
            n += 1
            if n & 255 == 0:
                scan.check()
            a = dests.next()
            cu = lst.getCodeUnitContaining(a)
            if cu is None or isinstance(cu, Instruction) or cu.isDefined():
                continue
            refs = []
            for r in rm.getReferencesTo(a):  # a target can have very many references: check for cancellation while collecting, too
                scan.check()
                if not r.getReferenceType().isFlow():
                    refs.append(r)
            refs.sort(key=lambda r: r.getFromAddress().getOffset() & 0xFFFFFFFFFFFFFFFF)
            for r in refs:
                scan.check()
                t = r.getReferenceType()
                kind = "readwrite" if t.isRead() and t.isWrite() else "read" if t.isRead() else "write" if t.isWrite() else "pointer"
                item = {"address": fa(a), "type": kind, "from": fa(r.getFromAddress())}
                f = fm.getFunctionContaining(r.getFromAddress())
                if f is not None:
                    item["function"] = str(f.getName())
                out.append(item)
        scan.check()  # a cancelled scan never reports success, however few destinations it had
        return out

    MEM_ENCODINGS = {"ascii": "US_ASCII", "utf16le": "UTF_16LE", "utf16be": "UTF_16BE"}

    @rpc(lane="scan")
    def search_memory(self, pattern, kind="bytes", encoding="ascii", caseSensitive=True, start=None, limit=1000, scan=None):
        """Ghidra's memory search (ghidra.features.base.memsearch: UserInputByteMatcher + MemorySearcher, what the GUI's Search Memory uses) over
        the loaded, initialized address set, ascending, from `start` (default: the first address). kind "bytes": hex with wildcards ("48 8b ?? 24",
        `?`/`.` = any nibble pair); kind "text": a string in `encoding`. One page = up to `limit` matches; `next` is where to continue
        (null = the whole set is done). Cancellable with cancel_search; a cancelled page fails with Cancelled and returns nothing."""
        with self.ctx.lanes.scanning(scan) as prog:
            from java.nio.charset import StandardCharsets
            from ghidra.features.base.memsearch.bytesource import ProgramByteSource
            from ghidra.features.base.memsearch.format import SearchFormat
            from ghidra.features.base.memsearch.gui import SearchSettings
            from ghidra.features.base.memsearch.searcher import MemorySearcher
            from ghidra.program.model.address import AddressSet
            from ghidra.pyghidra import PyGhidraTaskMonitor
            from ghidra.util.datastruct import ListAccumulator
            text_arg(pattern, "pattern")
            if kind not in ("bytes", "text"):
                raise RpcError(INVALID, "kind must be bytes or text")
            if encoding not in self.MEM_ENCODINGS:
                raise RpcError(INVALID, "encoding must be one of %s" % ", ".join(self.MEM_ENCODINGS))
            limit = lim(limit, 1000, 10000)
            if limit < 1 or not pattern.strip():
                raise RpcError(INVALID, "empty pattern or limit < 1")
            st = SearchSettings().withSearchFormat(SearchFormat.HEX if kind == "bytes" else SearchFormat.STRING)
            if kind == "text":
                st = st.withStringCharset(getattr(StandardCharsets, self.MEM_ENCODINGS[encoding])).withCaseSensitive(bool(caseSensitive))
            matcher = st.getSearchFormat().parse(pattern.strip(), st)
            if not matcher.isValidSearch():
                raise RpcError(INVALID, "invalid pattern: %s" % matcher.getDescription())
            mem = prog.getMemory()
            sset = AddressSet(mem.getLoadedAndInitializedAddressSet())
            if start is not None:
                a = self.ses.addr(start, prog)
                sset = sset.intersect(AddressSet(a, a.getAddressSpace().getMaxAddress()))
            mon = PyGhidraTaskMonitor(None, None)
            scan.mon = mon
            if scan.cancelled:
                mon.cancel()
            acc = ListAccumulator()
            done = MemorySearcher(ProgramByteSource(prog), matcher, sset, limit).findAll(acc, mon)
            scan.check()
            fm, items, last, fa = prog.getFunctionManager(), [], None, self.ses.fmtr(prog)
            for m in acc.get():
                ad, b = m.getAddress(), m.getBytes()
                o = {"address": fa(ad), "length": int(m.getLength()), "bytes": " ".join("%02x" % (x & 255) for x in b[:16])}
                f = fm.getFunctionContaining(ad)
                if f is not None:
                    o["function"] = str(f.getName())
                items.append(o)
                last = ad
            return {"items": items, "next": None if done or last is None else fa(last.next() or last)}

    @rpc(lane="loop")
    def cancel_search(self, id):
        """Cancel the scan request (list_symbols, list_strings, search_symbols, search_memory) with this JSON-RPC id, queued or running. False if unknown/finished."""
        sc = self.ctx.lanes.sj.get(id)
        if sc is None:
            return {"cancelled": False}
        with self.ctx.lanes.mon_lock:
            sc.cancel()
        return {"cancelled": True}

"""Slow reads on the scan workers (thread S): symbol search and table, strings, memory search; cancel_search on the loop.
They never run on R, so a long scan cannot delay listing fetches. Results are cached as snapshots until the program changes."""
import threading
from collections import OrderedDict

from ..core.args import hx, lim, text_arg
from ..core.errors import CANCELLED, INVALID, RpcError
from ..core.rpc import rpc

STRING_VALUE_CAP = 1000


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
    def search_symbols(self, query, limit=100, scan=None):
        """Name substring match (also a hex address: symbols there, else a bare hit if mapped). The match runs inside Ghidra
        (SymbolTable.getSymbolIterator with a glob, so `*`/`?` in the query are wildcards): only hits cross into Python.
        shortcut: Ghidra has no name index for substrings, so this is still a linear scan, in Java; upgrade with an in-sidecar index on > ~1M symbols."""
        with self.ctx.lanes.scanning(scan) as prog:
            text_arg(query, "query")
            limit = lim(limit, 100, 5000)
            st, out, seen, space = prog.getSymbolTable(), [], set(), prog.getAddressFactory().getDefaultAddressSpace()
            q = query.strip()
            if not q:
                return []
            try:
                a = self.ses.addr(q if q.lower().startswith("0x") else "0x" + q, prog)
                if prog.getMemory().contains(a):
                    syms = list(st.getSymbols(a))
                    for s in syms:
                        out.append({"name": str(s.getName()), "address": hx(a.getOffset()), "kind": self._sym_kind(prog, s)})
                    if not syms:
                        out.append({"name": hx(a.getOffset()), "address": hx(a.getOffset()), "kind": "other"})
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
                if a.isExternalAddress() or a.getAddressSpace() != space:
                    continue
                o = {"name": str(s.getName()), "address": hx(a.getOffset()), "kind": self._sym_kind(prog, s)}
                if o["name"] + o["address"] not in seen:
                    out.append(o)
            return out[:limit]

    SYM_SORTS = ("name", "address", "kind", "namespace", "source")

    SYM_KINDS = ("function", "label", "data", "external", "variable", "other")

    SOURCES = {"USER_DEFINED": "user", "ANALYSIS": "analysis", "IMPORTED": "imported", "DEFAULT": "default"}

    def _sym_item(self, prog, s):
        a, ns = s.getAddress(), s.getParentNamespace()
        mem = a.isMemoryAddress() and a.getAddressSpace() == prog.getAddressFactory().getDefaultAddressSpace()  # shortcut: default space only
        return {"name": str(s.getName()), "address": hx(a.getOffset()) if mem else None, "kind": self._sym_kind(prog, s),
                "namespace": "" if ns.isGlobal() else str(ns.getName(True)), "source": self.SOURCES.get(str(s.getSource()), "other")}

    def _sym_key(self, prog, s, sort):
        name = str(s.getName()).lower()
        if sort == "name":
            return name
        if sort == "address":
            a = s.getAddress()
            return a.getOffset() if a.isMemoryAddress() else -1
        if sort == "kind":
            return (self._sym_kind(prog, s), name)
        if sort == "namespace":
            ns = s.getParentNamespace()
            return ("" if ns.isGlobal() else str(ns.getName(True)).lower(), name)
        return (self.SOURCES.get(str(s.getSource()), "other"), name)

    @rpc(lane="scan")
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
                def build():
                    it = st.getSymbolIterator("*" + q + "*", False) if q else st.getSymbolIterator(True)
                    out, n = [], 0
                    for s in it:
                        n += 1
                        if n & 255 == 0:
                            scan.check()
                        if kinds and self._sym_kind(prog, s) not in kinds:
                            continue
                        out.append(s)
                    if sort == "address" and not q:  # the iterator already is in address order
                        return out
                    keys = []
                    for i, s in enumerate(out):
                        if i & 255 == 0:
                            scan.check()
                        keys.append(self._sym_key(prog, s, sort))
                    return [out[i] for i in sorted(range(len(out)), key=keys.__getitem__)]
                full = self.snap(("sym", q.lower(), kinds, sort), build)
                total = len(full)
                syms = (full[::-1] if desc else full)[offset:offset + limit]
            try:
                items = [self._sym_item(prog, s) for s in syms]
            except Exception as e:  # noqa  a symbol of a stale snapshot was deleted by an edit meanwhile
                raise RpcError(CANCELLED, "program changed while reading symbols: %s" % e)
            return {"total": total, "items": items}

    def _scan_strings(self, prog, minLength, scan):
        from ghidra.program.util import DefinedStringIterator
        from ghidra.program.model.data import StringDataInstance
        items = []
        for d in DefinedStringIterator.forProgram(prog):
            if len(items) & 255 == 0:
                scan.check()
            v = d.getValue()  # the String for string data types; the StringDataInstance is the fallback (e.g. a pointer-typed string)
            if not isinstance(v, str):
                v = StringDataInstance.getStringDataInstance(d).getStringValue()
            if v is not None:
                v = str(v)
                if len(v) >= minLength:
                    items.append({"address": hx(d.getMinAddress().getOffset()), "value": v[:STRING_VALUE_CAP], "length": int(d.getLength())})
        return items

    @rpc(lane="scan")
    def list_strings(self, offset=0, limit=500, minLength=4, query="", scan=None):
        """Defined strings in address order. The full scan is cached per `minLength` until the next program change (first call on a
        big binary takes seconds, on a scan worker); `query` is a case-insensitive substring filter over the cached values; `total` is the
        count after both filters. Values are cut at 1000 UTF-16 units, `length` stays the byte length of the defined string.
        shortcut: one full scan per minLength, upgrade to an index or lazy paging on huge binaries."""
        with self.ctx.lanes.scanning(scan) as prog:
            offset, limit, minLength = lim(offset, 0), lim(limit, 500, 5000), lim(minLength, 4)
            text_arg(query, "query")
            items = self.snap(("str", minLength), lambda: self._scan_strings(prog, minLength, scan))
            q = query.strip().lower()
            if q:
                items = [i for i in items if q in i["value"].lower()]  # not cached: one snapshot per typed prefix would evict the symbol snapshots from the LRU
            return {"total": len(items), "items": items[offset:offset + limit]}

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
            fm, items, last = prog.getFunctionManager(), [], None
            for m in acc.get():
                ad, b = m.getAddress(), m.getBytes()
                o = {"address": hx(ad.getOffset()), "length": int(m.getLength()), "bytes": " ".join("%02x" % (x & 255) for x in b[:16])}
                f = fm.getFunctionContaining(ad)
                if f is not None:
                    o["function"] = str(f.getName())
                items.append(o)
                last = ad
            return {"items": items, "next": None if done or last is None else hx(last.getOffset() + 1)}

    @rpc(lane="loop")
    def cancel_search(self, id):
        """Cancel the scan request (list_symbols, list_strings, search_symbols, search_memory) with this JSON-RPC id, queued or running. False if unknown/finished."""
        sc = self.ctx.lanes.sj.get(id)
        if sc is None:
            return {"cancelled": False}
        with self.ctx.lanes.mon_lock:
            sc.cancel()
        return {"cancelled": True}

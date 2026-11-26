"""Bookmarks (Ghidra's BookmarkManager): list them all (analyzers create many: Analysis, Error, Warning, Info), set and remove the user's own (type Note)."""
import threading

from ..core.args import akey, lim, text_arg
from ..core.errors import INVALID, NOT_FOUND, RpcError
from ..core.rpc import rpc

NOTE = "Note"
SORTS = ("address", "type", "category")


class Bookmarks:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session
        self.snap, self.snap_ver, self.snap_lock = None, 0, threading.Lock()  # (counts, items) of list_bookmarks; dropped on any program change
        ctx.events.subscribe(lambda kinds, ranges, broad: self._drop())

    def _drop(self):
        with self.snap_lock:
            self.snap, self.snap_ver = None, self.snap_ver + 1

    def _snapshot(self, prog, scan):
        """Every memory bookmark as plain dicts plus the per-type counts, built once per program state (dropped on program_changed, like the
        symbol/string snapshots in search.py). Plain Python values: nothing in it can go stale under a racing edit."""
        with self.snap_lock:
            hit, ver = self.snap, self.snap_ver
        if hit is not None:
            return hit
        fa, counts, items = self.ses.fmtr(prog), {}, []
        for n, b in enumerate(prog.getBookmarkManager().getBookmarksIterator()):
            if n & 255 == 0:
                scan.check()
            t = str(b.getTypeString())
            counts[t] = counts.get(t, 0) + 1
            if b.getAddress().isMemoryAddress():
                items.append({"address": fa(b.getAddress()), "type": t, "category": str(b.getCategory() or ""), "comment": str(b.getComment() or "")})
        built = (counts, items)
        with self.snap_lock:
            if self.snap_ver == ver:  # the program did not change while it was built
                self.snap = built
        return built

    @rpc(lane="scan")
    def list_bookmarks(self, type=None, query=None, offset=0, limit=100, sort="address", desc=False, scan=None):
        """One page of the program's bookmarks: {total, types[{type, count}], items[{address, type, category, comment}]}. `type` keeps one bookmark type
        (omitted = every type), `query` is a case-insensitive substring of category or comment, `sort` address|type|category (ties by address).
        `types` counts every type present before any filter, for a filter control. Lane scan (cancellable with cancel_search): one pass over the
        bookmark table builds a snapshot that is reused until the next program_changed; filter and sort run per page on the snapshot."""
        if type is not None:
            text_arg(type, "type")
        if query is not None:
            text_arg(query, "query")
        if sort not in SORTS or not isinstance(desc, bool):
            raise RpcError(INVALID, "bad sort")
        offset, limit = lim(offset, 0), lim(limit, 100, 1000)
        with self.ctx.lanes.scanning(scan) as prog:
            counts, all_items = self._snapshot(prog, scan)
            q = (query or "").lower()
            items = [o for o in all_items if (type is None or o["type"] == type) and (not q or q in o["category"].lower() or q in o["comment"].lower())]
            scan.check()
            key = {"address": lambda o: (akey(o["address"]), o["type"], o["category"]),
                   "type": lambda o: (o["type"].lower(), akey(o["address"]), o["category"]),
                   "category": lambda o: (o["category"].lower(), akey(o["address"]), o["type"])}[sort]
            items.sort(key=key, reverse=desc)
            return {"total": len(items), "types": [{"type": t, "count": n} for t, n in sorted(counts.items())], "items": items[offset:offset + limit]}

    @rpc(lane="R")
    def set_bookmark(self, address, category, comment):
        """A Note bookmark at the code unit containing `address`; the same address and category replaces the comment (Ghidra keeps one bookmark per address, type and category). One undo step "Set bookmark"."""
        text_arg(category, "category")
        text_arg(comment, "comment")
        prog = self.ses.need()
        a = self.ses.addr(address, prog)
        if not prog.getMemory().contains(a):
            raise RpcError(INVALID, "address %s is not in memory" % address)
        cu = prog.getListing().getCodeUnitContaining(a)
        lo = cu.getMinAddress() if cu is not None else a
        self.ses.edit("Set bookmark", lambda p: p.getBookmarkManager().setBookmark(lo, NOTE, category, comment))
        self.ctx.events.record({"bookmark"}, [self.ses.rng(lo, lo)])
        return {}

    @rpc(lane="R")
    def remove_bookmark(self, address, type, category=None):
        """Removes the bookmark of `type` and `category` at `address` (a panel row is exactly that triple); one undo step "Remove bookmark".
        `category` omitted = every category of that type at that address (an explicit "remove all here" action, never the default of a row).
        NotFound if there is none."""
        text_arg(type, "type")
        if category is not None:
            text_arg(category, "category")
        prog = self.ses.need()
        a = self.ses.addr(address, prog)
        bm = prog.getBookmarkManager()
        found = list(bm.getBookmarks(a, type)) if category is None else [b for b in [bm.getBookmark(a, type, category)] if b is not None]
        if not found:
            raise RpcError(NOT_FOUND, "no %s bookmark at %s%s" % (type, address, "" if category is None else " in category %r" % category))
        self.ses.edit("Remove bookmark", lambda p: [p.getBookmarkManager().removeBookmark(b) for b in found])
        self.ctx.events.record({"bookmark"}, [self.ses.rng(a, a)])
        return {}

"""Bookmarks (Ghidra's BookmarkManager): list them all (analyzers create many: Analysis, Error, Warning, Info), set and remove the user's own (type Note)."""
from ..core.args import akey, lim, text_arg
from ..core.errors import INVALID, NOT_FOUND, RpcError
from ..core.rpc import rpc

NOTE = "Note"
SORTS = ("address", "type", "category")


class Bookmarks:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    @rpc(lane="R")
    def list_bookmarks(self, type=None, query=None, offset=0, limit=100, sort="address", desc=False):
        """One page of the program's bookmarks: {total, types[{type, count}], items[{address, type, category, comment}]}. `type` keeps one bookmark type
        (omitted = every type), `query` is a case-insensitive substring of category or comment, `sort` address|type|category (ties by address).
        `types` counts every type present before any filter, for a filter control. Lane R: one pass over the bookmark table.
        shortcut: a full pass per call (the table is small next to the listing; analyzers make thousands, not millions), upgrade with a snapshot cache like list_symbols."""
        if type is not None:
            text_arg(type, "type")
        if query is not None:
            text_arg(query, "query")
        if sort not in SORTS or not isinstance(desc, bool):
            raise RpcError(INVALID, "bad sort")
        offset, limit = lim(offset, 0), lim(limit, 100, 1000)
        prog = self.ses.need()
        fa, q = self.ses.fmtr(prog), (query or "").lower()
        counts, items = {}, []
        for b in prog.getBookmarkManager().getBookmarksIterator():
            t = str(b.getTypeString())
            counts[t] = counts.get(t, 0) + 1
            if (type is not None and t != type) or not b.getAddress().isMemoryAddress():
                continue
            cat, com = str(b.getCategory() or ""), str(b.getComment() or "")
            if q and q not in cat.lower() and q not in com.lower():
                continue
            items.append({"address": fa(b.getAddress()), "type": t, "category": cat, "comment": com})
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
    def remove_bookmark(self, address, type):
        """Removes every bookmark of `type` (all categories) at `address`. NotFound if there is none. One undo step "Remove bookmark"."""
        text_arg(type, "type")
        prog = self.ses.need()
        a = self.ses.addr(address, prog)
        found = list(prog.getBookmarkManager().getBookmarks(a, type))
        if not found:
            raise RpcError(NOT_FOUND, "no %s bookmark at %s" % (type, address))
        self.ses.edit("Remove bookmark", lambda p: [p.getBookmarkManager().removeBookmark(b) for b in found])
        self.ctx.events.record({"bookmark"}, [self.ses.rng(a, a)])
        return {}

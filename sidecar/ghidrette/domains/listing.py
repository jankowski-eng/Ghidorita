"""The listing and function reads (thread R): the table behind the listing pane, the function list, comments."""
from ..core.args import hx
from ..core.errors import NOT_FOUND, RpcError
from ..core.rpc import rpc


class Listing:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    # ---- reads (thread R) ----
    @rpc(lane="R")
    def list_functions(self):
        out = []
        for f in self.ses.need().getFunctionManager().getFunctions(True):
            if f.isExternal():
                continue
            out.append((f.getEntryPoint().getOffset(), str(f.getName()), f.getBody().getNumAddresses()))
        out.sort()
        return [{"name": n, "entry": hx(o), "size": int(s)} for o, n, s in out]

    @rpc(lane="R")
    def get_function_at(self, address):
        prog = self.ses.need()
        f = prog.getFunctionManager().getFunctionContaining(self.ses.addr(address))
        if f is None:
            return None
        return {"name": str(f.getName()), "entry": hx(f.getEntryPoint().getOffset()),
                "size": int(f.getBody().getNumAddresses()), "signature": str(f.getSignature().getPrototypeString())}

    @rpc(lane="R")
    def listing_info(self):
        mem = self.ses.need().getMemory()
        space = self.ses.program.getAddressFactory().getDefaultAddressSpace()  # shortcut: default space only
        ranges = [{"start": hx(r.getMinAddress().getOffset()), "size": int(r.getLength())}
                  for r in mem.getLoadedAndInitializedAddressSet() if r.getMinAddress().getAddressSpace() == space]
        return {"ranges": ranges, "totalBytes": sum(r["size"] for r in ranges)}

    @rpc(lane="R")
    def listing_rows(self, address, count, direction="forward"):
        """Walk code units from an anchor address; no index. See protocol.md."""
        from ghidra.program.model.listing import CommentType, Instruction
        from jpype import JArray, JByte
        prog = self.ses.need()
        fwd = direction != "backward"
        count = max(0, min(int(count), 1000))
        listing, st, mem = prog.getListing(), prog.getSymbolTable(), prog.getMemory()
        loaded = mem.getLoadedAndInitializedAddressSet()
        a = self.ses.addr(address)
        cu = listing.getCodeUnitContaining(a)
        a = cu.getMinAddress() if cu is not None else a
        lo, hi = loaded.getMinAddress(), loaded.getMaxAddress()
        if count == 0 or lo is None:
            return []
        if fwd:
            if a.compareTo(hi) > 0:
                return []
            view = loaded.intersectRange(a if a.compareTo(lo) >= 0 else lo, hi)
        else:
            if a.compareTo(lo) <= 0:
                return []
            end = a.previous()
            view = loaded.intersectRange(lo, end if end.compareTo(hi) <= 0 else hi)
        rows = []
        for cu in listing.getCodeUnits(view, fwd):
            if len(rows) >= count:
                break
            ca = cu.getMinAddress()
            n = cu.getLength()
            if isinstance(cu, Instruction):
                ops = ", ".join(str(cu.getDefaultOperandRepresentation(i)) for i in range(cu.getNumOperands()))
            else:
                ops = str(cu.getDefaultValueRepresentation())
            if n <= 16:
                b = bytes(x & 0xFF for x in cu.getBytes())
            else:  # shortcut: show the first 16 bytes of big data units only
                buf = JArray(JByte)(16)
                mem.getBytes(ca, buf)
                b = bytes(x & 0xFF for x in buf)
            row = {"address": hx(ca.getOffset()), "length": int(n), "bytes": b.hex(" ") + (" …" if n > 16 else ""),
                   "mnemonic": str(cu.getMnemonicString()), "operands": ops}
            sym = st.getPrimarySymbol(ca)
            if sym is not None:
                row["label"] = str(sym.getName())
            c = cu.getComment(CommentType.EOL)
            if c:
                row["comment"] = str(c)
            rows.append(row)
        if not fwd:
            rows.reverse()
        return rows

    @rpc(lane="R")
    def get_comments(self, address):
        from ghidra.program.model.listing import CommentType
        cu = self.ses.need().getListing().getCodeUnitContaining(self.ses.addr(address))
        if cu is None:
            raise RpcError(NOT_FOUND, "no code unit at %s" % address)
        out = {}
        for k, t in (("eol", CommentType.EOL), ("pre", CommentType.PRE), ("post", CommentType.POST),
                     ("plate", CommentType.PLATE), ("repeatable", CommentType.REPEATABLE)):
            c = cu.getComment(t)
            if c:
                out[k] = str(c)
        return out

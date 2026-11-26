"""The listing and function reads (thread R): the table behind the listing pane, the function list, comments."""
from ..core.args import MASK64, akey, hx, ref_kind
from ..core.errors import NOT_FOUND, RpcError
from ..core.rpc import rpc

ROW_COMMENT_KINDS = {"eol": "comment", "pre": "pre", "post": "post", "plate": "plate", "repeatable": "repeatable"}  # CommentType name -> row field


class Listing:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    # ---- reads (thread R) ----
    @rpc(lane="R")
    def list_functions(self):
        out = []
        dspace = self.ses.need().getAddressFactory().getDefaultAddressSpace()
        for f in self.ses.program.getFunctionManager().getFunctions(True):
            if f.isExternal():
                continue
            ea = f.getEntryPoint()
            if ea.getAddressSpace() != dspace:  # shortcut: functions in other spaces are not listed (the listing shows them), upgrade with qualified entries
                continue
            out.append((ea.getOffset() & MASK64, str(f.getName()), f.getBody().getNumAddresses()))
        out.sort()
        return [{"name": n, "entry": hx(o), "size": int(s)} for o, n, s in out]

    @rpc(lane="R")
    def get_function_at(self, address):
        prog = self.ses.need()
        f = prog.getFunctionManager().getFunctionContaining(self.ses.addr(address))
        if f is None:
            return None
        return {"name": str(f.getName()), "entry": self.ses.fmt(f.getEntryPoint()),
                "size": int(f.getBody().getNumAddresses()), "signature": str(f.getSignature().getPrototypeString())}

    @rpc(lane="R")
    def listing_info(self):
        prog = self.ses.need()
        f = self.ses.fmtr(prog)
        # all spaces, in Ghidra's address order: listing_rows walks the same order. size as a JS-safe number (shortcut: ranges of 2^53+ bytes, never)
        ranges = [{"start": f(r.getMinAddress()), "size": int(r.getLength())} for r in prog.getMemory().getLoadedAndInitializedAddressSet().getAddressRanges(True)]
        return {"ranges": ranges, "totalBytes": sum(r["size"] for r in ranges)}

    @staticmethod
    def _view(loaded, a, fwd):
        """The loaded set clipped to [a, end] (forward) or [start, a) (backward), across address spaces (AddressSet ranges cannot span spaces)."""
        from ghidra.program.model.address import AddressSet
        out = AddressSet()
        for r in loaded.getAddressRanges(True):
            mn, mx = r.getMinAddress(), r.getMaxAddress()
            if fwd:
                if mx.compareTo(a) >= 0:
                    out.add(mn if mn.compareTo(a) >= 0 else a, mx)
            elif mn.compareTo(a) < 0:
                out.add(mn, mx if mx.compareTo(a) < 0 else a.previous())
            else:
                break
        return out

    ROW_PARTS_MAX = 64     # components listed per data unit
    ROW_XREFS_SHOWN = 5    # references named per row annotation

    def _row_marks(self, prog, cus, fa):
        """Which of the walked code units have a symbol, a comment of each kind, a function or references to them: one iterator
        per kind over the walked window instead of several calls per row (thread R, cost matters: see bench_sidecar)."""
        from ghidra.program.model.address import AddressSet
        from ghidra.program.model.listing import CommentType
        listing = prog.getListing()
        if cus[0].getMinAddress().getAddressSpace() == cus[-1].getMaxAddress().getAddressSpace():
            win = AddressSet(cus[0].getMinAddress(), cus[-1].getMaxAddress())
        else:  # a fetch across two address spaces: shortcut: window of the walked units one by one, upgrade only if that is slow
            win = AddressSet()
            for cu in cus:
                win.add(cu.getMinAddress(), cu.getMaxAddress())
        rm = prog.getReferenceManager()
        return {
            "sym": {fa(x.getAddress()) for x in prog.getSymbolTable().getPrimarySymbolIterator(win, True)},
            "fn": {fa(f.getEntryPoint()): f for f in prog.getFunctionManager().getFunctions(win, True)},
            "ref": {fa(x): x for x in rm.getReferenceDestinationIterator(win, True)},
            "cm": {k: {fa(x) for x in listing.getCommentAddressIterator(t, win, True)}
                   for k, t in ((k, getattr(CommentType, k.upper())) for k in ROW_COMMENT_KINDS)},
        }

    def _row_parts(self, cu):
        # shortcut: one level (nested structs/arrays show as one component with their display value), at most ROW_PARTS_MAX; upgrade with a get_components RPC by path
        from ghidra.program.model.data import Array
        n = int(cu.getNumComponents())
        is_arr = isinstance(cu.getDataType(), Array)
        parts = []
        for i in range(min(n, self.ROW_PARTS_MAX)):
            c = cu.getComponent(i)
            name = "[%d]" % i if is_arr else str(c.getFieldName() or "field%d" % i)
            parts.append({"offset": int(c.getParentOffset()), "length": int(c.getLength()), "type": str(c.getDataType().getName()),
                          "name": name, "value": str(c.getDefaultValueRepresentation())})
        return parts, n

    def _row_header(self, f):
        sf = f.getStackFrame()
        h = {"signature": str(f.getSignature().getPrototypeString()), "params": int(f.getParameterCount()),
             "paramBytes": int(sf.getParameterSize()), "localBytes": int(sf.getLocalSize())}
        cc = str(f.getCallingConventionName() or "")
        if cc and cc.lower() not in ("unknown", "default"):
            h["convention"] = cc
        if f.hasNoReturn():
            h["noReturn"] = True
        if f.isThunk():
            h["thunk"] = True
        return h

    @rpc(lane="R")
    def listing_rows(self, address, count, direction="forward"):
        """Walk code units from an anchor address; no index. See protocol.md."""
        from ghidra.program.model.listing import CommentType, Instruction
        from jpype import JArray, JByte
        prog = self.ses.need()
        fwd = direction != "backward"
        count = max(0, min(int(count), 1000))
        listing, st, mem, fa = prog.getListing(), prog.getSymbolTable(), prog.getMemory(), self.ses.fmtr(prog)
        loaded = mem.getLoadedAndInitializedAddressSet()
        a = self.ses.addr(address)
        cu = listing.getCodeUnitContaining(a)
        a = cu.getMinAddress() if cu is not None else a
        if count == 0:
            return []
        cus = []
        for cu in listing.getCodeUnits(self._view(loaded, a, fwd), fwd):
            if len(cus) >= count:
                break
            cus.append(cu)
        if not cus:
            return []
        if not fwd:
            cus.reverse()
        marks, rm, rows = self._row_marks(prog, cus, fa), prog.getReferenceManager(), []
        for cu in cus:
            ca = cu.getMinAddress()
            n = int(cu.getLength())
            key = fa(ca)
            is_ins = isinstance(cu, Instruction)
            if is_ins:
                ops = ", ".join(str(cu.getDefaultOperandRepresentation(i)) for i in range(cu.getNumOperands()))
            else:
                ops = str(cu.getDefaultValueRepresentation())
            if n <= 16:
                b = bytes(x & 0xFF for x in cu.getBytes())
            else:  # shortcut: the first 16 bytes only (bytesMore says how many are left), upgrade with a get_bytes RPC
                buf = JArray(JByte)(16)
                mem.getBytes(ca, buf)
                b = bytes(x & 0xFF for x in buf)
            row = {"address": key, "length": n, "bytes": b.hex(" "), "mnemonic": str(cu.getMnemonicString()), "operands": ops}
            if n > 16:
                row["bytesMore"] = n - 16
            if key in marks["sym"]:
                syms = sorted(st.getSymbols(ca), key=lambda x: not x.isPrimary())
                names = [str(x.getName()) for x in syms]
                row["label"] = names[0]
                if len(names) > 1:
                    row["labels"] = names
            for k, out in ROW_COMMENT_KINDS.items():
                if key in marks["cm"][k]:
                    c = cu.getComment(getattr(CommentType, k.upper()))
                    if c:
                        row[out] = str(c)
            f = marks["fn"].get(key)
            if f is not None:
                row["header"] = self._row_header(f)
            if key in marks["ref"]:
                refs = []
                for r in rm.getReferencesTo(ca):
                    refs.append({"from": fa(r.getFromAddress()), "kind": ref_kind(r.getReferenceType())})
                    if len(refs) >= self.ROW_XREFS_SHOWN:
                        break
                refs.sort(key=lambda o: akey(o["from"]))  # shortcut: the first 5 Ghidra returns, not the 5 lowest; the full list is xrefs_to
                row["xrefs"] = {"count": int(rm.getReferenceCountTo(ca)), "items": refs}
            if not is_ins and cu.isDefined() and cu.getNumComponents() > 0:
                parts, total = self._row_parts(cu)
                row["parts"] = parts
                if total > len(parts):
                    row["partsTotal"] = total
            rows.append(row)
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

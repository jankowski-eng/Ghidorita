"""Listing edits (thread R): labels, comments, functions, data, clearing code. One transaction each, its name is the undo label."""
from ..core.args import name_arg, text_arg
from ..core.errors import INTERNAL, INVALID, NOT_FOUND, RpcError
from ..core.rpc import rpc


class Edits:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    @rpc(lane="R")
    def rename_symbol(self, address, newName):
        from ghidra.app.cmd.label import RenameLabelCmd
        from ghidra.program.model.symbol import SourceType
        prog = self.ses.need()
        name_arg(newName, "newName")
        sym = prog.getSymbolTable().getPrimarySymbol(self.ses.addr(address))
        if sym is None:
            raise RpcError(NOT_FOUND, "no symbol at %s" % address)
        old = str(sym.getName())
        self.ses.edit("Rename %s to %s" % (old, newName), self.ses.cmd(RenameLabelCmd(sym, newName, SourceType.USER_DEFINED)))
        return {}

    @rpc(lane="R")
    def set_comment(self, address, kind, text):
        from ghidra.app.cmd.comments import SetCommentCmd
        from ghidra.program.model.listing import CommentType
        prog = self.ses.need()
        kinds = {"eol": CommentType.EOL, "pre": CommentType.PRE, "post": CommentType.POST,
                 "plate": CommentType.PLATE, "repeatable": CommentType.REPEATABLE}
        if kind not in kinds:
            raise RpcError(INVALID, "bad comment kind %r" % (kind,))
        text_arg(text, "text")
        cu = prog.getListing().getCodeUnitContaining(self.ses.addr(address))
        if cu is None:
            raise RpcError(NOT_FOUND, "no code unit at %s" % address)
        cmd = SetCommentCmd(cu.getMinAddress(), kinds[kind], text or None)
        self.ses.edit(("Clear %s comment" if not text else "Set %s comment") % kind, self.ses.cmd(cmd))
        return {}

    @rpc(lane="R")
    def create_label(self, address, name):
        from ghidra.app.cmd.label import AddLabelCmd
        from ghidra.program.model.symbol import SourceType
        prog = self.ses.need()
        name_arg(name)
        a = self.ses.addr(address)
        if not prog.getMemory().contains(a):
            raise RpcError(INVALID, "address %s is not in memory" % address)
        if prog.getSymbolTable().getPrimarySymbol(a) is not None:
            raise RpcError(INVALID, "a label already exists at %s (use rename_symbol)" % address)
        self.ses.edit("Create label %s" % name, self.ses.cmd(AddLabelCmd(a, name, SourceType.USER_DEFINED)))
        return {}

    @rpc(lane="R")
    def create_function(self, address, name=None):
        from ghidra.app.cmd.disassemble import DisassembleCommand
        from ghidra.app.cmd.function import CreateFunctionCmd
        from ghidra.program.model.symbol import SourceType
        prog = self.ses.need()
        a, fm = self.ses.addr(address), prog.getFunctionManager()
        if name is not None:
            name_arg(name)
        if fm.getFunctionContaining(a) is not None:
            raise RpcError(INVALID, "address is already inside a function")
        cmd = (CreateFunctionCmd(name, a, None, SourceType.USER_DEFINED) if name else CreateFunctionCmd(a))
        def run(p):  # as Ghidra's Create Function action: undefined bytes are disassembled first (else the body is the entry byte only)
            if p.getListing().getInstructionAt(a) is None and p.getListing().getDefinedDataAt(a) is None:
                DisassembleCommand(a, None, True).applyTo(p)
            self.ses.cmd(cmd)(p)
        self.ses.edit("Create function at %s" % address, run)
        f = fm.getFunctionAt(a)
        if f is None:
            raise RpcError(INTERNAL, "function was not created")
        return {"entry": self.ses.fmt(a), "name": str(f.getName())}

    @rpc(lane="R")
    def define_data(self, address, dataType):
        from ghidra.app.cmd.data import CreateDataCmd
        from ghidra.program.model.data import DataTypeConflictHandler
        from ghidra.util.data import DataTypeParser
        from ghidra.util.data.DataTypeParser import AllowedDataTypes
        prog = self.ses.need()
        text_arg(dataType, "dataType")
        a = self.ses.addr(address)
        if not prog.getMemory().contains(a):
            raise RpcError(INVALID, "address %s is not in memory" % address)

        out = {}

        def go(p):
            dtm = p.getDataTypeManager()
            dt = dtm.getDataType(dataType) if dataType.startswith("/") else None
            if dt is None and dataType.startswith("/"):
                dt = self._path_with_suffix(dtm, dataType)  # "/A/S[4]", "/A/S *": the parser takes no category path in front of a suffix
            if dt is None:
                try:
                    dt = DataTypeParser(dtm, dtm, None, AllowedDataTypes.ALL).parse(dataType)
                except Exception as e:  # noqa  (ParseException, or anything the parser throws on junk)
                    raise RpcError(INVALID, "unknown data type %r: %s" % (dataType, e))
            if dt is None or dt.getLength() <= 0:
                raise RpcError(INVALID, "type %r is unknown or has no fixed size" % dataType)
            dt = dtm.resolve(dt, DataTypeConflictHandler.DEFAULT_HANDLER)
            self.ses.cmd(CreateDataCmd(a, True, False, dt))(p)
            out["range"] = self.ses.rng(a, a.add(dt.getLength() - 1))
        self.ses.edit("Define data", go)
        self.ctx.events.record({"data"}, [out["range"]])
        return {}

    @staticmethod
    def _path_with_suffix(dtm, text):
        """`/Category/Name` followed by array (`[n]`) and pointer (`*`) suffixes, resolved by hand; None when it is not that shape or the path is unknown."""
        import re
        from ghidra.program.model.data import ArrayDataType, PointerDataType
        m = re.fullmatch(r"(/[^\[\]*]*?)\s*((?:\[\d+\]|\*\d*|\s)+)", text)
        base = dtm.getDataType(m.group(1)) if m else None
        if base is None:
            return None
        dt, group = base, []

        def arrays(dt):  # Ghidra's name parser reverses each consecutive run of array suffixes: S[2][3] is two arrays of three
            for n in reversed(group):
                if n < 1 or dt.getLength() <= 0:
                    return None
                dt = ArrayDataType(dt, n, dt.getLength())
            group.clear()
            return dt
        for s in re.findall(r"\[\d+\]|\*\d*", m.group(2)):
            if s[0] == "[":
                group.append(int(s[1:-1]))
                continue
            dt = arrays(dt)
            if dt is None:
                return None
            if len(s) > 1:  # "*32": an explicit width in bits, as Ghidra's parser accepts it
                bits = int(s[1:])
                if bits % 8 or not 8 <= bits <= 64:
                    raise RpcError(INVALID, "pointer width %d is not a multiple of 8 bits between 8 and 64" % bits)
                dt = PointerDataType(dt, bits // 8)
            else:
                dt = PointerDataType(dt)
        return arrays(dt)

    @rpc(lane="R")
    def clear_code(self, address, length=None):
        from ghidra.app.plugin.core.clear import ClearCmd
        from ghidra.program.model.address import AddressSet
        prog = self.ses.need()
        a, mem, listing = self.ses.addr(address), prog.getMemory(), prog.getListing()
        if not mem.contains(a):
            raise RpcError(INVALID, "address %s is not in memory" % address)
        if length is None:
            cu = listing.getCodeUnitContaining(a)
            lo, hi = cu.getMinAddress(), cu.getMaxAddress()
        else:
            n = int(length)
            if n < 1:
                raise RpcError(INVALID, "length must be >= 1")
            lo = a
            mask = (1 << 64) - 1  # getOffset is a signed long: the max address of a 64-bit space reads as -1
            top = a.getAddressSpace().getMaxAddress()
            hi = top if (a.getOffset() & mask) + n - 1 > (top.getOffset() & mask) else a.add(n - 1)
        # units overlapping the range are cleared whole (as the listing's Clear Code Bytes does): widen to their bounds, or a range
        # inside one unit (getCodeUnits only yields units that *start* in a view) would look empty and be refused
        first, last = listing.getCodeUnitContaining(lo), listing.getCodeUnitContaining(hi)
        lo, hi = (first.getMinAddress() if first is not None else lo), (last.getMaxAddress() if last is not None else hi)
        view = AddressSet(lo, hi).intersect(mem)
        # ClearCmd.applyTo returns true even when it did nothing; an empty transaction would not be undoable
        if not any(not hasattr(cu, "isDefined") or cu.isDefined() for cu in listing.getCodeUnits(view, True)):
            raise RpcError(INVALID, "no instructions or defined data in range")
        self.ses.edit("Clear code", lambda p: self.ses.cmd(ClearCmd(view))(p))
        self.ctx.events.record({"code", "data"}, [self.ses.rng(lo, hi)])
        return {}

    @rpc(lane="R")
    def set_function_signature(self, entry, signature):
        from ghidra.app.cmd.function import ApplyFunctionSignatureCmd
        from ghidra.app.util.parser import FunctionSignatureParser
        from ghidra.program.model.data import DataTypeConflictHandler
        from ghidra.program.model.symbol import SourceType
        from ghidra.app.cmd.function import FunctionRenameOption
        text_arg(signature, "signature")
        prog, f = self.ses.function(entry)

        def go(p):
            fdef = FunctionSignatureParser(p.getDataTypeManager(), None).parse(f.getSignature(), signature)
            cmd = ApplyFunctionSignatureCmd(f.getEntryPoint(), fdef, SourceType.USER_DEFINED, True, False,
                                            DataTypeConflictHandler.DEFAULT_HANDLER, FunctionRenameOption.RENAME)
            self.ses.cmd(cmd)(p)
        self.ses.edit("Edit signature of %s" % f.getName(), go)
        return {}

    @rpc(lane="R")
    def set_equate(self, address, value, size, name, enum=None):
        """Ghidra's Set Equate on ONE instruction operand. `value` (decimal string) and `size` (bytes) are the constant the decompiler shows;
        its operand is the one scalar holding exactly that value in the instruction at `address` or the up to 19 before it in the same
        straight-line run (as Ghidra's decompiler action, which also accepts "near" values: shortcut, those are refused here).
        InvalidArgument if no operand or several hold it. `name` is an equate (existing or new) or, with `enum` (a program enum's path), one of its members."""
        from ghidra.app.cmd.equate import SetEquateCmd
        from ghidra.program.database.symbol import EquateManager
        from ghidra.program.model.data import Enum
        from ghidra.program.model.scalar import Scalar
        prog = self.ses.need()
        name_arg(name)
        try:
            val, size = int(value), int(size)
        except (TypeError, ValueError):
            raise RpcError(INVALID, "value must be an integer string and size a byte count")
        if size not in (1, 2, 4, 8):
            raise RpcError(INVALID, "size must be 1, 2, 4 or 8")
        mask = (1 << (8 * size)) - 1
        listing, a = prog.getListing(), self.ses.addr(address)
        cur = listing.getInstructionContaining(a)
        if cur is None:
            raise RpcError(NOT_FOUND, "no instruction at %s" % address)
        hits, n = [], 0
        while cur is not None and n < 20:
            for i in range(cur.getNumOperands()):
                hits += [(cur.getAddress(), i, o) for o in cur.getOpObjects(i) if isinstance(o, Scalar) and o.getValue() & mask == val & mask]
            n += 1
            prev = cur.getPrevious()
            ft = prev.getFallThrough() if prev is not None else None
            cur = prev if ft is not None and ft.equals(cur.getAddress()) else None
        if len(hits) != 1:
            raise RpcError(INVALID, "cannot place the equate on one operand: %s" % (
                "no instruction operand near %s holds %s" % (address, value) if not hits else "%d operands hold %s" % (len(hits), value)))
        at, op, scalar = hits[0]
        eq_name = name
        if enum is not None:
            text_arg(enum, "enum")
            dt = prog.getDataTypeManager().getDataType(enum)
            if not isinstance(dt, Enum):
                raise RpcError(NOT_FOUND, "no enum %s" % enum)
            if not dt.contains(name) or dt.getValue(name) & mask != val & mask:  # several names may share a value: ask for this one directly
                raise RpcError(INVALID, "%s has no member %s = %s" % (enum, name, value))
            # an enum-ID equate resolves to the value's first member (EquateDB.getName), so an alias member stays a plain named equate
            if str(dt.getName(val & mask)) == name:
                eq_name = EquateManager.formatNameForEquate(dt.getUniversalID(), scalar.getValue())

        def go(p):
            table = p.getEquateTable()
            old = table.getEquate(at, op, scalar.getValue())  # replace this operand's equate only, not the others that use it
            if old is not None:
                if old.getReferenceCount() <= 1:
                    table.removeEquate(old.getName())
                else:
                    old.removeReference(at, op)
            self.ses.cmd(SetEquateCmd(eq_name, at, op, scalar.getValue()))(p)
        self.ses.edit("Set equate %s" % name, go)
        return {}

    @rpc(lane="R")
    def set_function_no_return(self, entry, noReturn=True):
        """The No Return flag of Edit Function Signature. Callers are re-decompiled without the dead code after it: the flag change is a function
        event, which clears the whole decompile cache (decompile.py), so no caller keeps its old text."""
        if not isinstance(noReturn, bool):
            raise RpcError(INVALID, "noReturn must be a boolean")
        prog, f = self.ses.function(entry)
        self.ses.edit("%s %s" % ("Mark no return:" if noReturn else "Clear no return:", f.getName()), lambda p: f.setNoReturn(noReturn))
        return {}

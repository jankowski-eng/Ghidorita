"""Listing edits (thread R): labels, comments, functions, data, clearing code. One transaction each, its name is the undo label."""
from ..core.args import hx, name_arg, text_arg
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
        from ghidra.app.cmd.function import CreateFunctionCmd
        from ghidra.program.model.symbol import SourceType
        prog = self.ses.need()
        a, fm = self.ses.addr(address), prog.getFunctionManager()
        if name is not None:
            name_arg(name)
        if fm.getFunctionContaining(a) is not None:
            raise RpcError(INVALID, "address is already inside a function")
        cmd = (CreateFunctionCmd(name, a, None, SourceType.USER_DEFINED) if name else CreateFunctionCmd(a))
        self.ses.edit("Create function at %s" % hx(a.getOffset()), self.ses.cmd(cmd))
        f = fm.getFunctionAt(a)
        if f is None:
            raise RpcError(INTERNAL, "function was not created")
        return {"entry": hx(a.getOffset()), "name": str(f.getName())}

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
            if dt is None:
                try:
                    dt = DataTypeParser(dtm, dtm, None, AllowedDataTypes.ALL).parse(dataType)
                except Exception as e:  # noqa  (ParseException, or anything the parser throws on junk)
                    raise RpcError(INVALID, "unknown data type %r: %s" % (dataType, e))
            if dt is None or dt.getLength() <= 0:
                raise RpcError(INVALID, "type %r is unknown or has no fixed size" % dataType)
            dt = dtm.resolve(dt, DataTypeConflictHandler.DEFAULT_HANDLER)
            self.ses.cmd(CreateDataCmd(a, True, False, dt))(p)
            out["range"] = (a.getOffset(), a.getOffset() + dt.getLength() - 1)
        self.ses.edit("Define data", go)
        self.ctx.events.record({"data"}, [out["range"]])
        return {}

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
        view = AddressSet(lo, hi).intersect(mem)
        # ClearCmd.applyTo returns true even when it did nothing; an empty transaction would not be undoable
        if not any(not hasattr(cu, "isDefined") or cu.isDefined() for cu in listing.getCodeUnits(view, True)):
            raise RpcError(INVALID, "no instructions or defined data in range")
        self.ses.edit("Clear code", lambda p: self.ses.cmd(ClearCmd(view))(p))
        self.ctx.events.record({"code", "data"}, [(lo.getOffset(), hi.getOffset())])
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

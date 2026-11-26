"""Edits through the decompiler's high-level variables (prepare on S, commit on R, cancellable).
Cross-domain edge: decompile.decompile_for_edit (see ARCHITECTURE.md)."""
from ..core.args import lim, name_arg, text_arg
from ..core.errors import CANCELLED, INTERNAL, INVALID, NOT_FOUND, RpcError
from ..core.rpc import rpc
from .decompile import decompile_for_edit


class HighVars:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    def _high_edit(self, tx_name, entry, name, fn, timeoutSecs, job):
        """Prepare on a scan worker, then commit on R only if the program and revision still match."""
        text_arg(name, "name")
        timeoutSecs = lim(timeoutSecs, 30)
        with self.ctx.lanes.scanning(job) as prog:
            with self.ses.lock:
                revision = self.ses.revision
            addr = self.ses.addr(entry, prog)
            func = prog.getFunctionManager().getFunctionAt(addr)
            if func is None:
                raise RpcError(NOT_FOUND, "no function at %s" % entry)
            with decompile_for_edit(self.ctx, prog, func, timeoutSecs, job) as hf:
                sym = next((s for s in hf.getLocalSymbolMap().getSymbols() if str(s.getName()) == name), None)
                if sym is None:
                    raise RpcError(NOT_FOUND, "no variable %r in function at %s" % (name, entry))

        def commit():
            with self.ses.lock:
                stale = (job.cancelled or self.ses.program is not prog or
                         self.ses.epoch != job.epoch or self.ses.revision != revision)
            if stale:
                raise RpcError(CANCELLED, "variable edit cancelled or program changed; retry")
            self.ses.edit(tx_name % func.getName(), lambda p: fn(p, func, hf, sym))
        self.ctx.lanes.on_r(commit)
        return {}

    @staticmethod
    def _needs_full_commit(sym, hf):
        """Same test as AbstractDecompilerAction.checkFullCommit (protected there)."""
        if not sym.isParameter():
            return False
        params, lsm = hf.getFunction().getParameters(), hf.getLocalSymbolMap()
        if lsm.getNumParams() != len(params):
            return True
        for i in range(lsm.getNumParams()):
            p = lsm.getParamSymbol(i)
            if p.getCategoryIndex() != i or p.getStorage().compareTo(params[i].getVariableStorage()) != 0:
                return True
        return False

    @rpc(lane="edit")
    def rename_variable(self, entry, name, newName, timeoutSecs=30, job=None):
        from ghidra.program.model.pcode import HighFunctionDBUtil
        from ghidra.program.model.symbol import SourceType
        name_arg(newName, "newName")

        def go(prog, func, hf, sym):
            if prog.getSymbolTable().getSymbols(newName, func):
                raise RpcError(INVALID, "name %r already used in this function" % newName)
            if self._needs_full_commit(sym, hf):
                HighFunctionDBUtil.commitParamsToDatabase(hf, False, HighFunctionDBUtil.ReturnCommitOption.NO_COMMIT, func.getSignatureSource())
            HighFunctionDBUtil.updateDBVariable(sym, newName, None, SourceType.USER_DEFINED)
        return self._high_edit("Rename variable in %s", entry, name, go, timeoutSecs, job)

    def _commit_type(self, prog, func, hf, sym, dt):
        from ghidra.program.model.pcode import HighFunctionDBUtil
        from ghidra.program.model.symbol import SourceType
        if self._needs_full_commit(sym, hf):
            HighFunctionDBUtil.commitParamsToDatabase(hf, func.getSignatureSource() != SourceType.DEFAULT,
                                                      HighFunctionDBUtil.ReturnCommitOption.NO_COMMIT, SourceType.USER_DEFINED)
        HighFunctionDBUtil.updateDBVariable(sym, None, dt, SourceType.USER_DEFINED)

    @rpc(lane="edit")
    def retype_variable(self, entry, name, dataType, timeoutSecs=30, job=None):
        from ghidra.program.model.data import DataTypeConflictHandler
        from ghidra.util.data import DataTypeParser
        from ghidra.util.data.DataTypeParser import AllowedDataTypes
        text_arg(dataType, "dataType")

        def go(prog, func, hf, sym):
            dtm = prog.getDataTypeManager()
            dt = DataTypeParser(dtm, dtm, None, AllowedDataTypes.FIXED_LENGTH).parse(dataType)
            if dt is None or dt.getLength() <= 0:
                raise RpcError(INVALID, "type %r has no fixed size" % dataType)
            dt = dtm.resolve(dt, DataTypeConflictHandler.DEFAULT_HANDLER)
            self._commit_type(prog, func, hf, sym, dt)
        return self._high_edit("Retype variable in %s", entry, name, go, timeoutSecs, job)

    @rpc(lane="edit")
    def auto_create_structure(self, entry, name, structName=None, timeoutSecs=30, job=None):
        """Ghidra's "Auto Create Structure" (FillOutStructureHelper, as FillOutStructureCmd uses it) on a decompiler variable:
        infers fields from the load/store offsets through the variable (following it into callees), adds the struct, and
        retypes the variable to a pointer to it, all in one transaction."""
        from ghidra.app.decompiler import DecompileOptions
        from ghidra.app.decompiler.util import FillOutStructureHelper
        from ghidra.pyghidra import PyGhidraTaskMonitor
        from ghidra.program.model.data import CategoryPath, DataTypeConflictHandler, PointerDataType
        if structName is not None:
            name_arg(structName, "structName")
        out = {}

        def go(prog, func, hf, sym):
            dtm = prog.getDataTypeManager()
            hv = sym.getHighVariable()
            if hv is None:
                raise RpcError(INVALID, "variable %r has no decompiler high variable" % name)
            helper = FillOutStructureHelper(prog, PyGhidraTaskMonitor(None, None))
            di = helper.setUpDecompiler(DecompileOptions())
            if di is None:
                raise RpcError(INTERNAL, "decompiler failed to open program")
            try:
                # with a name: always a new struct (extending an existing one would rename it); without: Ghidra's behavior, extend the struct the variable already points to
                st = helper.processStructure(hv, func, structName is not None, False, di)
            finally:
                di.dispose()
            if st is None:
                raise RpcError(INVALID, "no field accesses found through %r: cannot infer a structure" % name)
            if structName is not None:
                if dtm.getDataType(st.getCategoryPath(), structName) is not None and str(st.getName()) != structName:
                    raise RpcError(INVALID, "%s already exists" % structName)
                st.setName(structName)
            ptr = dtm.addDataType(PointerDataType(st), DataTypeConflictHandler.DEFAULT_HANDLER)
            self._commit_type(prog, func, hf, sym, ptr)
            out["path"] = str(ptr.getDataType().getPathName())
        self._high_edit("Auto create structure in %s", entry, name, go, timeoutSecs, job)
        return out

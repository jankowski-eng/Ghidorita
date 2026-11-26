"""Edits through the decompiler's high-level variables (prepare on S, commit on R, cancellable).
Cross-domain edge: decompile.decompile_for_edit (see ARCHITECTURE.md)."""
import time

from ..core.args import lim, name_arg, text_arg
from ..core.errors import CANCELLED, INVALID, NOT_FOUND, TIMEOUT, RpcError
from ..core.jscans import scans
from ..core.rpc import rpc
from .decompile import decompile_for_edit


class HighVars:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    def _high_edit(self, tx_name, entry, name, fn, timeoutSecs, job, prepare=None):
        """Prepare on a scan worker, then commit on R only if the program and revision still match."""
        text_arg(name, "name")
        timeoutSecs = lim(timeoutSecs, 30)
        deadline = None
        with self.ctx.lanes.scanning(job) as prog:
            with self.ses.lock:
                revision = self.ses.revision
            addr = self.ses.addr(entry, prog)
            func = prog.getFunctionManager().getFunctionAt(addr)
            if func is None:
                raise RpcError(NOT_FOUND, "no function at %s" % entry)
            if prepare is not None:
                timeoutSecs = timeoutSecs or 30
                deadline = time.monotonic() + timeoutSecs
            with decompile_for_edit(self.ctx, prog, func, timeoutSecs, job, prepare is not None) as (hf, d, mon):
                sym = next((s for s in hf.getLocalSymbolMap().getSymbols() if str(s.getName()) == name), None)
                if sym is None:
                    raise RpcError(NOT_FOUND, "no variable %r in function at %s" % (name, entry))
                if prepare is not None:
                    fn = prepare(prog, sym, d, mon)

        def commit():
            with self.ses.lock:
                stale = (job.cancelled or self.ses.program is not prog or
                         self.ses.epoch != job.epoch or self.ses.revision != revision)
            if stale:
                raise RpcError(CANCELLED, "variable edit cancelled or program changed; retry")
            if deadline is not None and time.monotonic() >= deadline:
                raise RpcError(TIMEOUT, "structure inference timed out after %ss" % timeoutSecs)
            return self.ses.edit(tx_name % func.getName(), lambda p: fn(p, func, hf, sym)) or {}
        return self.ctx.lanes.on_r(commit)

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
        """Infer fields on a scan worker, then apply the structure and variable type in one transaction."""
        from java.lang import IllegalArgumentException
        from ghidra.app.decompiler.util import FillOutStructureHelper
        from ghidra.program.model.data import CategoryPath, DataTypeConflictHandler, PointerDataType, StructureDataType
        if structName is not None:
            name_arg(structName, "structName")

        def prepare(prog, sym, decompiler, monitor):
            hv = sym.getHighVariable()
            if hv is None:
                raise RpcError(INVALID, "variable %r has no decompiler high variable" % name)
            existing = FillOutStructureHelper.getStructureForExtending(hv.getDataType()) if structName is None else None
            fields = scans().inferStructure(prog, hv, existing, decompiler, monitor)
            size = int(fields.getSize())
            if size <= 0 or size > (1 << 31) - 1:
                raise RpcError(INVALID, "no field accesses found through %r: cannot infer a structure" % name)

            def commit(prog, func, hf, sym):
                dtm = prog.getDataTypeManager()
                st = existing
                if st is None:
                    cat = CategoryPath("/auto_structs")
                    st = StructureDataType(cat, dtm.getUniqueName(cat, "astruct"), size, dtm)
                    if structName is not None:
                        if dtm.getDataType(cat, structName) is not None:
                            raise RpcError(INVALID, "%s already exists" % structName)
                        st.setName(structName)
                else:
                    length = 0 if st.isZeroLength() else st.getLength()
                    if size > length:
                        st.growStructure(size - length)
                for field in fields.iterator():
                    offset, dt = int(field.getKey()), field.getValue()
                    if offset < 0 or offset + dt.getLength() > st.getLength():
                        continue
                    component = st.getComponentAt(offset)
                    try:
                        st.replaceAtOffset(offset, dt, dt.getLength(), component.getFieldName() if component else None,
                                           component.getComment() if component else None)
                    except IllegalArgumentException:
                        continue  # Ghidra skips fields that cannot be placed at the inferred offset.
                ptr = dtm.addDataType(PointerDataType(st), DataTypeConflictHandler.DEFAULT_HANDLER)
                self._commit_type(prog, func, hf, sym, ptr)
                return {"path": str(ptr.getDataType().getPathName())}

            return commit

        return self._high_edit("Auto create structure in %s", entry, name, None, timeoutSecs, job, prepare=prepare)

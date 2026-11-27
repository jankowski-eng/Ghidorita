"""Edits through the decompiler's high-level variables (prepare on S, commit on R, cancellable).
Cross-domain edge: decompile.decompile_for_edit (see ARCHITECTURE.md)."""
import time

from ..core.args import lim, name_arg, text_arg
from ..core.errors import CANCELLED, INTERNAL, INVALID, NOT_FOUND, TIMEOUT, RpcError
from ..core.jscans import scans
from ..core.rpc import rpc
from .decompile import decompile_for_edit, union_of


class HighVars:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    def _high_edit(self, tx_name, entry, name, fn, timeoutSecs, job, prepare=None, nameless=False):
        """Prepare on a scan worker, then commit on R only if the program and revision still match."""
        if not nameless:  # nameless: an edit that finds its own target in `prepare` (force_union_field only)
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
            with decompile_for_edit(self.ctx, prog, func, timeoutSecs, job, prepare is not None) as (hf, d, mon, res):
                sym = next((s for s in hf.getLocalSymbolMap().getSymbols() if str(s.getName()) == name), None) if not nameless else None
                if sym is None and not nameless:
                    raise RpcError(NOT_FOUND, "no variable %r in function at %s" % (name, entry))
                if prepare is not None:
                    fn = prepare(prog, sym, d, mon, res)

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

        def prepare(prog, sym, decompiler, monitor, _res):
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

    @rpc(lane="edit")
    def split_variable(self, entry, name, address, newName, timeoutSecs=30, job=None):
        """Ghidra's Split Out As New Variable: the use of `name` at the instruction `address` (the token's own) leaves the variable the
        decompiler merged it into and becomes `newName`, typelocked (an undefined type becomes the unsigned integer of that size, as Ghidra does:
        an undefined type would not lock). InvalidArgument if the variable has one merge group only (nothing to split), is already isolated,
        or `address` does not single out one group."""
        from ghidra.program.model.data import AbstractIntegerDataType, Undefined
        from ghidra.program.model.pcode import HighFunctionDBUtil, HighLocal
        from ghidra.program.model.symbol import SourceType
        name_arg(newName, "newName")
        text_arg(address, "address")

        def go(prog, func, hf, sym):
            hv, at = sym.getHighVariable(), self.ses.addr(address, prog)
            if not isinstance(hv, HighLocal) or sym.isIsolated() or len({v.getMergeGroup() for v in hv.getInstances()}) < 2:
                raise RpcError(INVALID, "%r is one use only, or already split out: nothing to split" % name)
            groups = {v.getMergeGroup() for v in hv.getInstances()
                      if (v.getDef() is not None and v.getDef().getSeqnum().getTarget().equals(at))
                      or any(op.getSeqnum().getTarget().equals(at) for op in v.getDescendants())}
            if len(groups) != 1:
                raise RpcError(INVALID, "%r is not read or written at %s (or at several of its merged uses)" % (name, address))
            if prog.getSymbolTable().getSymbols(newName, func):
                raise RpcError(INVALID, "name %r already used in this function" % newName)
            vn = next(v for v in hv.getInstances() if v.getMergeGroup() in groups)
            ns = hf.splitOutMergeGroup(hv, vn).getSymbol()
            dt = ns.getDataType()
            if Undefined.isUndefined(dt):
                dt = AbstractIntegerDataType.getUnsignedDataType(dt.getLength(), prog.getDataTypeManager())
            HighFunctionDBUtil.updateDBVariable(ns, newName, dt, SourceType.USER_DEFINED)
        return self._high_edit("Split out variable in %s", entry, name, go, timeoutSecs, job)

    @staticmethod
    def _union_facet(tok, union):
        """ForceUnionAction.determineFacet: (op, slot, varnode, parent data type) of the access the token belongs to, else None."""
        from ghidra.program.model.data import Pointer, TypeDef
        from ghidra.program.model.pcode import PartialUnion, PcodeOp

        def related(vn):
            high = vn.getHigh() if vn is not None else None
            if high is None:
                return None
            dt = high.getDataType()
            dt = dt.getBaseDataType() if isinstance(dt, TypeDef) else dt
            inner = dt.getDataType() if isinstance(dt, Pointer) else dt.getParent() if isinstance(dt, PartialUnion) else dt
            inner = inner.getBaseDataType() if isinstance(inner, TypeDef) else inner  # a pointer's target or a partial union's parent may be a typedef too (union_of looks through it)
            if inner == union:
                return dt
            sym = high.getSymbol()
            if sym is None:
                return None
            dt = sym.getDataType()
            dt = dt.getBaseDataType() if isinstance(dt, TypeDef) else dt
            return dt if dt == union else None

        op = tok.getPcodeOp()
        if op is None:
            return None
        if op.getOpcode() == PcodeOp.PTRSUB:
            parent = related(op.getInput(0))
            if parent is not None:
                vn, slot = op.getInput(0), 0
                if op.getInput(1).getOffset() == 0:  # artificial op: the access is further down
                    while True:
                        tmp = op.getOutput()
                        nxt = tmp.getLoneDescend()
                        if nxt is None:
                            break
                        op, vn, slot = nxt, tmp, nxt.getSlot(tmp)
                        if not (op.getOpcode() == PcodeOp.PTRSUB and op.getInput(1).getOffset() == 0):
                            break
                return op, slot, vn, parent
            parent = related(op.getOutput())  # the PTRSUB's output may be the union
            if parent is None:
                return None
            vn, slot = op.getOutput(), -1
            read = vn.getLoneDescend()
            if read is not None and read.getOpcode() not in (PcodeOp.MULTIEQUAL, PcodeOp.INDIRECT):
                op, slot = read, read.getSlot(vn)
            return op, slot, vn, parent
        for slot in range(op.getNumInputs()):
            vn = op.getInput(slot)
            parent = related(vn)
            if parent is not None:
                if op.getOpcode() == PcodeOp.SUBPIECE and slot == 0 and not isinstance(parent, Pointer):
                    slot, vn = -1, op.getOutput()  # SUBPIECE is itself the resolution: choose by its output
                return op, slot, vn, parent
        vn = op.getOutput()
        parent = related(vn) if vn is not None else None
        return (op, -1, vn, parent) if parent is not None else None

    @staticmethod
    def _union_choices(union, vn, parent):
        """ForceUnionAction.buildFieldOptions: (field number, name) of the fields that fit the varnode, in union order."""
        from ghidra.program.model.data import Pointer
        from ghidra.program.model.pcode import PartialUnion
        size, start, exact = (0 if isinstance(parent, Pointer) else vn.getSize()), 0, True
        if isinstance(parent, PartialUnion):
            start, exact = parent.getOffset(), False
        out = []
        for n, c in enumerate(union.getDefinedComponents()):
            end = start + size
            if size == 0 or (exact and start == c.getOffset() and end == c.getOffset() + c.getLength()) or \
               (not exact and start >= c.getOffset() and end <= c.getOffset() + c.getLength()):
                out.append((n, str(c.getFieldName() or c.getDefaultFieldName())))
        return out

    @rpc(lane="edit")
    def force_union_field(self, entry, address, text, field, occurrence=0, timeoutSecs=30, job=None):
        """Ghidra's Force Field: this one use of a union (the decompiler token `text` of the access at `address` (the token's `unionAt`), the `occurrence`-th such union token there) is shown as `field` (a member name that fits the access, as Ghidra offers them) or, with null, as no field. Writes a union
        facet symbol (HighFunctionDBUtil.writeUnionFacet). InvalidArgument if the token is not a union access or the field does not fit."""
        from ghidra.app.decompiler.component import DecompilerUtils
        from ghidra.program.model.address import Address
        from ghidra.program.model.pcode import DynamicHash, HighFunctionDBUtil
        from ghidra.program.model.symbol import SourceType
        text_arg(address, "address")
        text_arg(text, "text")
        if field is not None:
            text_arg(field, "field")
        if not isinstance(occurrence, int) or isinstance(occurrence, bool) or occurrence < 0:
            raise RpcError(INVALID, "occurrence must be a non-negative integer")

        def prepare(prog, _sym, d, mon, res):
            at = self.ses.addr(address, prog)
            hf = res.getHighFunction()
            same = [t for line in DecompilerUtils.toLines(res.getCCodeMarkup()) for t in line.getAllTokens()
                    if str(t.getText()) == text and t.getPcodeOp() is not None and t.getPcodeOp().getSeqnum().getTarget().equals(at)
                    and union_of(t) is not None]
            if occurrence >= len(same):
                raise RpcError(NOT_FOUND, "no token %r at %s" % (text, address))
            tok = same[occurrence]
            union = union_of(tok)
            facet = self._union_facet(tok, union) if union is not None else None
            if facet is None:
                raise RpcError(INVALID, "%r is not an access of a union" % text)
            op, slot, vn, parent = facet
            choices = self._union_choices(union, vn, parent)
            if field is None:
                from ghidra.program.model.data import Pointer
                from ghidra.program.model.pcode import PartialUnion
                # ForceUnionAction offers "no field" only for the whole union: a pointer to it, or a varnode of its size that is not a part of it
                if not (isinstance(parent, Pointer) or (not isinstance(parent, PartialUnion) and vn.getSize() == union.getLength())):
                    raise RpcError(INVALID, "this access is a part of the union: choose a field; choices: %s" % (", ".join(n for _, n in choices) or "(none)"))
                number = -1
            else:
                number = next((n for n, name in choices if name == field), None)
                if number is None:
                    raise RpcError(INVALID, "field %r does not fit this access; choices: %s" % (field, ", ".join(n for _, n in choices) or "(none)"))
            dh = DynamicHash(op, slot, hf)
            pc, h = dh.getAddress(), dh.getHash()
            if pc.equals(Address.NO_ADDRESS):
                raise RpcError(INVALID, "cannot find a unique hash for this access")

            def commit(prog, func, _hf, _sym):
                HighFunctionDBUtil.writeUnionFacet(func, parent, number, pc, h, True, SourceType.USER_DEFINED)
            return commit

        return self._high_edit("Force union field in %s", entry, None, None, timeoutSecs, job, prepare=prepare, nameless=True)

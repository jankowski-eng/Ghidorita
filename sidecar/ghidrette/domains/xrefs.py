"""Cross references (thread R): to an address, to a stack/register variable, from a code unit."""
from ..core.args import hx, lim, text_arg
from ..core.errors import NOT_FOUND, RpcError
from ..core.rpc import rpc


class Xrefs:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    @staticmethod
    def _ref_kind(rt):
        if rt.isCall():
            return "call"
        if rt.isJump():
            return "jump"
        if rt.isRead() and rt.isWrite():
            return "readwrite"
        if rt.isRead():
            return "read"
        if rt.isWrite():
            return "write"
        if rt.isData():
            return "data"
        return "flow" if rt.isFlow() else "other"

    def _xref_to_item(self, fm, r):
        fa = r.getFromAddress()
        rt = r.getReferenceType()
        o = {"from": hx(fa.getOffset()), "type": str(rt.getName()), "kind": self._ref_kind(rt)}
        f = fm.getFunctionContaining(fa)
        if f is not None:
            o["function"] = str(f.getName())
        return o

    @rpc(lane="R")
    def xrefs_to(self, address, limit=500):
        """Memory references to `address` (calls, jumps, data reads/writes, pointers). Stack/register references target variables: see xrefs_to_variable."""
        prog = self.ses.need()
        limit, a, out = lim(limit, 500, 10000), self.ses.addr(address), []
        fm = prog.getFunctionManager()
        for r in prog.getReferenceManager().getReferencesTo(a):
            if len(out) >= limit:
                break
            out.append(self._xref_to_item(fm, r))
        out.sort(key=lambda o: int(o["from"], 16))
        return out

    @rpc(lane="R")
    def xrefs_to_variable(self, entry, name, limit=500):
        """References to a stack or register variable of the function at `entry` that the program has (a parameter or a stack local such as
        `param_1`, `local_10`, or one the user renamed), found by name. A variable the decompiler invents (`iVar1`, a register temporary)
        has no program variable: the result is empty."""
        prog = self.ses.need()
        text_arg(name, "name")
        limit, out = lim(limit, 500, 10000), []
        fm = prog.getFunctionManager()
        f = fm.getFunctionAt(self.ses.addr(entry))
        if f is None:
            raise RpcError(NOT_FOUND, "no function at %s" % entry)
        for v in f.getAllVariables():
            if str(v.getName()) == name:
                for r in prog.getReferenceManager().getReferencesTo(v):
                    if len(out) < limit:
                        out.append(self._xref_to_item(fm, r))
                break
        out.sort(key=lambda o: int(o["from"], 16))
        return out

    @rpc(lane="R")
    def xrefs_from(self, address):
        prog = self.ses.need()
        a = self.ses.addr(address)
        cu = prog.getListing().getCodeUnitContaining(a)
        a = cu.getMinAddress() if cu is not None else a
        out = []
        for r in prog.getReferenceManager().getReferencesFrom(a):
            rt = r.getReferenceType()
            o = {"type": str(rt.getName()), "kind": self._ref_kind(rt)}
            if r.isStackReference():
                off = int(r.getStackOffset())
                o.update(to=None, target="stack", label="Stack[%s0x%x]" % ("-" if off < 0 else "", abs(off)))
            elif r.isExternalReference():
                o.update(to=None, target="external", label=str(r.getLabel()))
            elif r.isRegisterReference():
                o.update(to=None, target="register", label=str(prog.getRegister(r.getToAddress()) or r.getToAddress()))
            else:
                o.update(to=hx(r.getToAddress().getOffset()), target="memory")
            out.append(o)
        return out

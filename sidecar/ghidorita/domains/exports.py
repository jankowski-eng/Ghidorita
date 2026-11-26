"""Exports: a JSON symbol map and a C header (scan lane: reads only) and a Ghidra archive (.gzf, lane R), written to a path the client picked with its native save dialog."""
import json, os, re, secrets

from ..core.args import text_arg
from ..core.errors import BUSY, INTERNAL, INVALID, RpcError, java_error
from ..core.rpc import rpc
from .listing import ROW_COMMENT_KINDS, SOURCES

C_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class Exports:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    @staticmethod
    def _target(path):
        text_arg(path, "path")
        if not os.path.isabs(path) or not os.path.isdir(os.path.dirname(path)):
            raise RpcError(INVALID, "path must be absolute, in an existing folder: %r" % path[:200])

    @staticmethod
    def _replace(path, write, check=None):
        """write(tmp) to a fresh sibling of `path`, fsync it, check(), then os.replace: a failure or cancel leaves an existing `path`
        untouched and no temp file behind. The sibling keeps the extension (an exporter may want it)."""
        root, ext = os.path.splitext(path)
        tmp = "%s.%s.tmp%s" % (root, secrets.token_hex(4), ext)
        try:
            write(tmp)
            fd = os.open(tmp, os.O_RDWR)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            if check:
                check()
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    @staticmethod
    def _text(text):
        def write(tmp):
            with open(tmp, "x", encoding="utf-8") as f:
                f.write(text)
        return write

    @rpc(lane="scan")
    def export_symbols(self, path, scan=None):
        """JSON symbol map -> `path`: {program, functions[{address,name,signature,source}], labels[{address,name,source}],
        data[{address,name,type,source}], comments[{address,kind,text}]}; source = user|imported|analysis|default|other. Memory addresses only."""
        self._target(path)
        from ghidra.program.model.listing import CodeUnit
        from ghidra.program.model.symbol import SymbolType
        with self.ctx.lanes.scanning(scan) as prog:
            fa, lst, st = self.ses.fmtr(prog), prog.getListing(), prog.getSymbolTable()
            src = lambda s: SOURCES.get(str(s.getSource()), "other")
            funcs, labels, data = [], [], []
            for n, s in enumerate(st.getAllSymbols(False)):  # False: no dynamic (auto-named) symbols; those have no name worth exporting
                if n & 255 == 0:
                    scan.check()
                a, t = s.getAddress(), s.getSymbolType()
                if not a.isMemoryAddress() or t not in (SymbolType.FUNCTION, SymbolType.LABEL):
                    continue
                if t == SymbolType.FUNCTION:
                    f = prog.getFunctionManager().getFunctionAt(a)
                    funcs.append({"address": fa(a), "name": str(s.getName()), "signature": str(f.getPrototypeString(False, False)) if f else "", "source": src(s)})
                    continue
                d = lst.getDefinedDataAt(a)
                if d is not None:
                    data.append({"address": fa(a), "name": str(s.getName()), "type": str(d.getDataType().getName()), "source": src(s)})
                else:
                    labels.append({"address": fa(a), "name": str(s.getName()), "source": src(s)})
            comments = []
            kinds = {"eol": CodeUnit.EOL_COMMENT, "pre": CodeUnit.PRE_COMMENT, "post": CodeUnit.POST_COMMENT, "plate": CodeUnit.PLATE_COMMENT, "repeatable": CodeUnit.REPEATABLE_COMMENT}
            for n, a in enumerate(lst.getCommentAddressIterator(prog.getMemory(), True)):
                if n & 255 == 0:
                    scan.check()
                for k, ct in kinds.items():
                    t = lst.getComment(ct, a)
                    if t is not None and a.isMemoryAddress():
                        comments.append({"address": fa(a), "kind": k, "text": str(t)})
            key = lambda r: (len(r["address"]), r["address"])  # shortcut: address order as text (same width within a space), upgrade with akey when mixed spaces matter
            out = {"program": str(prog.getName()), "functions": sorted(funcs, key=key), "labels": sorted(labels, key=key), "data": sorted(data, key=key), "comments": sorted(comments, key=key)}
        self._replace(path, self._text(json.dumps(out, indent=1)), scan.check)
        return {"path": path, "functions": len(funcs), "labels": len(labels), "data": len(data), "comments": len(comments)}

    @rpc(lane="scan")
    def export_header(self, path, scan=None):
        """C header -> `path` through Ghidra's DataTypeWriter: the program's structures, unions, enums and typedefs, then one prototype per
        function whose name is a plain C identifier (the others, e.g. C++ operators, are counted in `skipped`)."""
        self._target(path)
        from java.io import StringWriter
        from ghidra.program.model.data import Composite, DataTypeWriter, Enum, TypeDef
        from ghidra.util.task import TaskMonitor
        with self.ctx.lanes.scanning(scan) as prog:
            dtm, types, protos, skipped, seen = prog.getDataTypeManager(), [], [], 0, set()
            for n, dt in enumerate(dtm.getAllDataTypes()):
                if n & 255 == 0:
                    scan.check()
                if isinstance(dt, (Composite, Enum, TypeDef)) and not dt.isNotYetDefined() and C_NAME.match(str(dt.getName())):
                    types.append(dt)
            for n, f in enumerate(prog.getFunctionManager().getFunctions(True)):
                if n & 255 == 0:
                    scan.check()
                name = str(f.getName())
                if f.isExternal() or name in seen:
                    continue
                if not C_NAME.match(name):
                    skipped += 1
                    continue
                seen.add(name)
                protos.append(str(f.getPrototypeString(False, False)) + ";")
            w = StringWriter()
            DataTypeWriter(dtm, w).write(types, TaskMonitor.DUMMY)
            text = str(w.toString()) + "\n/* functions */\n" + "\n".join(protos) + "\n"  # shortcut: prototypes use Ghidra's type names (undefined8 ...), upgrade by typedef-ing them
        self._replace(path, self._text(text), scan.check)
        return {"path": path, "types": len(types), "functions": len(protos), "skipped": skipped}

    @rpc(lane="R")
    def export_gzf(self, path):
        """Ghidra archive -> `path` through GzfExporter (the whole database as a packed .gzf that Ghidra's importer opens). Lane R: it reads
        the entire database, so no edit can be half-applied while it runs. It exports what is in memory, unsaved edits included (the project
        copy is not touched). Not cancellable (shortcut: TaskMonitor.DUMMY, upgrade with a scan-lane monitor if big programs make the wait
        noticeable). `Busy` while background analysis runs: the analysis holds the program's one open transaction, which an export must not capture."""
        self._target(path)
        prog = self.ses.need()
        if self.ses.analyzing:
            raise RpcError(BUSY, "analysis running")
        import jpype
        from java.io import File
        from ghidra.app.util.exporter import GzfExporter
        from ghidra.util.task import TaskMonitor
        if os.path.isdir(path):
            raise RpcError(INVALID, "path is a folder: %r" % path[:200])
        exp = GzfExporter()

        def write(tmp):
            try:
                ok = bool(exp.export(File(tmp), prog, None, TaskMonitor.DUMMY))
            except jpype.JException as e:
                raise java_error(e)
            if not ok:
                raise RpcError(INTERNAL, "export failed: " + str(exp.getMessageLog().toString())[:500])
        self._replace(path, write)
        return {"path": path, "bytes": os.path.getsize(path)}

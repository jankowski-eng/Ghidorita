"""Data types: search, the tree, detail, and the struct/enum/typedef editors (reads on R; every edit is one transaction, so one undo step)."""
from ..core.args import lim, name_arg, text_arg
from ..core.errors import INVALID, NOT_FOUND, RpcError, java_error
from ..core.rpc import rpc


class DataTypes:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session

    @rpc(lane="scan")
    def list_data_types(self, query, limit=100, scan=None):
        """Scan worker (thread S): walks every program and built-in type, so it must not hold up listing fetches on R."""
        from ghidra.program.model.data import BuiltInDataTypeManager
        with self.ctx.lanes.scanning(scan) as prog:
            text_arg(query, "query")
            limit, q = lim(limit, 100, 1000), query.strip().lower()
            hits, seen, n = [], set(), 0
            for src, dtm in (("program", prog.getDataTypeManager()), ("builtin", BuiltInDataTypeManager.getDataTypeManager())):  # program first: its types shadow built-ins of the same path
                for dt in dtm.getAllDataTypes():
                    n += 1
                    if n & 255 == 0:
                        scan.check()
                    name = str(dt.getName())
                    if q in name.lower() and str(dt.getPathName()) not in seen:
                        seen.add(str(dt.getPathName()))
                        hits.append((0 if name.lower().startswith(q) else 1, len(name), dict(self._dt_node(dt), source=src)))
            hits.sort(key=lambda h: h[:2])
            return [h[2] for h in hits[:limit]]

    @staticmethod
    def _dt_kind(dt):
        from ghidra.program.model.data import Array, Enum, FunctionDefinition, Pointer, Structure, TypeDef, Union
        for cls, k in ((Structure, "struct"), (Union, "union"), (Enum, "enum"), (TypeDef, "typedef"), (Pointer, "pointer"),
                       (FunctionDefinition, "function"), (Array, "array")):
            if isinstance(dt, cls):
                return k
        return "builtin"

    def _dt_node(self, dt):
        # an empty struct reports length 1 from getLength(); show 0 (isNotYetDefined)
        size = 0 if dt.isNotYetDefined() else int(dt.getLength())
        return {"name": str(dt.getName()), "path": str(dt.getPathName()), "kind": self._dt_kind(dt), "size": size}

    def _dtm(self, source):
        from ghidra.program.model.data import BuiltInDataTypeManager
        if source in (None, "program"):
            return self.ses.need().getDataTypeManager()
        if source == "builtin":
            self.ses.need()
            return BuiltInDataTypeManager.getDataTypeManager()
        raise RpcError(INVALID, "unknown data type source %r" % (source,))

    @rpc(lane="R")
    def dt_sources(self):
        return [{"id": "program", "name": str(self.ses.need().getName()), "writable": True},
                {"id": "builtin", "name": "BuiltInTypes", "writable": False}]

    @rpc(lane="R")
    def dt_children(self, source="program", path="/"):
        from ghidra.program.model.data import CategoryPath
        dtm = self._dtm(source)
        cat = dtm.getCategory(CategoryPath(text_arg(path, "path")))
        if cat is None:
            raise RpcError(NOT_FOUND, "no category %s" % path)
        cats = [{"name": str(c.getName()), "path": str(c.getCategoryPath().getPath())} for c in cat.getCategories()]
        types = [self._dt_node(dt) for dt in cat.getDataTypes()]
        return {"categories": sorted(cats, key=lambda c: c["name"].lower()), "types": sorted(types, key=lambda t: t["name"].lower())}

    def _get_dt(self, dtm, path, what="data type"):
        dt = dtm.getDataType(text_arg(path, "path"))
        if dt is None:
            raise RpcError(NOT_FOUND, "no %s %s" % (what, path))
        return dt

    @rpc(lane="R")
    def get_data_type(self, path, source="program"):
        dtm = self._dtm(source)
        dt = self._get_dt(dtm, path)
        k = self._dt_kind(dt)
        o = self._dt_node(dt)
        sa = dt.getSourceArchive()
        o.update(source=source or "program", writable=(source or "program") == "program", description=str(dt.getDescription() or ""),
                 archive=(str(sa.getName()) if sa is not None and str(sa.getArchiveType()) in ("FILE", "PROJECT") else None))
        if k in ("struct", "union"):
            o["packed"] = bool(dt.isPackingEnabled())
            o["packingValue"] = int(dt.getExplicitPackingValue()) if dt.hasExplicitPackingValue() else None
            o["minAlign"] = int(dt.getExplicitMinimumAlignment()) if dt.hasExplicitMinimumAlignment() else None
            o["alignment"] = int(dt.getAlignment())
            o["components"] = [{"ordinal": int(c.getOrdinal()), "offset": int(c.getOffset()), "length": int(c.getLength()),
                                "type": str(c.getDataType().getDisplayName()), "typePath": str(c.getDataType().getPathName()),
                                "name": str(c.getFieldName()) if c.getFieldName() is not None else None,
                                "defaultName": str(c.getDefaultFieldName()),
                                "comment": str(c.getComment()) if c.getComment() is not None else None,
                                "undefined": bool(c.isUndefined()), "bitfield": bool(c.isBitFieldComponent())}
                               for c in dt.getComponents()]
        elif k == "enum":
            vals = sorted(((int(dt.getValue(n)), str(n)) for n in dt.getNames()))
            o["values"] = [{"name": n, "value": str(v)} for v, n in vals]
        elif k in ("typedef", "pointer", "array"):
            t = dt.getDataType()
            o["base"] = str(t.getDisplayName()) if t is not None else "void"
            o["basePath"] = str(t.getPathName()) if t is not None else None
            if k == "array":
                o["elements"] = int(dt.getNumElements())
        elif k == "function":
            o["signature"] = str(dt.getPrototypeString())
        return o

    def _parse_type(self, dtm, text, allowed="FIXED_LENGTH"):
        from ghidra.program.model.data import DataTypeConflictHandler
        from ghidra.util.data import DataTypeParser
        from ghidra.util.data.DataTypeParser import AllowedDataTypes
        text_arg(text, "type")
        if not text.strip():
            raise RpcError(INVALID, "empty type")
        try:
            dt = DataTypeParser(dtm, dtm, None, getattr(AllowedDataTypes, allowed)).parse(text.strip())
        except Exception as e:  # noqa  (ParseException or whatever the parser throws on junk)
            raise RpcError(INVALID, "unknown data type %r: %s" % (text, e))
        if dt is None:
            raise RpcError(INVALID, "unknown data type %r" % (text,))
        return dtm.resolve(dt, DataTypeConflictHandler.DEFAULT_HANDLER)

    def _writable_dt(self, path, kinds):
        dtm = self.ses.need().getDataTypeManager()
        dt = self._get_dt(dtm, path)
        if self._dt_kind(dt) not in kinds:
            raise RpcError(INVALID, "%s is a %s, not a %s" % (path, self._dt_kind(dt), "/".join(kinds)))
        return dtm, dt

    @rpc(lane="R")
    def create_data_type(self, kind, name=None, category="/", size=None, base=None):
        from ghidra.program.model.data import (CategoryPath, DataTypeConflictHandler, EnumDataType, PointerDataType,
                                               StructureDataType, TypedefDataType, UnionDataType)
        prog = self.ses.need()
        dtm = prog.getDataTypeManager()
        if kind not in ("struct", "union", "enum", "typedef", "pointer", "category"):
            raise RpcError(INVALID, "bad kind %r" % (kind,))
        cp = CategoryPath(text_arg(category, "category"))
        if kind != "pointer":
            name_arg(name)
        size = lim(size, 4 if kind == "enum" else 0, 1 << 20)
        if kind == "enum" and size not in (1, 2, 4, 8):
            raise RpcError(INVALID, "enum size must be 1, 2, 4 or 8")
        out = {}

        def go(p):
            if kind == "category":
                if dtm.getCategory(CategoryPath(cp, name)) is not None:
                    raise RpcError(INVALID, "category %s already exists" % name)
                out["path"] = str(dtm.createCategory(CategoryPath(cp, name)).getCategoryPath().getPath())
                return
            if kind == "pointer":
                dt = dtm.resolve(PointerDataType(self._parse_type(dtm, base, "ALL"), dtm), DataTypeConflictHandler.DEFAULT_HANDLER)
            else:
                if dtm.getDataType(cp, name) is not None:  # DEFAULT_HANDLER would silently create "name.conflict"
                    raise RpcError(INVALID, "%s already exists in %s" % (name, category))
                if kind == "typedef":
                    new = TypedefDataType(cp, name, self._parse_type(dtm, base, "ALL"), dtm)
                else:
                    new = {"struct": lambda: StructureDataType(cp, name, size, dtm), "union": lambda: UnionDataType(cp, name, dtm),
                           "enum": lambda: EnumDataType(cp, name, size, dtm)}[kind]()
                dt = dtm.resolve(new, DataTypeConflictHandler.KEEP_HANDLER)
            out["path"] = str(dt.getPathName())
        self.ses.edit("Create %s %s" % (kind, name or "pointer"), go)
        return out

    @rpc(lane="R")
    def delete_data_type(self, path, category=False):
        from ghidra.program.model.data import CategoryPath
        from ghidra.util.task import TaskMonitor
        dtm = self.ses.need().getDataTypeManager()

        def go(p):
            if category:
                cat = dtm.getCategory(CategoryPath(text_arg(path, "path")))
                if cat is None:
                    raise RpcError(NOT_FOUND, "no category %s" % path)
                if cat.getParent() is None or not cat.getParent().removeEmptyCategory(cat.getName(), TaskMonitor.DUMMY):
                    raise RpcError(INVALID, "category %s is the root or not empty" % path)
            elif not dtm.remove(self._get_dt(dtm, path)):
                raise RpcError(INVALID, "could not delete %s" % path)
        self.ses.edit("Delete %s" % path, go)
        return {}

    @rpc(lane="R")
    def rename_data_type(self, path, newName):
        dtm = self.ses.need().getDataTypeManager()
        dt = self._get_dt(dtm, path)
        name_arg(newName, "newName")
        self.ses.edit("Rename data type %s to %s" % (dt.getName(), newName), lambda p: dt.setName(newName))
        return {"path": str(dt.getPathName())}

    @staticmethod
    def _comp_len(c):  # -1 = rely on the type's own size (fixed length); dynamic types need the explicit length
        return -1 if c.getDataType().getLength() > 0 else int(c.getLength())

    @rpc(lane="R")
    def edit_struct(self, path, op):
        dtm, dt = self._writable_dt(path, ("struct", "union"))
        is_struct = self._dt_kind(dt) == "struct"
        if not isinstance(op, dict):
            raise RpcError(INVALID, "op must be an object")
        o = op.get("op")
        n = int(dt.getNumComponents())

        def ordinal(hi):
            i = op.get("ordinal")
            if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < hi:
                raise RpcError(INVALID, "ordinal out of range")
            return i

        def text(key):
            v = op.get(key)
            if v is not None and not isinstance(v, str):
                raise RpcError(INVALID, "%s must be a string" % key)
            return v or None

        def go(p):
            if o == "add":
                dt.add(self._parse_type(dtm, op.get("type")), -1, text("name"), text("comment"))
            elif o == "insert":
                dt.insert(ordinal(n + 1), self._parse_type(dtm, op.get("type")), -1, text("name"), text("comment"))
            elif o == "set":
                c = dt.getComponent(ordinal(n))
                if c.isBitFieldComponent():
                    raise RpcError(INVALID, "bit-field components cannot be edited here")
                if op.get("type") is not None:
                    new, ln = self._parse_type(dtm, op["type"]), -1
                elif c.isUndefined():
                    raise RpcError(INVALID, "give a type for an undefined byte")
                else:
                    new, ln = c.getDataType(), self._comp_len(c)
                name = text("name") if "name" in op else c.getFieldName()
                comment = text("comment") if "comment" in op else c.getComment()
                dt.replace(int(op["ordinal"]), new, ln, name, comment)
            elif o == "delete":
                dt.delete(ordinal(n))
            elif o == "clear":
                i = ordinal(n)
                dt.clearComponent(i) if is_struct else dt.delete(i)
            elif o == "move":
                i, to = ordinal(n), op.get("to")
                if not isinstance(to, int) or isinstance(to, bool) or not 0 <= to < n:
                    raise RpcError(INVALID, "to out of range")
                if is_struct and not dt.isPackingEnabled():
                    raise RpcError(INVALID, "unpacked structure fields have fixed offsets: pack the structure, or delete and insert")
                c = dt.getComponent(i)
                if c.isBitFieldComponent():
                    raise RpcError(INVALID, "bit-field components cannot be moved")
                t, ln, nm, cm = c.getDataType(), self._comp_len(c), c.getFieldName(), c.getComment()
                dt.delete(i)
                dt.insert(to, t, ln, nm, cm)
            elif o == "resize":
                size = op.get("size")
                if not is_struct or dt.isPackingEnabled():
                    raise RpcError(INVALID, "only unpacked structures can be resized")
                if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= 1 << 20:
                    raise RpcError(INVALID, "bad size")
                dt.setLength(size)
            elif o == "pack":
                if not isinstance(op.get("packed"), bool):
                    raise RpcError(INVALID, "packed must be a boolean")
                dt.setPackingEnabled(op["packed"])
                if op["packed"]:
                    pv, ma = op.get("packingValue"), op.get("minAlign")
                    for v in (pv, ma):
                        if v is not None and (not isinstance(v, int) or isinstance(v, bool) or v < 0):
                            raise RpcError(INVALID, "bad packing value")
                    dt.setExplicitPackingValue(pv) if pv else dt.setToDefaultPacking()
                    if ma is not None:
                        dt.setExplicitMinimumAlignment(ma)
            else:
                raise RpcError(INVALID, "bad op %r" % (o,))
        self.ses.edit("Edit %s: %s" % (dt.getName(), o), go)
        return {}

    @staticmethod
    def _enum_value(v):
        try:
            i = int(v, 0) if isinstance(v, str) else v
        except ValueError:
            i = None
        if not isinstance(i, int) or isinstance(i, bool) or not -(1 << 63) <= i < (1 << 64):
            raise RpcError(INVALID, "bad enum value %r" % (v,))
        return i - (1 << 64) if i >= 1 << 63 else i  # Java long

    @rpc(lane="R")
    def edit_enum(self, path, op):
        dtm, dt = self._writable_dt(path, ("enum",))
        if not isinstance(op, dict):
            raise RpcError(INVALID, "op must be an object")
        o = op.get("op")

        def go(p):
            if o == "set":
                name, old = name_arg(op.get("name")), op.get("oldName", op.get("name"))
                val = self._enum_value(op.get("value"))
                if old != name and dt.contains(name):
                    raise RpcError(INVALID, "duplicate name %s" % name)
                if dt.contains(text_arg(old, "oldName")):
                    dt.remove(old)
                dt.add(name, val)
            elif o == "remove":
                if not dt.contains(text_arg(op.get("name"), "name")):
                    raise RpcError(NOT_FOUND, "no entry %s" % op.get("name"))
                dt.remove(op["name"])
            elif o == "resize":
                if op.get("size") not in (1, 2, 4, 8):
                    raise RpcError(INVALID, "enum size must be 1, 2, 4 or 8")
                # EnumDB has no setLength: like Ghidra's own editor, replace the type by a copy of the new size (instances follow)
                from ghidra.program.model.data import EnumDataType
                new = EnumDataType(dt.getCategoryPath(), dt.getName(), op["size"], dtm)
                new.setDescription(dt.getDescription())
                for n in dt.getNames():
                    new.add(n, dt.getValue(n), dt.getComment(n))
                dtm.replaceDataType(dt, new, True)
            else:
                raise RpcError(INVALID, "bad op %r" % (o,))
        self.ses.edit("Edit %s: %s" % (dt.getName(), o), go)
        return {}

    @rpc(lane="R")
    def create_struct_from_data(self, address, length, name, category="/", apply=True):
        from ghidra.app.cmd.data import CreateDataCmd
        from ghidra.program.model.data import CategoryPath, DataTypeConflictHandler, StructureDataType
        from ghidra.program.model.listing import Instruction
        prog = self.ses.need()
        dtm, a, cp = prog.getDataTypeManager(), self.ses.addr(address), CategoryPath(text_arg(category, "category"))
        name_arg(name)
        length = lim(length, 0, 1 << 20)
        if length < 1 or not prog.getMemory().contains(a) or not prog.getMemory().contains(a.add(length - 1)):
            raise RpcError(INVALID, "range is not in memory")
        if dtm.getDataType(cp, name) is not None:
            raise RpcError(INVALID, "%s already exists in %s" % (name, category))

        def go(p):
            st, off = StructureDataType(cp, name, length, dtm), 0
            while off < length:
                cu = p.getListing().getCodeUnitContaining(a.add(off))
                if cu is None or cu.getMinAddress().compareTo(a.add(off)) != 0:
                    raise RpcError(INVALID, "the range must start and end on data item boundaries")
                if isinstance(cu, Instruction):
                    raise RpcError(INVALID, "instructions cannot be part of a structure")
                if cu.isDefined():
                    if off + cu.getLength() > length:
                        raise RpcError(INVALID, "the range must start and end on data item boundaries")
                    st.replaceAtOffset(off, cu.getDataType(), int(cu.getLength()), None, None)
                off += int(cu.getLength())
            dt = dtm.resolve(st, DataTypeConflictHandler.KEEP_HANDLER)
            if apply:
                self.ses.cmd(CreateDataCmd(a, True, False, dt))(p)
        self.ses.edit("Create structure %s" % name, go)
        if apply:
            self.ctx.events.record({"data"}, [self.ses.rng(a, a.add(length - 1))])
        return {"path": str(dtm.getDataType(cp, name).getPathName())}

    C_LIMIT = 200_000

    @rpc(lane="R")
    def parse_c_types(self, c, category="/"):
        """Ghidra's CParser into a scratch manager, then resolved into the program's with REPLACE_HANDLER in one transaction (one undo step, all or
        nothing). CParser cannot target a category (it derives it from a header file name), so a non-root category is applied in the scratch first."""
        import jpype
        from ghidra.app.util.cparser.C import CParser
        from ghidra.program.database.data import TransientDataTypeManager
        from ghidra.program.model.data import CategoryPath, Composite, DataTypeConflictHandler, DataTypeManager
        dtm = self.ses.need().getDataTypeManager()
        if not isinstance(c, str) or not c.strip():
            raise RpcError(INVALID, "c must be non-empty C source")
        if len(c) > self.C_LIMIT:
            raise RpcError(INVALID, "c is %d characters; the limit is %d" % (len(c), self.C_LIMIT))
        text_arg(category, "category")
        if not category.startswith("/"):
            raise RpcError(INVALID, "category must be a path like /MyTypes")
        cp = CategoryPath(category)
        out = {"created": [], "replaced": []}
        scratch = TransientDataTypeManager("c", dtm.getDataOrganization())  # the program's sizes: long, pointers
        try:
            parser = CParser(scratch, True, jpype.JArray(DataTypeManager)([dtm]))  # types already in the program resolve by name
            try:
                parser.parse(c)
            except jpype.JException as e:
                if str(e.getClass().getSimpleName()) not in ("ParseException", "TokenMgrError"):
                    raise java_error(e)
                tok, msg = getattr(e, "currentToken", None), "\n".join(str(e.getMessage() or "").strip().split("\n")[:6])  # "Was expecting one of" can run to hundreds of lines
                line = " near line %d" % tok.beginLine if tok is not None and tok.beginLine > 0 and "line " not in msg else ""
                raise RpcError(INVALID, "C parse error%s: %s" % (line, msg[:600]))
            declared, uses = {}, []
            for m in (parser.getComposites(), parser.getEnums(), parser.getTypes(), parser.getFunctions()):
                for dt in m.values():
                    # a type is classified against where it will live (the target category); the lookup at its parsed (root) path is only for what the C merely refers to
                    old = dtm.getDataType(cp, dt.getName()) if not cp.isRoot() else dtm.getDataType(dt.getDataTypePath())
                    if old is None and not cp.isRoot() and isinstance(dt, Composite) and dt.getNumComponents() == 0:
                        old = dtm.getDataType(dt.getDataTypePath())  # an empty composite is `struct Base b;`: the program's `Base`, wherever it is
                    if old is None:
                        declared[str(dt.getPathName())] = dt
                    elif isinstance(dt, Composite) and dt.getNumComponents() == 0 and not old.isEquivalent(dt):
                        uses.append((dt, old))  # `struct Base b;` makes the parser declare an empty `Base` (it does not look the tag up in the program)
                    elif not old.isEquivalent(dt):
                        declared[str(dt.getPathName())] = dt
            tx = scratch.startTransaction("prepare")
            for ph, old in uses:  # put the program's real type in the placeholder's place, so nothing declared points at the empty one and it never replaces the real one
                real = scratch.resolve(old, DataTypeConflictHandler.REPLACE_HANDLER)
                if str(real.getDataTypePath()) != str(ph.getDataTypePath()):  # the real one lives in the target category: resolving it did not touch the placeholder at the root
                    scratch.replaceDataType(ph, real, False)
            if not cp.isRoot():
                for dt in declared.values():
                    dt.setCategoryPath(cp)
            scratch.endTransaction(tx, True)
            def go(p):
                for dt in declared.values():  # classified before anything is resolved: resolving one type also resolves what it points at
                    old = dtm.getDataType(dt.getCategoryPath(), dt.getName())
                    if old is None:
                        out["created"].append(str(dt.getPathName()))
                    elif not old.isEquivalent(dt):
                        out["replaced"].append(str(dt.getPathName()))
                for dt in declared.values():
                    dtm.resolve(dt, DataTypeConflictHandler.REPLACE_HANDLER)
            self.ses.edit("Define types from C", go)
        finally:
            scratch.close()
        cell = self.ses.current_cell()
        if cell and not out["created"] and not out["replaced"]:  # nothing changed: the undo name the edit reported belongs to an older step
            cell.pop("undoName", None)
        out["created"].sort(), out["replaced"].sort()
        return out

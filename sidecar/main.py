#!/usr/bin/env python3
"""Ghidra sidecar: JSON-RPC 2.0 over WebSocket (see ../protocol.md for the contract and the threading rules).

Threads: the asyncio loop (dispatch, cancel_*), R (all program reads and ALL writes), O (one open_binary at a time:
import + analysis + save), N decompiler workers sharing one queue, each owning a DecompInterface, and M scan workers
(S) sharing one queue for the slow reads that must never delay listing fetches: symbol table, strings, memory search.
"""
import asyncio, datetime, hashlib, json, os, re, signal, sys, threading, time
from collections import OrderedDict

from ghidrette.core.args import hx, lim, name_arg, text_arg
from ghidrette.core.context import Ctx
from ghidrette.core.lanes import Job, Opening, Scan
from ghidrette.core.server import Server
from ghidrette.core.session import undo_state
from ghidrette.core.errors import (BUSY, CANCELLED, INTERNAL, INVALID, INVALID_JAVA, NO_METHOD, NO_PROGRAM, NOT_FOUND,
                                   PROJECT_LOCKED, TIMEOUT, RpcError, log)

KINDS = {0: "keyword", 1: "comment", 2: "type", 3: "function", 4: "variable", 5: "const",
         6: "param", 7: "variable", 8: "default", 9: "default", 10: "default"}
# kinds whose cache effect is fully described by their ranges (everything else clears the whole decompile cache)
RANGE_ONLY_KINDS = {"comment", "code"}
ROW_COMMENT_KINDS = {"eol": "comment", "pre": "pre", "post": "post", "plate": "plate", "repeatable": "repeatable"}  # CommentType name -> row field


def _akey(s):
    """Sort key of a protocol address string: its offset (qualified addresses carry the space before the last ':')."""
    return int(s.rpartition(":")[2], 16)
# analysis profiles (open_binary `profile`): "fast" switches these off for the first-open analysis (measured in SPIKE_REPORT round 4)
FAST_PROFILE = ["Call Convention ID", "Decompiler Switch Analysis", "Stack"]
RAW = "Raw Binary"  # BinaryLoader.BINARY_NAME: the only stock loader with a base address option ("-loader-baseAddr")
KEY_RE = re.compile(r"^[0-9a-f]{64}(-[0-9a-f]{12})?$")


STRING_VALUE_CAP = 1000


class _SymSnap:
    """list_symbols default view: the live by-address iterator and the rows pulled from it so far."""
    def __init__(self, it, total):
        self.it, self.total, self.syms, self.lock = it, total, [], threading.Lock()


class Sidecar:
    def __init__(self):
        self.ctx = ctx = Ctx()
        self.cache = OrderedDict()   # entry offset -> (lo, hi, result); cache_lock
        self.cache_ver = 0
        self.cache_lock = threading.Lock()
        self.proj = self.gp = None
        self.proj_lock = threading.Lock()  # held by thread O for a whole open, briefly by R for list/delete/candidates: never concurrent
        self.snaps = OrderedDict()   # (kind, ...) -> snapshot of a slow read, LRU; snap_lock. Dropped on any program change.
        self.snap_ver = 0
        self.snap_lock = threading.Lock()
        ctx.events.subscribe(self._invalidate)
        ctx.shutdown_hooks += [lambda: self._close(), self._close_project]
        self.server = Server(ctx, self.handle)
        ctx.lanes.start()

    def _invalidate(self, kinds, ranges, broad):
        self.snap_clear()
        # decompile output embeds names/types of other symbols, so only comment/code changes are ranged; shortcut:
        # symbol/function/data/type/other changes clear the whole cache, upgrade by tracking referenced addresses per entry.
        if ranges is None or not kinds <= RANGE_ONLY_KINDS:
            self.cache_clear()
        else:
            self.cache_invalidate(ranges)

    def fmtr(self, prog=None):
        """-> function Address -> protocol string (the default space as "0x..", others space-qualified); one lookup of the default space."""
        dsid = (prog or self.need()).getAddressFactory().getDefaultAddressSpace().getSpaceID()

        def f(a):
            sp = a.getAddressSpace()
            off = a.getOffset() & MASK64
            if sp.getSpaceID() == dsid:
                return "0x%x" % off
            return "%s%s%x" % (sp.getName(), "::" if sp.isOverlaySpace() else ":", off)
        return f

    def fmt(self, a, prog=None):
        return self.fmtr(prog)(a)

    def _rng(self, lo, hi):
        """Pending change range: (space name, first offset, last offset), unsigned."""
        return (str(lo.getAddressSpace().getName()), lo.getOffset() & MASK64, hi.getOffset() & MASK64)

    @staticmethod
    def _projects_dir():
        return os.environ.get("SIDECAR_PROJECTS_DIR") or os.path.expanduser("~/Library/Application Support/ghidra-desktop-spike/projects")

    def _project(self):
        """One Ghidra project for all programs, programs named by their programId. Only with proj_lock held (thread O
        during an open, thread R for list/delete).
        A second sidecar on the same projects dir gets PROJECT_LOCKED (retried on every call, so it works once the other quits)."""
        if self.proj is None:
            import jpype
            from ghidra.base.project import GhidraProject
            from ghidra.framework.model import ProjectLocator
            d = self._projects_dir()
            os.makedirs(d, exist_ok=True)
            # GhidraProject, not pyghidra.open_project: that one builds a GUI-oriented DefaultProjectManager which hangs headless here
            try:
                gp = (GhidraProject.openProject(d, "spike", True) if ProjectLocator(d, "spike").exists()
                      else GhidraProject.createProject(d, "spike", False))
            except jpype.JException as e:
                if str(e.getClass().getSimpleName()) == "LockException":
                    raise RpcError(PROJECT_LOCKED, "projects dir in use by another Ghidrette (%s)" % d)
                raise
            self.gp, self.proj = gp, gp.getProject()
        return self.proj

    def _close_project(self):
        """Shutdown only (thread R, after _close): release the project so Ghidra removes its lock files."""
        if not self.proj_lock.acquire(timeout=30):  # an open that does not stop: leave the project to the OS, Ghidra detects the stale lock
            log("project still in use by an open, not closing it")
            return
        try:
            gp, self.gp, self.proj = self.gp, None, None
            if gp is not None:
                gp.close()
        except Exception as e:  # noqa
            log("project close failed:", repr(e))
        finally:
            self.proj_lock.release()

    # ---- program browser metadata ----
    # list_programs needs sourcePath/sizeBytes/options/lastOpened/analyzed. They live in programs.json next to the project
    # (not as Program properties: writing those would leave the freshly opened program dirty). Written atomically; a
    # program without an entry (project from before this file) is listed with name = id, sizeBytes 0, analyzed true.
    def _meta_path(self):
        return os.path.join(self._projects_dir(), "programs.json")

    def _meta_load(self):
        try:
            with open(self._meta_path()) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _meta_save(self, meta):
        p = self._meta_path()
        with open(p + ".tmp", "w") as f:
            json.dump(meta, f)
        os.replace(p + ".tmp", p)

    def _meta_touch(self, key, **fields):
        meta = self._meta_load()
        e = meta.setdefault(key, {})
        e.update(fields, lastOpened=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self._meta_save(meta)

    class _ProjGuard:
        """Non-blocking proj_lock for R-side project users: Busy while an open runs."""
        def __init__(self, sc):
            self.sc = sc

        def __enter__(self):
            if self.sc.opening is not None or not self.sc.proj_lock.acquire(blocking=False):
                raise RpcError(BUSY, "open_binary in progress")

        def __exit__(self, *a):
            self.sc.proj_lock.release()

    # ---- import options / program browser (thread R, Busy during an open) ----
    def list_languages(self):
        from ghidra.program.util import DefaultLanguageService
        out = []
        for d in DefaultLanguageService.getLanguageService().getLanguageDescriptions(False):
            out.append({"id": str(d.getLanguageID()), "description": str(d.getDescription()),
                        "compilerSpecs": [{"id": str(c.getCompilerSpecID()), "name": str(c.getCompilerSpecName())}
                                          for c in d.getCompatibleCompilerSpecDescriptions()]})
        out.sort(key=lambda o: o["id"])
        return out

    def import_candidates(self, path):
        from java.io import File
        from ghidra.app.util.importer import LoadSpecChooser
        from ghidra.app.util.opinion import LoaderService
        from ghidra.formats.gfilesystem import FileSystemService
        from ghidra.util.task import TaskMonitor
        text_arg(path, "path")
        if not os.path.isfile(path):
            raise RpcError(NOT_FOUND, "no such file: %s" % path)
        with self._ProjGuard(self):
            fs = FileSystemService.getInstance()
            p = fs.getByteProvider(fs.getLocalFSRL(File(path)), True, TaskMonitor.DUMMY)
            try:
                lm = LoaderService.getAllSupportedLoadSpecs(p, TaskMonitor.DUMMY)
                chosen = LoadSpecChooser.CHOOSE_THE_FIRST_PREFERRED.choose(lm)
                size = os.path.getsize(path)
                if chosen is None:  # only Raw Binary (always offered, needs a language) applies: "nothing recognises the file"
                    return {"candidates": [], "sizeBytes": size}
                out = []
                for e in lm.entrySet():
                    loader = str(e.getKey().getName())
                    if loader == RAW:  # one spec per installed language: collapse to a single "pick a language" entry
                        out.append({"loader": loader, "language": None, "compilerSpec": None, "preferred": False, "acceptsBaseAddress": True})
                        continue
                    for spec in e.getValue():
                        lcs = spec.getLanguageCompilerSpec()
                        out.append({"loader": loader,
                                    "language": str(lcs.languageID) if lcs is not None else None,
                                    "compilerSpec": str(lcs.compilerSpecID) if lcs is not None else None,
                                    "preferred": spec == chosen,
                                    "acceptsBaseAddress": loader == RAW})
                return {"candidates": out, "sizeBytes": size}
            finally:
                p.close()

    def list_programs(self):
        with self._ProjGuard(self):
            meta, out = self._meta_load(), []
            for f in self._project().getProjectData().getRootFolder().getFiles():
                key = str(f.getName())
                m = meta.get(key, {})
                e = {"programId": key, "name": m.get("name", key), "sizeBytes": m.get("sizeBytes", 0),
                     "analyzed": m.get("analyzed", True), "options": m.get("options", {})}
                for k in ("sourcePath", "lastOpened"):
                    if k in m:
                        e[k] = m[k]
                out.append(e)
            out.sort(key=lambda e: e.get("lastOpened", ""), reverse=True)
            return out

    def delete_program(self, programId):
        text_arg(programId, "programId")
        with self._ProjGuard(self):
            if programId == self.program_id:
                raise RpcError(BUSY, "program is open")
            f = self._project().getProjectData().getFile("/" + programId) if KEY_RE.match(programId) else None
            if f is None:
                raise RpcError(NOT_FOUND, "no such program: %s" % programId)
            f.delete()
            meta = self._meta_load()
            if meta.pop(programId, None) is not None:
                self._meta_save(meta)
        return {}

    def close_program(self):
        if self.opening is not None:
            raise RpcError(BUSY, "open_binary in progress")
        try:
            self._close(strict=True)  # a failed save keeps the program (and its edits) open instead of reporting success
        except RuntimeError as e:
            raise RpcError(INTERNAL, str(e))
        return {}

    # ---- program lifecycle ----
    def _close(self, strict=False):
        """Run on thread R. Order matters: stop new decompiles, cancel running ones, wait until every worker
        disposed its DecompInterface (on its own thread), only then release the program."""
        prog, res, consumer = self.program, self.results, self.consumer
        if prog is not None:  # autosave: closing must never lose edits (see protocol.md, Persistence and crash safety)
            try:
                self._save_program(prog, "close")
            except Exception as e:  # noqa
                if strict:  # replacing the program (open_binary): keep it open rather than drop its unsaved edits
                    log("close save FAILED, keeping the program open:", repr(e))
                    raise RuntimeError("save failed before closing the current program, not opening another: %s" % e)
                log("close save FAILED, edits lost:", repr(e))
        with self.pool_lock:
            self.program = None
            self.epoch += 1
            for j in list(self.running):
                with self.mon_lock:
                    j.cancelled = True
                    if j.mon is not None:
                        j.mon.cancel()
            for sc in list(self.active):
                sc.cancel()
        self.ctx.events.detach(prog)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and (self.active or any(w.busy or w.decomp is not None for w in self.workers)):
            time.sleep(0.02)
        stuck = bool(self.active) or any(w.busy or w.decomp is not None for w in self.workers)
        if stuck:
            log("decompiler or scan worker still busy after 10 s: leaking the old program instead of releasing it under a live reader")
        self.ctx.events.reset()
        self.results = self.consumer = None
        if not stuck:
            if res is not None:
                res.close()
            elif prog is not None:
                prog.release(consumer)
        self.undo_snap = {"canUndo": False, "canRedo": False, "dirty": False}
        self.program_id = None

    def _save_program(self, prog, why):
        """Write prog to its project file if it has unsaved changes (thread R; no transaction may be open).
        Safe while decompiles run (they only read). Returns whether anything was written."""
        from ghidra.util.task import TaskMonitor
        with self.save_lock:
            if not prog.isChanged():
                return False
            t0 = time.monotonic()
            prog.getDomainFile().save(TaskMonitor.DUMMY)
            if why != "save":
                log("%s save took %.2fs" % (why, time.monotonic() - t0))
            return True

    def save(self):
        prog = self.need()
        saved = self._save_program(prog, "save")
        self.refresh_undo(prog)
        if saved:  # Ghidra's save drops the undo/redo stacks and clears dirty: tell the client (empty ranges/kinds = nothing to refetch)
            self.notify("program_changed", {"ranges": [], "kinds": [], "undo": self.undo_snap})
        return {"saved": saved}

    def _publish(self, prog, res, consumer, op, key):
        from ghidra.app.plugin.core.analysis import AutoAnalysisManager
        with op.lock:  # commit point: after this cancel_open answers false, before it the open still fails with Cancelled
            if op.cancelled:
                raise RpcError(CANCELLED, "open cancelled")
            op.saving = True
        prog.clearUndo()  # the analysis transaction must not be undoable
        # follow-on analysis would write from the manager's own thread, outside R and outside our transactions
        AutoAnalysisManager.getAnalysisManager(prog).setIgnoreChanges(True)
        self.ctx.events.attach(prog)  # only now: progress covers the initial analysis
        self.results, self.consumer = res, consumer
        self.undo_snap = {"canUndo": False, "canRedo": False, "dirty": False}  # just cleared and saved; no Program read on thread O
        self.program_id = key
        with self.pool_lock:
            self.epoch += 1
            self.program = prog

    @staticmethod
    def _check_options(loader, language, compilerSpec, baseAddress):
        """Validate and normalise import options; returns the options dict (present fields only, baseAddress as 0x<hex>)."""
        from ghidra.app.util.opinion import LoaderService
        from ghidra.program.model.lang import CompilerSpecID, LanguageID
        from ghidra.program.util import DefaultLanguageService
        for v, what in ((loader, "loader"), (language, "language"), (compilerSpec, "compilerSpec"), (baseAddress, "baseAddress")):
            if v is not None:
                text_arg(v, what)
        opts = {}
        if loader is not None:
            if loader not in {str(n) for n in LoaderService.getAllLoaderNames()}:
                raise RpcError(INVALID, "unknown loader %r" % loader)
            opts["loader"] = loader
        lang = None
        if language is not None:
            try:
                lang = DefaultLanguageService.getLanguageService().getLanguage(LanguageID(language))
            except Exception:
                raise RpcError(INVALID, "unknown language %r" % language)
            opts["language"] = language
        if compilerSpec is not None:
            if lang is not None:
                try:
                    lang.getCompilerSpecByID(CompilerSpecID(compilerSpec))
                except Exception:
                    raise RpcError(INVALID, "unknown compiler spec %r for %s" % (compilerSpec, language))
            opts["compilerSpec"] = compilerSpec
        if baseAddress is not None:
            if not re.fullmatch(r"0[xX][0-9a-fA-F]+", baseAddress):
                raise RpcError(INVALID, "bad baseAddress %r" % baseAddress)
            v = int(baseAddress, 16)
            # getOffset is a signed long: mask to unsigned
            limit = (lang.getAddressFactory().getDefaultAddressSpace().getMaxAddress().getOffset() & ((1 << 64) - 1)) if lang is not None else (1 << 64) - 1
            if v > limit:
                raise RpcError(INVALID, "baseAddress %s outside the address space" % baseAddress)
            if loader != RAW:
                raise RpcError(INVALID, "baseAddress needs loader %r" % RAW)
            opts["baseAddress"] = hx(v)
        return opts

    @staticmethod
    def _program_key(sha, opts, disabled=None):
        """protocol.md "Persistence key". disabled = analyzer names switched off (default: SIDECAR_ANALYSIS_DISABLE)."""
        disabled = analysis_disabled() if disabled is None else disabled
        if not any(k in opts for k in ("loader", "language", "compilerSpec", "baseAddress")) and not disabled:
            return sha
        c = {k: opts.get(k) for k in ("loader", "language", "compilerSpec", "baseAddress")}
        if disabled:  # a reduced analysis never shares a key with a full one
            c["analysisDisable"] = sorted(disabled)
        canon = json.dumps(c, separators=(",", ":"))
        return sha + "-" + hashlib.sha256(canon.encode()).hexdigest()[:12]

    async def open_binary(self, path, loader=None, language=None, compilerSpec=None, baseAddress=None, profile=None):
        text_arg(path, "path")
        if self.opening is not None:
            raise RpcError(BUSY, "open_binary already in progress")
        if not os.path.isfile(path):
            raise RpcError(NOT_FOUND, "no such file: %s" % path)
        opts = self._check_options(loader, language, compilerSpec, baseAddress)
        if profile not in (None, "full", "fast"):
            raise RpcError(INVALID, "bad profile %r" % (profile,))
        # no profile: SIDECAR_ANALYSIS_DISABLE if set (costs nothing), else full
        disabled = analysis_disabled() if profile is None else FAST_PROFILE if profile == "fast" else []
        if sorted(disabled) == FAST_PROFILE:
            opts["profile"] = "fast"  # shown in the program browser, replayed on reopen
        op = self.opening = Opening()
        fut = self.loop.create_future()

        def body():
            try:
                res, exc = self._do_open(path, op, opts, disabled), None
            except BaseException as e:  # noqa
                res, exc = None, e
            self.loop.call_soon_threadsafe(self.ctx.lanes.settle, fut, res, exc)
        threading.Thread(target=body, daemon=True, name="open").start()
        try:
            return await fut
        finally:
            self.opening = None

    def _do_open(self, path, op, opts, disabled):
        """Thread O. On cancel or any error: nothing is saved, the program is released, the project stays usable."""
        import pyghidra
        res = prog = None
        self.proj_lock.acquire()  # waits for an R-side list/delete that slipped in just before this open started
        try:
            self.on_r(lambda: self._close(strict=True))  # old program goes first (listener removed, cache cleared, interfaces disposed)
            op.check()
            h, done, size = hashlib.sha256(), 0, max(1, os.path.getsize(path))
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    op.check()
                    h.update(chunk)
                    done += len(chunk)
                    self.progress("import", min(10, done * 10 // size), "hashing")
            key = self._program_key(h.hexdigest(), opts, disabled)
            proj = self._project()
            t0 = time.monotonic()
            persisted = proj.getProjectData().getFile("/" + key) is not None
            if persisted:
                self.progress("import", 100, "loading persisted analysis")
                try:
                    prog, consumer = pyghidra.consume_program(proj, "/" + key)
                except Exception as e:  # noqa
                    # a SIGKILL during the first (non-atomic) save of an import leaves a registered but unreadable item
                    if op.cancelled or re.search(r"lock|in use|already open|upgrade", repr(e), re.I):
                        raise  # not corruption: never delete a program that may hold saved edits
                    log("persisted program unreadable (%r): deleting it and re-importing" % (e,))
                    proj.getProjectData().getFile("/" + key).delete()
                    persisted = False
                else:
                    op.check()
                    self._meta_touch(key)
                    log("reopened persisted program in %.2fs" % (time.monotonic() - t0))
            if not persisted:
                res, prog, consumer = self._import_and_analyze(path, key, proj, op, opts, disabled), None, None
                prog = res.getPrimaryDomainObject()
                self._save(res, op)
                self._meta_touch(key, name=os.path.basename(path), sourcePath=os.path.abspath(path), sizeBytes=os.path.getsize(path),
                                 analyzed=True, options=opts)
            try:
                self._publish(prog, res, consumer, op, key)
            except BaseException:
                self.ctx.events.detach(prog)
                self.results = self.consumer = None
                raise
            self.progress("ready", 100, "ready")
            self.open_secs = time.monotonic() - t0
            op.finished = True
            return {"programId": key, "name": os.path.basename(path), "persisted": persisted}
        except BaseException as e:  # noqa
            op.finished = True
            if res is not None:
                try:
                    res.close()
                except Exception:
                    pass
            elif prog is not None:
                try:
                    prog.release(consumer)
                except Exception:
                    pass
            if isinstance(e, RpcError):
                raise
            if op.cancelled:
                raise RpcError(CANCELLED, "open cancelled")
            import jpype
            if isinstance(e, jpype.JException) and str(e.getClass().getSimpleName()) in INVALID_JAVA:  # e.g. LoadException: options don't fit the file
                raise RpcError(INVALID, str(e.getMessage() or e.getClass().getSimpleName()))
            log("open failed", repr(e))
            raise RpcError(INTERNAL, "open failed: %s" % e)
        finally:
            self.proj_lock.release()

    def _import_and_analyze(self, path, key, proj, op, opts, disabled):
        from ghidra.app.util.importer import ProgramLoader
        self.progress("import", 10, "importing")
        last = [0.0]

        def imp_cb(msg, prog, mx):
            now = time.monotonic()
            if now - last[0] >= 0.2:
                last[0] = now
                self.progress("import", 10 + int(prog * 90 / mx) if mx and mx > 0 else -1, str(msg or "importing"))
        b = ProgramLoader.builder().source(path).project(proj).projectFolderPath("/").name(key).monitor(op.monitor(imp_cb))
        if "loader" in opts:
            b = b.loaders(lambda l: str(l.getName()) == opts["loader"])
        if "language" in opts:
            b = b.language(opts["language"])
        if "compilerSpec" in opts:
            b = b.compiler(opts["compilerSpec"])
        if "baseAddress" in opts:
            b = b.addLoaderArg("-loader-baseAddr", opts["baseAddress"])
        res = b.load()
        op.check()
        try:
            self._analyze(res.getPrimaryDomainObject(), op, disabled)
        except BaseException:
            res.close()
            raise
        return res

    def _analyze(self, prog, op, disabled):
        """Real signal available from Ghidra (AutoAnalysisManager): the monitor message is the analyzer name at each
        analyzer start (AnalysisScheduler.runAnalyzer: setMessage(name); setProgress(0)), analyzers then overwrite it
        and set their own max. The manager exposes no queue size or global total, so there is no honest overall pct:
        pct = the current analyzer's progress/max when it reports one (> 0), else -1. `done` counts analyzer runs finished.
        Analyzers re-run when new addresses show up, so `total` is unknowable and omitted."""
        from ghidra.app.plugin.core.analysis import AutoAnalysisManager
        from ghidra.app.script import GhidraScriptUtil
        from ghidra.app.services import Analyzer
        from ghidra.program.util import GhidraProgramUtilities
        from ghidra.util.classfinder import ClassSearcher
        names = {str(a.getName()) for a in ClassSearcher.getInstances(Analyzer)}
        st = {"cur": "", "runs": 0, "last": 0.0}

        def cb(msg, p, mx):
            try:
                msg = str(msg or "")
                if msg in names:
                    st["cur"], st["runs"] = msg, st["runs"] + 1
                now = time.monotonic()
                if now - st["last"] < 0.2:
                    return
                st["last"] = now
                pct = min(100, int(p * 100 / mx)) if (mx and mx > 0 and p > 0) else -1
                self.progress("analysis", pct, msg, analyzer=st["cur"], done=max(0, st["runs"] - 1))
            except Exception:
                pass
        mon = op.monitor(cb)
        self.progress("analysis", -1, "analyzing")
        GhidraScriptUtil.acquireBundleHostReference()
        tx = prog.startTransaction("Analysis")
        try:
            mgr = AutoAnalysisManager.getAnalysisManager(prog)
            self._disable_analyzers(prog, disabled)
            mgr.initializeOptions()
            mgr.reAnalyzeAll(None)
            mgr.startAnalysis(mon)  # blocks this thread; cancel_open cancels mon from the loop thread
            log("analysis task times (cancelled=%s):\n%s" % (op.cancelled, mgr.getTaskTimesString()))
            op.check()
            GhidraProgramUtilities.markProgramAnalyzed(prog)
        finally:
            prog.endTransaction(tx, True)
            GhidraScriptUtil.releaseBundleHostReference()

    @staticmethod
    def _disable_analyzers(prog, names):
        """Switches the named analyzers off for the first-open analysis (exact analyzer names, see bench/ for the
        measured trade-off). Unknown names are logged and ignored. The list is part of the programId (_program_key),
        so a reduced analysis is stored apart from a full one."""
        from ghidra.program.model.listing import Program
        if not names:
            return
        opts = prog.getOptions(Program.ANALYSIS_PROPERTIES)
        for n in names:
            if opts.contains(n):
                opts.setBoolean(n, False)
            else:
                log("unknown analyzer to disable: %r" % n)
        log("analyzers disabled: %s" % names)

    def _save(self, res, op):
        from ghidra.util.task import TaskMonitor
        with op.lock:
            if op.cancelled:
                raise RpcError(CANCELLED, "open cancelled")
            op.saving = True  # point of no return: cancel_open now answers cancelled=false
        self.progress("saving", -1, "saving to project")
        res.save(TaskMonitor.DUMMY)

    # ---- decompile cache (shared by the pool and by the event listener) ----
    def cache_clear(self):
        with self.cache_lock:
            self.cache.clear()
            self.cache_ver += 1

    def cache_invalidate(self, ranges):
        with self.cache_lock:
            for k in [k for k, (lo, hi, _) in self.cache.items() if any(s <= hi and e >= lo for s, e in ranges)]:
                del self.cache[k]
            self.cache_ver += 1  # also stops in-flight decompiles from storing a pre-edit result

    # ---- reads (thread R) ----
    def list_functions(self):
        out = []
        dspace = self.need().getAddressFactory().getDefaultAddressSpace()
        for f in self.program.getFunctionManager().getFunctions(True):
            if f.isExternal():
                continue
            ea = f.getEntryPoint()
            if ea.getAddressSpace() != dspace:  # shortcut: functions in other spaces are not listed (the listing shows them), upgrade with qualified entries
                continue
            out.append((ea.getOffset() & MASK64, str(f.getName()), f.getBody().getNumAddresses()))
        out.sort()
        return [{"name": n, "entry": hx(o), "size": int(s)} for o, n, s in out]

    def get_function_at(self, address):
        prog = self.need()
        f = prog.getFunctionManager().getFunctionContaining(self.addr(address))
        if f is None:
            return None
        return {"name": str(f.getName()), "entry": self.fmt(f.getEntryPoint()),
                "size": int(f.getBody().getNumAddresses()), "signature": str(f.getSignature().getPrototypeString())}

    def snap_clear(self):
        with self.snap_lock:
            self.snaps.clear()
            self.snap_ver += 1

    def snap(self, key, build):
        """Cached result of a slow read (LRU of 8). build() runs without locks, since it may take seconds; its result is stored only if
        the program did not change meanwhile. shortcut: two identical concurrent first requests both build; upgrade with a per-key future."""
        with self.snap_lock:
            hit = self.snaps.get(key)
            if hit is not None:
                self.snaps.move_to_end(key)
                return hit
            ver = self.snap_ver
        val = build()
        with self.snap_lock:
            if self.snap_ver == ver:
                self.snaps[key] = val
                while len(self.snaps) > 8:
                    self.snaps.popitem(last=False)
        return val

    @staticmethod
    def _sym_kind(prog, s):
        from ghidra.program.model.symbol import SymbolType
        t = s.getSymbolType()
        if t == SymbolType.FUNCTION:
            return "function"
        if t == SymbolType.LOCAL_VAR or t == SymbolType.PARAMETER:
            return "variable"
        if s.isExternal():
            return "external"
        if t == SymbolType.LABEL:
            d = prog.getListing().getDefinedDataAt(s.getAddress())
            return "data" if d is not None else "label"
        return "other"

    def search_symbols(self, query, limit=100, scan=None):
        """Name substring match (also a hex address: symbols there, else a bare hit if mapped). The match runs inside Ghidra
        (SymbolTable.getSymbolIterator with a glob, so `*`/`?` in the query are wildcards): only hits cross into Python.
        shortcut: Ghidra has no name index for substrings, so this is still a linear scan, in Java; upgrade with an in-sidecar index on > ~1M symbols."""
        with self.scanning(scan) as prog:
            text_arg(query, "query")
            limit = lim(limit, 100, 5000)
            st, out, seen, fa = prog.getSymbolTable(), [], set(), self.fmtr(prog)
            q = query.strip()
            if not q:
                return []
            try:
                a = self.addr(q if q.lower().startswith("0x") else "0x" + q, prog)
                if prog.getMemory().contains(a):
                    syms = list(st.getSymbols(a))
                    for s in syms:
                        out.append({"name": str(s.getName()), "address": fa(a), "kind": self._sym_kind(prog, s)})
                    if not syms:
                        out.append({"name": fa(a), "address": fa(a), "kind": "other"})
                    seen.update(o["name"] + o["address"] for o in out)
            except RpcError:
                pass
            n = 0
            for s in st.getSymbolIterator("*" + q + "*", False):
                if len(out) >= limit:
                    break
                n += 1
                if n & 255 == 0:
                    scan.check()
                a = s.getAddress()
                if not a.isMemoryAddress():
                    continue
                o = {"name": str(s.getName()), "address": fa(a), "kind": self._sym_kind(prog, s)}
                if o["name"] + o["address"] not in seen:
                    out.append(o)
            return out[:limit]

    SYM_SORTS = ("name", "address", "kind", "namespace", "source")
    SYM_KINDS = ("function", "label", "data", "external", "variable", "other")
    SOURCES = {"USER_DEFINED": "user", "ANALYSIS": "analysis", "IMPORTED": "imported", "DEFAULT": "default"}

    def _sym_item(self, prog, s):
        a, ns = s.getAddress(), s.getParentNamespace()
        return {"name": str(s.getName()), "address": self.fmt(a, prog) if a.isMemoryAddress() else None, "kind": self._sym_kind(prog, s),
                "namespace": "" if ns.isGlobal() else str(ns.getName(True)), "source": self.SOURCES.get(str(s.getSource()), "other")}

    def _sym_key(self, prog, s, sort):
        name = str(s.getName()).lower()
        if sort == "name":
            return name
        if sort == "address":
            a = s.getAddress()
            return (a.getOffset() & MASK64) if a.isMemoryAddress() else -1
        if sort == "kind":
            return (self._sym_kind(prog, s), name)
        if sort == "namespace":
            ns = s.getParentNamespace()
            return ("" if ns.isGlobal() else str(ns.getName(True)).lower(), name)
        return (self.SOURCES.get(str(s.getSource()), "other"), name)

    def list_symbols(self, offset=0, limit=100, query="", kinds=None, sort="address", desc=False, scan=None):
        """One page of the symbol table, in `sort` order. `total` counts all rows after the filters.
        Default view (address order, no filter): the Ghidra by-address iterator is advanced lazily and kept, so page 1 costs `limit` rows
        and total is counted once inside Java. Any filter or other order builds a snapshot of the Java Symbol objects once (cached until the program
        changes): the name filter runs inside Ghidra (glob iterator), kinds and sort keys cost a few calls per symbol.
        shortcut: a deep offset in the default view walks the iterator from where it stopped; upgrade with getSymbolIterator(address) from a sampled index."""
        with self.scanning(scan) as prog:
            offset, limit = lim(offset, 0), lim(limit, 100, 1000)
            text_arg(query, "query")
            if sort not in self.SYM_SORTS:
                raise RpcError(INVALID, "sort must be one of %s" % ", ".join(self.SYM_SORTS))
            if kinds is None:
                kinds = []
            if not isinstance(kinds, list) or any(k not in self.SYM_KINDS for k in kinds):
                raise RpcError(INVALID, "kinds must be a list of %s" % ", ".join(self.SYM_KINDS))
            q, desc, kinds = query.strip(), bool(desc), tuple(sorted(set(kinds)))
            st = prog.getSymbolTable()
            if sort == "address" and not desc and not q and not kinds:
                def lazy():  # getNumSymbols() also counts variable symbols the by-address iterator skips, so count inside Java (Guava)
                    from com.google.common.collect import Iterators
                    return _SymSnap(st.getSymbolIterator(True), int(Iterators.size(st.getSymbolIterator(True))))
                sn = self.snap(("sym-lazy",), lazy)
                with sn.lock:
                    n = 0
                    while len(sn.syms) < offset + limit and sn.it is not None:
                        if sn.it.hasNext():
                            sn.syms.append(sn.it.next())
                        else:
                            sn.it, sn.total = None, len(sn.syms)
                        n += 1
                        if n & 255 == 0:
                            scan.check()
                    syms, total = sn.syms[offset:offset + limit], sn.total
            else:
                def build():
                    it = st.getSymbolIterator("*" + q + "*", False) if q else st.getSymbolIterator(True)
                    out, n = [], 0
                    for s in it:
                        n += 1
                        if n & 255 == 0:
                            scan.check()
                        if kinds and self._sym_kind(prog, s) not in kinds:
                            continue
                        out.append(s)
                    if sort == "address" and not q:  # the iterator already is in address order
                        return out
                    keys = []
                    for i, s in enumerate(out):
                        if i & 255 == 0:
                            scan.check()
                        keys.append(self._sym_key(prog, s, sort))
                    return [out[i] for i in sorted(range(len(out)), key=keys.__getitem__)]
                full = self.snap(("sym", q.lower(), kinds, sort), build)
                total = len(full)
                syms = (full[::-1] if desc else full)[offset:offset + limit]
            try:
                items = [self._sym_item(prog, s) for s in syms]
            except Exception as e:  # noqa  a symbol of a stale snapshot was deleted by an edit meanwhile
                raise RpcError(CANCELLED, "program changed while reading symbols: %s" % e)
            return {"total": total, "items": items}

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
        o = {"from": self.fmt(fa), "type": str(rt.getName()), "kind": self._ref_kind(rt)}
        f = fm.getFunctionContaining(fa)
        if f is not None:
            o["function"] = str(f.getName())
        return o

    def xrefs_to(self, address, limit=500):
        """Memory references to `address` (calls, jumps, data reads/writes, pointers). Stack/register references target variables: see xrefs_to_variable."""
        prog = self.need()
        limit, a, out = lim(limit, 500, 10000), self.addr(address), []
        fm = prog.getFunctionManager()
        for r in prog.getReferenceManager().getReferencesTo(a):
            if len(out) >= limit:
                break
            out.append(self._xref_to_item(fm, r))
        out.sort(key=lambda o: _akey(o["from"]))
        return out

    def xrefs_to_variable(self, entry, name, limit=500):
        """References to a stack or register variable of the function at `entry` that the program has (a parameter or a stack local such as
        `param_1`, `local_10`, or one the user renamed), found by name. A variable the decompiler invents (`iVar1`, a register temporary)
        has no program variable: the result is empty."""
        prog = self.need()
        text_arg(name, "name")
        limit, out = lim(limit, 500, 10000), []
        fm = prog.getFunctionManager()
        f = fm.getFunctionAt(self.addr(entry))
        if f is None:
            raise RpcError(NOT_FOUND, "no function at %s" % entry)
        for v in f.getAllVariables():
            if str(v.getName()) == name:
                for r in prog.getReferenceManager().getReferencesTo(v):
                    if len(out) < limit:
                        out.append(self._xref_to_item(fm, r))
                break
        out.sort(key=lambda o: _akey(o["from"]))
        return out

    def xrefs_from(self, address):
        prog = self.need()
        a = self.addr(address)
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
                o.update(to=self.fmt(r.getToAddress()), target="memory")
            out.append(o)
        return out

    def _scan_strings(self, prog, minLength, scan):
        from ghidra.program.util import DefinedStringIterator
        from ghidra.program.model.data import StringDataInstance
        items, fa = [], self.fmtr(prog)
        for d in DefinedStringIterator.forProgram(prog):
            if len(items) & 255 == 0:
                scan.check()
            v = d.getValue()  # the String for string data types; the StringDataInstance is the fallback (e.g. a pointer-typed string)
            if not isinstance(v, str):
                v = StringDataInstance.getStringDataInstance(d).getStringValue()
            if v is not None:
                v = str(v)
                if len(v) >= minLength:
                    items.append({"address": fa(d.getMinAddress()), "value": v[:STRING_VALUE_CAP], "length": int(d.getLength())})
        return items

    def list_strings(self, offset=0, limit=500, minLength=4, query="", scan=None):
        """Defined strings in address order. The full scan is cached per `minLength` until the next program change (first call on a
        big binary takes seconds, on a scan worker); `query` is a case-insensitive substring filter over the cached values; `total` is the
        count after both filters. Values are cut at 1000 UTF-16 units, `length` stays the byte length of the defined string.
        shortcut: one full scan per minLength, upgrade to an index or lazy paging on huge binaries."""
        with self.scanning(scan) as prog:
            offset, limit, minLength = lim(offset, 0), lim(limit, 500, 5000), lim(minLength, 4)
            text_arg(query, "query")
            items = self.snap(("str", minLength), lambda: self._scan_strings(prog, minLength, scan))
            q = query.strip().lower()
            if q:
                items = self.snap(("str", minLength, q), lambda: [i for i in items if q in i["value"].lower()])
            return {"total": len(items), "items": items[offset:offset + limit]}

    MEM_ENCODINGS = {"ascii": "US_ASCII", "utf16le": "UTF_16LE", "utf16be": "UTF_16BE"}

    def search_memory(self, pattern, kind="bytes", encoding="ascii", caseSensitive=True, start=None, limit=1000, scan=None):
        """Ghidra's memory search (ghidra.features.base.memsearch: UserInputByteMatcher + MemorySearcher, what the GUI's Search Memory uses) over
        the loaded, initialized address set, ascending, from `start` (default: the first address). kind "bytes": hex with wildcards ("48 8b ?? 24",
        `?`/`.` = any nibble pair); kind "text": a string in `encoding`. One page = up to `limit` matches; `next` is where to continue
        (null = the whole set is done). Cancellable with cancel_search; a cancelled page fails with Cancelled and returns nothing."""
        with self.scanning(scan) as prog:
            from java.nio.charset import StandardCharsets
            from ghidra.features.base.memsearch.bytesource import ProgramByteSource
            from ghidra.features.base.memsearch.format import SearchFormat
            from ghidra.features.base.memsearch.gui import SearchSettings
            from ghidra.features.base.memsearch.searcher import MemorySearcher
            from ghidra.program.model.address import AddressSet
            from ghidra.pyghidra import PyGhidraTaskMonitor
            from ghidra.util.datastruct import ListAccumulator
            text_arg(pattern, "pattern")
            if kind not in ("bytes", "text"):
                raise RpcError(INVALID, "kind must be bytes or text")
            if encoding not in self.MEM_ENCODINGS:
                raise RpcError(INVALID, "encoding must be one of %s" % ", ".join(self.MEM_ENCODINGS))
            limit = lim(limit, 1000, 10000)
            if limit < 1 or not pattern.strip():
                raise RpcError(INVALID, "empty pattern or limit < 1")
            st = SearchSettings().withSearchFormat(SearchFormat.HEX if kind == "bytes" else SearchFormat.STRING)
            if kind == "text":
                st = st.withStringCharset(getattr(StandardCharsets, self.MEM_ENCODINGS[encoding])).withCaseSensitive(bool(caseSensitive))
            matcher = st.getSearchFormat().parse(pattern.strip(), st)
            if not matcher.isValidSearch():
                raise RpcError(INVALID, "invalid pattern: %s" % matcher.getDescription())
            mem = prog.getMemory()
            sset = AddressSet(mem.getLoadedAndInitializedAddressSet())
            if start is not None:
                a = self.addr(start, prog)
                sset = sset.intersect(AddressSet(a, a.getAddressSpace().getMaxAddress()))
            mon = PyGhidraTaskMonitor(None, None)
            scan.mon = mon
            if scan.cancelled:
                mon.cancel()
            acc = ListAccumulator()
            done = MemorySearcher(ProgramByteSource(prog), matcher, sset, limit).findAll(acc, mon)
            scan.check()
            fm, items, last, fa = prog.getFunctionManager(), [], None, self.fmtr(prog)
            for m in acc.get():
                ad, b = m.getAddress(), m.getBytes()
                o = {"address": fa(ad), "length": int(m.getLength()), "bytes": " ".join("%02x" % (x & 255) for x in b[:16])}
                f = fm.getFunctionContaining(ad)
                if f is not None:
                    o["function"] = str(f.getName())
                items.append(o)
                last = ad
            return {"items": items, "next": None if done or last is None else fa(last.next() or last)}

    def list_data_types(self, query, limit=100):
        from ghidra.program.model.data import BuiltInDataTypeManager
        prog = self.need()
        text_arg(query, "query")
        limit, q = lim(limit, 100, 1000), query.strip().lower()
        hits, seen = [], set()
        for src, dtm in (("program", prog.getDataTypeManager()), ("builtin", BuiltInDataTypeManager.getDataTypeManager())):  # program first: its types shadow built-ins of the same path
            for dt in dtm.getAllDataTypes():
                n = str(dt.getName())
                if q in n.lower() and str(dt.getPathName()) not in seen:
                    seen.add(str(dt.getPathName()))
                    hits.append((0 if n.lower().startswith(q) else 1, len(n), dict(self._dt_node(dt), source=src)))
        hits.sort(key=lambda h: h[:2])
        return [h[2] for h in hits[:limit]]

    # ---- data types: tree, detail, editors (reads on R; edits are one transaction each) ----
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
            return self.need().getDataTypeManager()
        if source == "builtin":
            self.need()
            return BuiltInDataTypeManager.getDataTypeManager()
        raise RpcError(INVALID, "unknown data type source %r" % (source,))

    def dt_sources(self):
        return [{"id": "program", "name": str(self.need().getName()), "writable": True},
                {"id": "builtin", "name": "BuiltInTypes", "writable": False}]

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
        dtm = self.need().getDataTypeManager()
        dt = self._get_dt(dtm, path)
        if self._dt_kind(dt) not in kinds:
            raise RpcError(INVALID, "%s is a %s, not a %s" % (path, self._dt_kind(dt), "/".join(kinds)))
        return dtm, dt

    def create_data_type(self, kind, name=None, category="/", size=None, base=None):
        from ghidra.program.model.data import (CategoryPath, DataTypeConflictHandler, EnumDataType, PointerDataType,
                                               StructureDataType, TypedefDataType, UnionDataType)
        prog = self.need()
        dtm = prog.getDataTypeManager()
        if kind not in ("struct", "union", "enum", "typedef", "pointer", "category"):
            raise RpcError(INVALID, "bad kind %r" % (kind,))
        cp = CategoryPath(text_arg(category, "category"))
        if kind != "pointer":
            self._name_arg(name)
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
        self.edit("Create %s %s" % (kind, name or "pointer"), go)
        return out

    def delete_data_type(self, path, category=False):
        from ghidra.program.model.data import CategoryPath
        from ghidra.util.task import TaskMonitor
        dtm = self.need().getDataTypeManager()

        def go(p):
            if category:
                cat = dtm.getCategory(CategoryPath(text_arg(path, "path")))
                if cat is None:
                    raise RpcError(NOT_FOUND, "no category %s" % path)
                if cat.getParent() is None or not cat.getParent().removeEmptyCategory(cat.getName(), TaskMonitor.DUMMY):
                    raise RpcError(INVALID, "category %s is the root or not empty" % path)
            elif not dtm.remove(self._get_dt(dtm, path)):
                raise RpcError(INVALID, "could not delete %s" % path)
        self.edit("Delete %s" % path, go)
        return {}

    def rename_data_type(self, path, newName):
        dtm = self.need().getDataTypeManager()
        dt = self._get_dt(dtm, path)
        self._name_arg(newName, "newName")
        self.edit("Rename data type %s to %s" % (dt.getName(), newName), lambda p: dt.setName(newName))
        return {"path": str(dt.getPathName())}

    @staticmethod
    def _comp_len(c):  # -1 = rely on the type's own size (fixed length); dynamic types need the explicit length
        return -1 if c.getDataType().getLength() > 0 else int(c.getLength())

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
        self.edit("Edit %s: %s" % (dt.getName(), o), go)
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

    def edit_enum(self, path, op):
        dtm, dt = self._writable_dt(path, ("enum",))
        if not isinstance(op, dict):
            raise RpcError(INVALID, "op must be an object")
        o = op.get("op")

        def go(p):
            if o == "set":
                name, old = self._name_arg(op.get("name")), op.get("oldName", op.get("name"))
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
        self.edit("Edit %s: %s" % (dt.getName(), o), go)
        return {}

    def create_struct_from_data(self, address, length, name, category="/", apply=True):
        from ghidra.app.cmd.data import CreateDataCmd
        from ghidra.program.model.data import CategoryPath, DataTypeConflictHandler, StructureDataType
        from ghidra.program.model.listing import Instruction
        prog = self.need()
        dtm, a, cp = prog.getDataTypeManager(), self.addr(address), CategoryPath(text_arg(category, "category"))
        self._name_arg(name)
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
                self._cmd(CreateDataCmd(a, True, False, dt))(p)
        self.edit("Create structure %s" % name, go)
        if apply:
            self.ctx.events.record({"data"}, [(a.getOffset(), a.getOffset() + length - 1)])
        return {"path": str(dtm.getDataType(cp, name).getPathName())}

    def undo_state(self, prog=None):
        return undo_state(prog or self.need())

    def listing_info(self):
        prog = self.need()
        f = self.fmtr(prog)
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

    def listing_rows(self, address, count, direction="forward"):
        """Walk code units from an anchor address; no index. See protocol.md."""
        from ghidra.program.model.listing import CommentType, Instruction
        from jpype import JArray, JByte
        prog = self.need()
        fwd = direction != "backward"
        count = max(0, min(int(count), 1000))
        listing, st, mem, fa = prog.getListing(), prog.getSymbolTable(), prog.getMemory(), self.fmtr(prog)
        loaded = mem.getLoadedAndInitializedAddressSet()
        a = self.addr(address)
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
                    refs.append({"from": fa(r.getFromAddress()), "kind": self._ref_kind(r.getReferenceType())})
                    if len(refs) >= self.ROW_XREFS_SHOWN:
                        break
                refs.sort(key=lambda o: _akey(o["from"]))  # shortcut: the first 5 Ghidra returns, not the 5 lowest; the full list is xrefs_to
                row["xrefs"] = {"count": int(rm.getReferenceCountTo(ca)), "items": refs}
            if not is_ins and cu.isDefined() and cu.getNumComponents() > 0:
                parts, total = self._row_parts(cu)
                row["parts"] = parts
                if total > len(parts):
                    row["partsTotal"] = total
            rows.append(row)
        return rows

    _name_arg = staticmethod(name_arg)

    def rename_symbol(self, address, newName):
        from ghidra.app.cmd.label import RenameLabelCmd
        from ghidra.program.model.symbol import SourceType
        prog = self.need()
        self._name_arg(newName, "newName")
        sym = prog.getSymbolTable().getPrimarySymbol(self.addr(address))
        if sym is None:
            raise RpcError(NOT_FOUND, "no symbol at %s" % address)
        old = str(sym.getName())
        self.edit("Rename %s to %s" % (old, newName), self._cmd(RenameLabelCmd(sym, newName, SourceType.USER_DEFINED)))
        return {}

    def set_comment(self, address, kind, text):
        from ghidra.app.cmd.comments import SetCommentCmd
        from ghidra.program.model.listing import CommentType
        prog = self.need()
        kinds = {"eol": CommentType.EOL, "pre": CommentType.PRE, "post": CommentType.POST,
                 "plate": CommentType.PLATE, "repeatable": CommentType.REPEATABLE}
        if kind not in kinds:
            raise RpcError(INVALID, "bad comment kind %r" % (kind,))
        text_arg(text, "text")
        cu = prog.getListing().getCodeUnitContaining(self.addr(address))
        if cu is None:
            raise RpcError(NOT_FOUND, "no code unit at %s" % address)
        cmd = SetCommentCmd(cu.getMinAddress(), kinds[kind], text or None)
        self.edit(("Clear %s comment" if not text else "Set %s comment") % kind, self._cmd(cmd))
        return {}

    def get_comments(self, address):
        from ghidra.program.model.listing import CommentType
        cu = self.need().getListing().getCodeUnitContaining(self.addr(address))
        if cu is None:
            raise RpcError(NOT_FOUND, "no code unit at %s" % address)
        out = {}
        for k, t in (("eol", CommentType.EOL), ("pre", CommentType.PRE), ("post", CommentType.POST),
                     ("plate", CommentType.PLATE), ("repeatable", CommentType.REPEATABLE)):
            c = cu.getComment(t)
            if c:
                out[k] = str(c)
        return out

    def create_label(self, address, name):
        from ghidra.app.cmd.label import AddLabelCmd
        from ghidra.program.model.symbol import SourceType
        prog = self.need()
        self._name_arg(name)
        a = self.addr(address)
        if not prog.getMemory().contains(a):
            raise RpcError(INVALID, "address %s is not in memory" % address)
        if prog.getSymbolTable().getPrimarySymbol(a) is not None:
            raise RpcError(INVALID, "a label already exists at %s (use rename_symbol)" % address)
        self.edit("Create label %s" % name, self._cmd(AddLabelCmd(a, name, SourceType.USER_DEFINED)))
        return {}

    def create_function(self, address, name=None):
        from ghidra.app.cmd.function import CreateFunctionCmd
        from ghidra.program.model.symbol import SourceType
        prog = self.need()
        a, fm = self.addr(address), prog.getFunctionManager()
        if name is not None:
            self._name_arg(name)
        if fm.getFunctionContaining(a) is not None:
            raise RpcError(INVALID, "address is already inside a function")
        cmd = (CreateFunctionCmd(name, a, None, SourceType.USER_DEFINED) if name else CreateFunctionCmd(a))
        self.edit("Create function at %s" % address, self._cmd(cmd))
        f = fm.getFunctionAt(a)
        if f is None:
            raise RpcError(INTERNAL, "function was not created")
        return {"entry": self.fmt(a), "name": str(f.getName())}

    def define_data(self, address, dataType):
        from ghidra.app.cmd.data import CreateDataCmd
        from ghidra.program.model.data import DataTypeConflictHandler
        from ghidra.util.data import DataTypeParser
        from ghidra.util.data.DataTypeParser import AllowedDataTypes
        prog = self.need()
        text_arg(dataType, "dataType")
        a = self.addr(address)
        if not prog.getMemory().contains(a):
            raise RpcError(INVALID, "address %s is not in memory" % address)

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
            self._cmd(CreateDataCmd(a, True, False, dt))(p)
            self._data_ranges = (a.getOffset(), a.getOffset() + dt.getLength() - 1)
        self.edit("Define data", go)
        self.ctx.events.record({"data"}, [self._data_ranges])
        return {}

    def clear_code(self, address, length=None):
        from ghidra.app.plugin.core.clear import ClearCmd
        from ghidra.program.model.address import AddressSet
        prog = self.need()
        a, mem, listing = self.addr(address), prog.getMemory(), prog.getListing()
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
        self.edit("Clear code", lambda p: self._cmd(ClearCmd(view))(p))
        self.ctx.events.record({"code", "data"}, [(lo.getOffset(), hi.getOffset())])
        return {}

    def set_function_signature(self, entry, signature):
        from ghidra.app.cmd.function import ApplyFunctionSignatureCmd
        from ghidra.app.util.parser import FunctionSignatureParser
        from ghidra.program.model.data import DataTypeConflictHandler
        from ghidra.program.model.symbol import SourceType
        from ghidra.app.cmd.function import FunctionRenameOption
        text_arg(signature, "signature")
        prog, f = self._function(entry)

        def go(p):
            fdef = FunctionSignatureParser(p.getDataTypeManager(), None).parse(f.getSignature(), signature)
            cmd = ApplyFunctionSignatureCmd(f.getEntryPoint(), fdef, SourceType.USER_DEFINED, True, False,
                                            DataTypeConflictHandler.DEFAULT_HANDLER, FunctionRenameOption.RENAME)
            self._cmd(cmd)(p)
        self.edit("Edit signature of %s" % f.getName(), go)
        return {}

    def _high_edit(self, tx_name, entry, name, fn, timeoutSecs, job):
        """rename_variable / retype_variable. Decided: the whole thing runs on thread R with a short-lived DecompInterface
        (not a pool worker). The HighFunction is only valid for the program state it was decompiled from; every write
        also runs on R, so no edit can slip between the decompile and the commit. Cost: R is blocked for one decompile.
        The timeout is the request's `timeoutSecs` (default 30); `cancel_decompile` with the request id cancels it (job)."""
        from ghidra.app.decompiler import DecompInterface
        from ghidra.pyghidra import PyGhidraTaskMonitor
        text_arg(name, "name")
        timeoutSecs = lim(timeoutSecs, 30)
        prog, func = self._function(entry)
        mon = PyGhidraTaskMonitor(None, None)
        with self.mon_lock:
            job.mon = mon
            if job.cancelled:
                mon.cancel()
        d = DecompInterface()
        try:
            if not d.openProgram(prog):
                raise RpcError(INTERNAL, "decompiler failed to open program: %s" % d.getLastMessage())
            res = d.decompileFunction(func, timeoutSecs, mon)
            if res.isCancelled() or mon.isCancelled():
                raise RpcError(CANCELLED, "decompile cancelled")
            if res.isTimedOut():
                raise RpcError(TIMEOUT, "decompile timed out after %ss" % timeoutSecs)
            if not res.decompileCompleted():
                raise RpcError(INTERNAL, "decompile failed: %s" % res.getErrorMessage())
            hf = res.getHighFunction()
            sym = next((s for s in hf.getLocalSymbolMap().getSymbols() if str(s.getName()) == name), None)
            if sym is None:
                raise RpcError(NOT_FOUND, "no variable %r in function at %s" % (name, entry))
            self.edit(tx_name % func.getName(), lambda p: fn(p, func, hf, sym))
        finally:
            d.dispose()
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

    def rename_variable(self, entry, name, newName, timeoutSecs=30, job=None):
        from ghidra.program.model.pcode import HighFunctionDBUtil
        from ghidra.program.model.symbol import SourceType
        self._name_arg(newName, "newName")

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

    def auto_create_structure(self, entry, name, structName=None, timeoutSecs=30, job=None):
        """Ghidra's "Auto Create Structure" (FillOutStructureHelper, as FillOutStructureCmd uses it) on a decompiler variable:
        infers fields from the load/store offsets through the variable (following it into callees), adds the struct, and
        retypes the variable to a pointer to it, all in one transaction."""
        from ghidra.app.decompiler import DecompileOptions
        from ghidra.app.decompiler.util import FillOutStructureHelper
        from ghidra.pyghidra import PyGhidraTaskMonitor
        from ghidra.program.model.data import CategoryPath, DataTypeConflictHandler, PointerDataType
        if structName is not None:
            self._name_arg(structName, "structName")
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

    def _undo_redo(self, undo):
        prog = self.need()
        if not (prog.canUndo() if undo else prog.canRedo()):
            raise RpcError(INVALID, "nothing to %s" % ("undo" if undo else "redo"))
        try:
            prog.undo() if undo else prog.redo()
        except Exception as e:  # noqa
            raise RpcError(INTERNAL, "%s failed: %s" % ("undo" if undo else "redo", e))
        prog.flushEvents()  # RESTORED -> program_changed (ranges null) and cache clear
        return self.ctx.session.refresh_undo(prog)

    def undo(self):
        return self._undo_redo(True)

    def redo(self):
        return self._undo_redo(False)

    # ---- decompile (pool worker) ----
    def decompile(self, entry, timeoutSecs=30, job=None):
        from ghidra.app.decompiler import DecompInterface
        from ghidra.pyghidra import PyGhidraTaskMonitor
        w = self.tl.w
        timeoutSecs = lim(timeoutSecs, 30)
        with self.pool_lock:
            prog, epoch = self.program, self.epoch
            if job.cancelled or job.epoch != epoch:  # cancelled while queued, or the program was closed/swapped meanwhile
                raise RpcError(CANCELLED, "decompile cancelled")
            if prog is None:
                raise RpcError(NO_PROGRAM, "no program open")
            w.busy = True
            self.running.add(job)
        try:
            a = self.addr(entry, prog)
            func = prog.getFunctionManager().getFunctionAt(a)
            if func is None:
                raise RpcError(NOT_FOUND, "no function at %s" % entry)
            key = a.getOffset()
            with self.cache_lock:
                ver = self.cache_ver
                hit = self.cache.get(key)
                if hit is not None:
                    self.cache.move_to_end(key)
                    return {**hit[2], "cached": True}
            if w.decomp is None or w.epoch != epoch:
                self.ctx.lanes.dispose(w)
                d = DecompInterface()
                if not d.openProgram(prog):
                    raise RpcError(INTERNAL, "decompiler failed to open program: %s" % d.getLastMessage())
                w.decomp, w.epoch = d, epoch
            mon = PyGhidraTaskMonitor(None, None)
            with self.mon_lock:
                job.mon = mon
                if job.cancelled:
                    mon.cancel()
            res = w.decomp.decompileFunction(func, timeoutSecs, mon)
            if res.isCancelled() or mon.isCancelled():
                raise RpcError(CANCELLED, "decompile cancelled")
            if res.isTimedOut():
                raise RpcError(TIMEOUT, "decompile timed out after %ss" % timeoutSecs)
            if not res.decompileCompleted():
                raise RpcError(INTERNAL, "decompile failed: %s" % res.getErrorMessage())
            out = self._tokens(prog, res)
            body = func.getBody()
            with self.cache_lock:
                if self.cache_ver == ver:  # an edit/invalidation during the decompile means this result may be stale: don't store
                    self.cache[key] = (body.getMinAddress().getOffset() & MASK64, body.getMaxAddress().getOffset() & MASK64, out)
                    if len(self.cache) > 256:
                        self.cache.popitem(last=False)
            return {**out, "cached": False}
        finally:
            with self.pool_lock:
                w.busy = False
                self.running.discard(job)

    def _tokens(self, prog, res):
        from ghidra.app.decompiler import ClangFuncNameToken, ClangFieldToken, ClangLabelToken
        from ghidra.app.decompiler.component import DecompilerUtils
        from ghidra.program.model.pcode import PcodeOp
        fm, fa = prog.getFunctionManager(), self.fmtr(prog)
        lines_out, tokens = [], []
        for ln, line in enumerate(DecompilerUtils.toLines(res.getCCodeMarkup())):
            indent = str(line.getIndentString())
            col = len(indent)
            text = indent
            for t in line.getAllTokens():
                s = str(t.getText())
                start, col = col, col + len(s)  # Java String length == UTF-16 units, as protocol wants
                text += s
                if not s.strip():
                    continue
                kind = KINDS.get(int(t.getSyntaxType()), "default")
                if isinstance(t, ClangFieldToken):
                    kind = "field"
                elif isinstance(t, ClangLabelToken):
                    kind = "label"
                tok = {"line": ln, "colStart": start, "colEnd": col, "kind": kind}
                ma = t.getMinAddress()
                if ma is not None:
                    tok["address"] = fa(ma)
                if kind in ("variable", "param"):
                    tok["varName"] = s
                if isinstance(t, ClangFuncNameToken):
                    # only tokens that belong to a call op; the function's own name in its signature has no op
                    op = t.getPcodeOp()
                    if op is not None and op.getOpcode() == PcodeOp.CALL:
                        f = fm.getFunctionAt(op.getInput(0).getAddress())
                        if f is not None:
                            tok["targetFunction"] = fa(f.getEntryPoint())
                tokens.append(tok)
            lines_out.append(text)
        return {"text": "\n".join(lines_out), "tokens": tokens}

    # ---- loop-thread side ----
    def cancel_decompile(self, id):
        """Cancel the decompile request with this JSON-RPC id, queued or running. False if unknown/finished."""
        job = self.dj.get(id)
        if job is None:
            return {"cancelled": False}
        with self.mon_lock:
            job.cancelled = True
            if job.mon is not None:
                job.mon.cancel()
        return {"cancelled": True}

    def cancel_search(self, id):
        """Cancel the scan request (list_symbols, list_strings, search_symbols, search_memory) with this JSON-RPC id, queued or running. False if unknown/finished."""
        sc = self.sj.get(id)
        if sc is None:
            return {"cancelled": False}
        with self.mon_lock:
            sc.cancel()
        return {"cancelled": True}

    def cancel_open(self):
        return {"cancelled": bool(self.opening is not None and self.opening.cancel())}

    S_METHODS = ("search_symbols", "list_symbols", "list_strings", "search_memory")  # scan workers, see the module docstring
    R_METHODS = ("list_functions", "listing_info", "listing_rows", "get_function_at", "xrefs_to", "xrefs_to_variable",
                 "xrefs_from", "list_data_types", "undo_state", "get_comments", "rename_symbol", "create_label", "set_comment",
                 "create_function", "set_function_signature", "rename_variable", "retype_variable", "undo", "redo",
                 "define_data", "clear_code", "save", "dt_sources", "dt_children", "get_data_type", "create_data_type",
                 "delete_data_type", "rename_data_type", "edit_struct", "edit_enum", "create_struct_from_data", "auto_create_structure")
    # on R, with a Job registered under the request id so cancel_decompile can reach the decompile inside (see _high_edit)
    CANCELLABLE = ("rename_variable", "retype_variable", "auto_create_structure")
    # run on R, but never behind/alongside an open: Busy instead of NoProgram
    P_METHODS = ("close_program", "import_candidates", "list_languages", "list_programs", "delete_program")

    async def handle(self, ws, raw):
        try:
            msg = json.loads(raw)
            rid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
            if not isinstance(params, dict):
                raise TypeError("params must be an object")
        except Exception:
            return
        try:
            if method == "cancel_decompile":
                result = self.cancel_decompile(**params)
            elif method == "cancel_search":
                result = self.cancel_search(**params)
            elif method == "cancel_open":
                result = self.cancel_open(**params)
            elif method == "open_binary":
                result = await self.open_binary(**params)
            elif method in self.P_METHODS:
                if self.opening is not None and method != "list_languages":
                    raise RpcError(BUSY, "open_binary in progress")
                fn = getattr(self, method)
                result = await self.run(lambda: fn(**params))
            elif method == "decompile" or method in self.R_METHODS or method in self.S_METHODS:
                if self.opening is not None:  # fail fast: never queue behind an open
                    raise RpcError(NO_PROGRAM, "open_binary in progress")
                if method in self.S_METHODS:
                    if rid is None or rid in self.sj:
                        raise RpcError(INVALID, "%s needs a unique request id" % method)
                    scan = self.sj[rid] = Scan(self.epoch)
                    fn = getattr(self, method)
                    try:
                        result = await self.run(lambda: fn(scan=scan, **params), self.sjobs)
                    finally:
                        self.sj.pop(rid, None)
                elif method == "decompile":
                    if rid is None or rid in self.dj:
                        raise RpcError(INVALID, "decompile needs a unique request id")
                    job = self.dj[rid] = Job(self.epoch)
                    try:
                        result = await self.run(lambda: self.decompile(job=job, **params), self.djobs)
                    finally:
                        self.dj.pop(rid, None)
                elif method in self.CANCELLABLE:
                    if rid is None or rid in self.dj:
                        raise RpcError(INVALID, "%s needs a unique request id" % method)
                    job = self.dj[rid] = Job(self.epoch)
                    try:
                        result = await self.run(lambda: getattr(self, method)(job=job, **params))
                    finally:
                        self.dj.pop(rid, None)
                else:
                    fn = getattr(self, method)
                    result = await self.run(lambda: fn(**params))
            else:
                raise RpcError(NO_METHOD, "method not found: %s" % method)
            reply = {"jsonrpc": "2.0", "id": rid, "result": result}
        except RpcError as e:
            reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": e.code, "message": str(e)}}
        except (TypeError, ValueError) as e:
            reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": INVALID, "message": "invalid params: %s" % e}}
        except Exception as e:  # noqa
            log("internal error", repr(e))
            reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": INTERNAL, "message": str(e)}}
        if rid is not None:
            await self._send_to(ws, json.dumps(reply))

    @staticmethod
    async def _send_to(ws, s):
        try:
            await ws.send(s)
        except Exception:
            pass


# Temporary forwarding to the runtime objects until the domains move out (step 5): attributes and the helpers the methods call on self.
def _fwd(target, names, rename=None):
    for n in names:
        a = (rename or {}).get(n, n)
        setattr(Sidecar, n, property(lambda s, a=a: getattr(getattr(s.ctx, target) if target else s.ctx, a),
                                     lambda s, v, a=a: setattr(getattr(s.ctx, target) if target else s.ctx, a, v)))


_fwd("session", ["program", "results", "consumer", "epoch", "program_id", "undo_snap", "save_lock"], {})
_fwd("session", ["pool_lock"], {"pool_lock": "lock"})
_fwd("lanes", ["jobs", "djobs", "sjobs", "workers", "running", "active", "tl", "dj", "sj", "opening", "mon_lock"])
_fwd(None, ["loop"])
for _n, _t in (("need", "session"), ("addr", "session"), ("edit", "session"), ("_cmd", "session"), ("_function", "session"),
               ("refresh_undo", "session"), ("run", "lanes"), ("on_r", "lanes"), ("scanning", "lanes"), ("notify", None), ("progress", None)):
    _a = {"_cmd": "cmd", "_function": "function"}.get(_n, _n)
    setattr(Sidecar, _n, property(lambda s, _t=_t, _a=_a: getattr(getattr(s.ctx, _t) if _t else s.ctx, _a)))


def analysis_disabled():
    """Analyzer names from SIDECAR_ANALYSIS_DISABLE ("Name 1;Name 2"), empty if unset."""
    return [n for n in os.environ.get("SIDECAR_ANALYSIS_DISABLE", "").split(";") if n]


def max_heap():
    """JVM -Xmx. Without it the JVM takes 1/4 of RAM (8 GB on a 32 GB Mac), which is neither tuned nor predictable.
    SIDECAR_MAXMEM (e.g. "6g") overrides; default is half of physical RAM, capped at 24 GB (leaves room for the
    native decompiler processes, the renderer and the OS)."""
    v = os.environ.get("SIDECAR_MAXMEM")
    if v:
        return v
    ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    return "%dm" % (min(ram // 2, 24 << 30) >> 20)


def main():
    if not os.environ.get("SIDECAR_TOKEN") and os.environ.get("SIDECAR_ALLOW_NO_AUTH") != "1":
        print("SIDECAR_TOKEN is not set: refusing to start without auth (SIDECAR_ALLOW_NO_AUTH=1 is the test-only escape)", file=sys.stderr)
        sys.exit(2)
    # keep real stdout for the port line only; JVM/Ghidra chatter goes to stderr
    out = os.fdopen(os.dup(1), "w")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    t0 = time.monotonic()
    if "GHIDRA_INSTALL_DIR" not in os.environ:
        sys.exit("GHIDRA_INSTALL_DIR not set")
    import pathlib
    import pyghidra
    from pyghidra.launcher import HeadlessPyGhidraLauncher
    launcher = HeadlessPyGhidraLauncher(install_dir=pathlib.Path(os.environ["GHIDRA_INSTALL_DIR"]))
    if os.environ.get("JAVA_HOME"):  # skip LaunchSupport JDK probing (it shells out to `java` on PATH)
        launcher.java_home = pathlib.Path(os.environ["JAVA_HOME"])
    launcher.add_vmargs("-Xmx%s" % max_heap())
    launcher.add_vmargs("-Djava.awt.headless=true")  # else project code initialises AppKit from a non-main thread and hangs
    launcher.start()
    from java.lang import Runtime
    log("jvm start: %.2fs, max heap %d MB" % (time.monotonic() - t0, Runtime.getRuntime().maxMemory() // (1 << 20)))

    sc = Sidecar()

    def watch_stdin():
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except Exception:
            pass
        sc.server.shutdown()

    threading.Thread(target=watch_stdin, daemon=True).start()
    for _sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(_sig, lambda *_: threading.Thread(target=sc.server.shutdown, daemon=True).start())
    asyncio.run(sc.server.serve(out))


if __name__ == "__main__":
    main()

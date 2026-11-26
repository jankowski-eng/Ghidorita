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
from ghidrette.core.lanes import Opening
from ghidrette.core.rpc import Dispatcher, Registry, rpc
from ghidrette.core.server import Server
from ghidrette.core.session import undo_state
from ghidrette.domains.search import Search
from ghidrette.domains.listing import Listing
from ghidrette.domains.xrefs import Xrefs
from ghidrette.core.errors import (BUSY, CANCELLED, INTERNAL, INVALID, INVALID_JAVA, NO_PROGRAM, NOT_FOUND,
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


class Sidecar:
    def __init__(self):
        self.ctx = ctx = Ctx()
        self.cache = OrderedDict()   # entry offset -> (lo, hi, result); cache_lock
        self.cache_ver = 0
        self.cache_lock = threading.Lock()
        self.proj = self.gp = None
        self.proj_lock = threading.Lock()  # held by thread O for a whole open, briefly by R for list/delete/candidates: never concurrent
        ctx.events.subscribe(self._invalidate)
        ctx.shutdown_hooks += [lambda: self._close(), self._close_project]
        self.registry = Registry()
        self.registry.register(self)
        for dom in (Listing, Search, Xrefs):
            self.registry.register(dom(ctx))
        self.server = Server(ctx, Dispatcher(ctx, self.registry).handle)
        ctx.lanes.start()

    def _invalidate(self, kinds, ranges, broad):
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
    @rpc(lane="project", busy_ok=True)
    def list_languages(self):
        from ghidra.program.util import DefaultLanguageService
        out = []
        for d in DefaultLanguageService.getLanguageService().getLanguageDescriptions(False):
            out.append({"id": str(d.getLanguageID()), "description": str(d.getDescription()),
                        "compilerSpecs": [{"id": str(c.getCompilerSpecID()), "name": str(c.getCompilerSpecName())}
                                          for c in d.getCompatibleCompilerSpecDescriptions()]})
        out.sort(key=lambda o: o["id"])
        return out

    @rpc(lane="project")
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

    @rpc(lane="project")
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

    @rpc(lane="project")
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

    @rpc(lane="project")
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

    @rpc(lane="R")
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

    @rpc(lane="open")
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

    @rpc(lane="R")
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

    @rpc(lane="R")
    def dt_sources(self):
        return [{"id": "program", "name": str(self.need().getName()), "writable": True},
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
        dtm = self.need().getDataTypeManager()
        dt = self._get_dt(dtm, path)
        if self._dt_kind(dt) not in kinds:
            raise RpcError(INVALID, "%s is a %s, not a %s" % (path, self._dt_kind(dt), "/".join(kinds)))
        return dtm, dt

    @rpc(lane="R")
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

    @rpc(lane="R")
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

    @rpc(lane="R")
    def rename_data_type(self, path, newName):
        dtm = self.need().getDataTypeManager()
        dt = self._get_dt(dtm, path)
        self._name_arg(newName, "newName")
        self.edit("Rename data type %s to %s" % (dt.getName(), newName), lambda p: dt.setName(newName))
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

    @rpc(lane="R")
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

    @rpc(lane="R")
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

    @rpc(lane="R")
    def undo_state(self, prog=None):
        return undo_state(prog or self.need())

    _name_arg = staticmethod(name_arg)

    @rpc(lane="R")
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

    @rpc(lane="R")
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

    @rpc(lane="R")
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

    @rpc(lane="R")
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

    @rpc(lane="R")
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

    @rpc(lane="R")
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

    @rpc(lane="R")
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

    @rpc(lane="R", job=True)
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

    @rpc(lane="R", job=True)
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

    @rpc(lane="R", job=True)
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

    @rpc(lane="R")
    def undo(self):
        return self._undo_redo(True)

    @rpc(lane="R")
    def redo(self):
        return self._undo_redo(False)

    # ---- decompile (pool worker) ----
    @rpc(lane="decomp")
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
    @rpc(lane="loop")
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

    @rpc(lane="loop")
    def cancel_open(self):
        return {"cancelled": bool(self.opening is not None and self.opening.cancel())}



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

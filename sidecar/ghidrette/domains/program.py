"""The open program's lifecycle: open_binary (hash, import, analyze, save, publish; thread O), cancel_open, close, save, undo/redo.
Closing order matters, see close(). Opens go through ctx.project (thread O holds project.lock for a whole open)."""
import asyncio, hashlib, re, threading, time, os

from ..core.args import hx, text_arg
from ..core.errors import BUSY, CANCELLED, INTERNAL, INVALID, INVALID_JAVA, NOT_FOUND, RpcError, log
from ..core.lanes import Opening
from ..core.recovery import take_recovery_snapshot
from ..core.rpc import rpc
from ..core.session import undo_state
from .project import FAST_PROFILE, RAW, analysis_disabled, program_key


CAPABILITIES = [
    "importOptions", "decompile", "editing", "variableEditing", "undo", "save", "symbolSearch",
    "symbolTable", "strings", "memorySearch", "references", "variableReferences", "dataTypes",
    "typeEditing", "projects", "coverage", "controlFlowGraph", "suggestions", "export",
]


class Program:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session
        self.snapshot_revision = None

    def start(self):
        if float(os.environ.get("SIDECAR_SNAPSHOT_SECS", "120")) > 0:
            threading.Thread(target=self._snapshot_loop, daemon=True).start()

    def _snapshot_loop(self):
        """Crash safety: periodically snapshot dirty programs on R; reopening can recover without clearing undo history."""
        secs = float(os.environ.get("SIDECAR_SNAPSHOT_SECS", "120"))
        while True:
            time.sleep(secs)
            try:
                self.ctx.lanes.on_r(self._snapshot)
            except Exception as e:  # noqa
                log("recovery snapshot failed:", repr(e))

    def _snapshot(self):
        prog = self.ses.program
        revision = (self.ses.epoch, self.ses.revision)
        if prog is None or not prog.isChanged() or self.snapshot_revision == revision:
            return
        with self.ses.save_lock:
            completed = take_recovery_snapshot(prog)
        if completed:
            self.snapshot_revision = revision
            log("recovery snapshot current for", self.ses.program_id)
        else:
            log("recovery snapshot deferred for", self.ses.program_id)
        return completed

    @rpc(lane="loop")
    def provider_info(self):
        interval = float(os.environ.get("SIDECAR_SNAPSHOT_SECS", "120"))
        info = {"provider": "pyghidra", "version": 1, "capabilities": CAPABILITIES[:]}
        if interval > 0:
            info["capabilities"].append("recovery")
            info["recovery"] = {"snapshotIntervalSeconds": interval}
        return info

    @rpc(lane="loop")
    def active_session(self):
        return self.ses.active()

    @rpc(lane="project")
    def close_program(self):
        if self.ctx.lanes.opening is not None:
            raise RpcError(BUSY, "open_binary in progress")
        try:
            self.close()  # a failed save keeps the program (and its edits) open instead of reporting success
        except RuntimeError as e:
            raise RpcError(INTERNAL, str(e))
        return {}

    # ---- program lifecycle ----
    def close(self):
        """Run on thread R. Order matters: stop new decompiles, cancel running ones, wait until every worker
        disposed its DecompInterface (on its own thread), only then release the program."""
        prog, res, consumer = self.ses.program, self.ses.results, self.ses.consumer
        if prog is not None:  # autosave: closing must never lose edits (see protocol.md, Persistence and crash safety)
            try:
                self._save_program(prog, "close")
            except Exception as e:  # noqa
                log("close save FAILED, keeping the program open:", repr(e))
                raise RuntimeError("save failed before closing the current program: %s" % e) from e
        with self.ses.lock:
            self.ses.program = None
            self.ses.session_id = self.ses.name = None
            self.ses.epoch += 1
            for j in list(self.ctx.lanes.running):
                with self.ctx.lanes.mon_lock:
                    j.cancelled = True
                    if j.mon is not None:
                        j.mon.cancel()
            for sc in list(self.ctx.lanes.active):
                sc.cancel()
        self.ctx.events.detach(prog)
        self.ctx.events.reset()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and (self.ctx.lanes.active or any(w.busy or w.decomp is not None for w in self.ctx.lanes.workers)):
            time.sleep(0.02)
        stuck = bool(self.ctx.lanes.active) or any(w.busy or w.decomp is not None for w in self.ctx.lanes.workers)
        if stuck:
            log("decompiler or scan worker still busy after 10 s: leaking the old program instead of releasing it under a live reader")
        self.ses.results = self.ses.consumer = None
        if not stuck:
            if res is not None:
                res.close()
            elif prog is not None:
                prog.release(consumer)
        self.ses.undo_snap = {"canUndo": False, "canRedo": False, "dirty": False}
        self.ses.program_id = None

    def _save_program(self, prog, why):
        """Write prog to its project file if it has unsaved changes (thread R; no transaction may be open).
        Safe while decompiles run (they only read). Returns whether anything was written."""
        from ghidra.util.task import TaskMonitor
        with self.ses.save_lock:
            if not prog.isChanged():
                return False
            t0 = time.monotonic()
            prog.getDomainFile().save(TaskMonitor.DUMMY)
            with self.ses.lock:
                self.ses.revision += 1
            if why != "save":
                log("%s save took %.2fs" % (why, time.monotonic() - t0))
            return True

    @rpc(lane="R")
    def save(self):
        prog = self.ses.need()
        saved = self._save_program(prog, "save")
        self.ses.refresh_undo(prog)
        if saved:  # Ghidra's save drops the undo/redo stacks and clears dirty: tell the client (empty ranges/kinds = nothing to refetch)
            self.ctx.notify("program_changed", {"sessionId": self.ses.session_id, "ranges": [], "kinds": [], "undo": self.ses.undo_snap},
                            generation=self.ctx.events.generation)
        return {"saved": saved, "undoHistoryCleared": saved}

    def _publish(self, prog, res, consumer, key, name):
        from ghidra.app.plugin.core.analysis import AutoAnalysisManager
        # Run on R. The staged replacement is ready before we save and release the old program.
        # follow-on analysis would write from the manager's own thread, outside R and outside our transactions
        AutoAnalysisManager.getAnalysisManager(prog).setIgnoreChanges(True)
        self.close()
        prog.clearUndo()  # the analysis transaction must not be undoable
        self.ctx.events.attach(prog)  # only now: progress covers the initial analysis
        self.ses.results, self.ses.consumer = res, consumer
        self.ses.undo_snap = {"canUndo": False, "canRedo": False, "dirty": bool(prog.isChanged())}  # clean after import/save; dirty when edits were recovered
        return self.ses.publish(prog, key, name)  # keep this last: nothing after attach may raise, or the listener would stay on a program we release

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

    @rpc(lane="open")
    async def open_binary(self, path, loader=None, language=None, compilerSpec=None, baseAddress=None, profile=None, *, _request_id=None):
        if self.ctx.lanes.opening is not None:
            raise RpcError(BUSY, "open_binary already in progress")
        args = (loader, language, compilerSpec, baseAddress, profile)
        op = self.ctx.lanes.opening = Opening(_request_id)
        fut = self.ctx.loop.create_future()
        self.ctx.progress("import", 0, "starting import")

        def body():
            try:
                res, exc = self._do_open(path, op, *args), None
            except BaseException as e:  # noqa
                res, exc = None, e
            self.ctx.loop.call_soon_threadsafe(self.ctx.lanes.settle, fut, res, exc)
        threading.Thread(target=body, daemon=True, name="open").start()
        try:
            return await asyncio.shield(fut)
        except asyncio.CancelledError:
            op.cancel()

            def finish(f):
                try:
                    f.exception()  # the disconnected caller will not consume a failed open
                except asyncio.CancelledError:
                    pass
                if self.ctx.lanes.opening is op:
                    self.ctx.lanes.opening = None
            fut.add_done_callback(finish)
            raise
        finally:
            if fut.done() and self.ctx.lanes.opening is op:
                self.ctx.lanes.opening = None

    def _do_open(self, path, op, loader, language, compilerSpec, baseAddress, profile):
        """Thread O. Stage the replacement before touching the active program on R."""
        res = prog = consumer = None
        self.ctx.project.lock.acquire()  # waits for an R-side list/delete that slipped in just before this open started
        try:
            op.check()
            text_arg(path, "path")
            if not os.path.isfile(path):
                raise RpcError(NOT_FOUND, "no such file: %s" % path)
            opts = self._check_options(loader, language, compilerSpec, baseAddress)
            if profile not in (None, "full", "fast"):
                raise RpcError(INVALID, "bad profile %r" % (profile,))
            # no profile: SIDECAR_ANALYSIS_DISABLE if set (costs nothing), else full
            disabled = analysis_disabled() if profile is None else FAST_PROFILE if profile == "fast" else []
            if sorted(disabled) == FAST_PROFILE:
                opts["profile"] = "fast"  # shown in the program browser, replayed on reopen
            size = os.path.getsize(path)
            h, done = hashlib.sha256(), 0
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    op.check()
                    h.update(chunk)
                    done += len(chunk)
                    self.ctx.progress("import", min(10, done * 10 // max(1, size)), "hashing")
            key = program_key(h.hexdigest(), opts, disabled)
            proj = self.ctx.project.ghidra_project()
            t0 = time.monotonic()
            persisted = proj.getProjectData().getFile("/" + key) is not None
            if persisted:
                self.ctx.progress("import", 100, "loading persisted analysis")
                prog, consumer = self._load_persisted(proj, key, op)
                op.check()
                self.ctx.project.meta_touch(key)
                log("reopened persisted program in %.2fs" % (time.monotonic() - t0))
            else:
                res = self._import_and_analyze(path, key, proj, op, opts, disabled)
                prog = res.getPrimaryDomainObject()
                self._save(res, op)
                self.ctx.project.meta_touch(key, name=os.path.basename(path), sourcePath=os.path.abspath(path), sizeBytes=size,
                                 analyzed=True, options=opts)
            # Claim the commit before queueing it, so shutdown waits for the whole swap.
            op.begin_commit()
            session = self.ctx.lanes.on_r(lambda: self._publish(prog, res, consumer, key, os.path.basename(path)))
            res = prog = consumer = None  # the session now owns the staged program
            self.ctx.progress("ready", 100, "ready")
            self.open_secs = time.monotonic() - t0
            return {**session, "persisted": persisted}
        except BaseException as e:  # noqa
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
            self.ctx.project.lock.release()
            op.finished = True

    def _load_persisted(self, proj, key, op):
        mon = op.monitor()
        for attempt in range(11):
            op.check()
            try:
                return self._consume(proj, "/" + key, mon)
            except Exception as e:
                op.check()
                if attempt == 10 or not re.search(r"permission denied|access denied|locked|in use|already open", repr(e), re.I):
                    log("could not load stored program %s:" % key, repr(e))
                    raise RpcError(INTERNAL, "could not load stored program %s (preserved): %s" % (key, e)) from e
                time.sleep(0.1)

    @staticmethod
    def _consume(proj, path, monitor):
        """pyghidra.consume_program with Ghidra recovery enabled for any valid existing recovery file."""
        from java.lang import Object
        from ghidra.program.model.listing import Program
        consumer = Object()
        df = proj.getProjectData().getFile(path)
        if df is None:
            raise FileNotFoundError(path)
        dobj = df.getDomainObject(consumer, True, True, monitor)
        if not Program.class_.isAssignableFrom(dobj.getClass()):
            dobj.release(consumer)
            raise TypeError("%s is not a Program" % path)
        return dobj, consumer

    def _import_and_analyze(self, path, key, proj, op, opts, disabled):
        from ghidra.app.util.importer import ProgramLoader
        self.ctx.progress("import", 10, "importing")
        last = [0.0]

        def imp_cb(msg, prog, mx):
            now = time.monotonic()
            if now - last[0] >= 0.2:
                last[0] = now
                self.ctx.progress("import", 10 + int(prog * 90 / mx) if mx and mx > 0 else -1, str(msg or "importing"))
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
        try:
            op.check()
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
                self.ctx.progress("analysis", pct, msg, analyzer=st["cur"], done=max(0, st["runs"] - 1))
            except Exception:
                pass
        mon = op.monitor(cb)
        self.ctx.progress("analysis", -1, "analyzing")
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
        op.begin_commit()
        self.ctx.progress("saving", -1, "saving to project")
        res.save(TaskMonitor.DUMMY)

    @rpc(lane="R")
    def undo_state(self, prog=None):
        return undo_state(prog or self.ses.need())

    def _undo_redo(self, undo):
        prog = self.ses.need()
        if not (prog.canUndo() if undo else prog.canRedo()):
            raise RpcError(INVALID, "nothing to %s" % ("undo" if undo else "redo"))
        try:
            prog.undo() if undo else prog.redo()
        except Exception as e:  # noqa
            raise RpcError(INTERNAL, "%s failed: %s" % ("undo" if undo else "redo", e))
        prog.flushEvents()  # RESTORED -> program_changed (ranges null) and cache clear
        with self.ses.lock:
            self.ses.revision += 1
        return self.ctx.session.refresh_undo(prog)

    @rpc(lane="R")
    def undo(self):
        return self._undo_redo(True)

    @rpc(lane="R")
    def redo(self):
        return self._undo_redo(False)

    @rpc(lane="loop")
    def cancel_open(self, id=None):
        op = self.ctx.lanes.opening
        return {"cancelled": bool(op is not None and (id is None or id == op.request_id) and op.cancel())}

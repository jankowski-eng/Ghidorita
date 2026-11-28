"""The open program's lifecycle: open_binary (hash, import, analyze, save, publish; thread O), cancel_open, close, save, undo/redo.
Closing order matters, see close(). Opens go through ctx.project (thread O holds project.lock for a whole open)."""
import asyncio, hashlib, re, threading, time, os

from ..core.args import hx, text_arg
from ..core.errors import BUSY, CANCELLED, INTERNAL, INVALID, INVALID_JAVA, NOT_FOUND, RpcError, log
from ..core.lanes import Opening
from ..core.recovery import take_recovery_snapshot
from ..core.rpc import rpc
from ..core.session import undo_state
from . import analysis as analysis_mod
from .project import FAST_PROFILE, RAW, analysis_disabled, program_key


CAPABILITIES = [
    "importOptions", "decompile", "editing", "variableEditing", "undo", "save", "symbolSearch",
    "symbolTable", "strings", "memorySearch", "references", "variableReferences", "dataTypes",
    "typeEditing", "projects", "coverage", "controlFlowGraph", "callGraph", "suggestions", "export", "exportGzf", "bytes", "calls", "bookmarks", "analysis", "debugger", "decompilerEdits", "stackFrame", "undefinedRefs", "patch", "pcode", "valueTrail",
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
        if prog is None or self.ses.analyzing or not prog.isChanged() or self.snapshot_revision == revision:  # an analysis owns the transaction (and saves itself when done)
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
        if prog is not None and not self.ctx.analysis.stop():  # cancel + wait: the analysis saves what it found, then edits are possible again
            raise RuntimeError("analysis did not stop in time, not closing the current program")
        if prog is not None:  # autosave: closing must never lose edits (see protocol.md, Persistence and crash safety)
            try:
                self._save_program(prog, "close")
            except Exception as e:  # noqa
                log("close save FAILED, keeping the program open:", repr(e))
                raise RuntimeError("save failed before closing the current program: %s" % e) from e
        if prog is not None and self.ctx.debug is not None:
            self.ctx.debug.teardown()  # after the analysis stopped and the save succeeded (a failure keeps the program, and its debugger, as they were); a connection and its step worker belong to the program being released
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
        self.ctx.analysis.reset("none", "full")

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
        if not self.ctx.analysis.stop():  # a running analysis holds the transaction: it is cancelled (state partial) and saves itself
            raise RpcError(BUSY, "analysis running")
        saved = self._save_program(prog, "save")
        self.ses.refresh_undo(prog)
        if saved:  # Ghidra's save drops the undo/redo stacks and clears dirty: tell the client (empty ranges/kinds = nothing to refetch)
            self.ctx.notify("program_changed", {"sessionId": self.ses.session_id, "ranges": [], "kinds": [], "undo": self.ses.undo_snap},
                            generation=self.ctx.events.generation)
        return {"saved": saved, "undoHistoryCleared": saved}

    def _publish(self, prog, res, consumer, key, name, analyzing=False):
        from ghidra.app.plugin.core.analysis import AutoAnalysisManager
        # Run on R. The staged replacement is ready before we save and release the old program.
        # follow-on analysis would write from the manager's own thread, outside R and outside our transactions
        AutoAnalysisManager.getAnalysisManager(prog).setIgnoreChanges(True)
        self.close()
        prog.clearUndo()  # the analysis transaction must not be undoable
        self.ctx.events.attach(prog)  # only now: progress covers the initial analysis
        self.ses.results, self.ses.consumer = res, consumer
        self.ses.undo_snap = {"canUndo": False, "canRedo": False, "dirty": bool(prog.isChanged())}  # clean after import/save; dirty when edits were recovered
        self.ses.analyzing = analyzing  # set before the program is visible: no edit can slip in before the analysis starts
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
    async def open_binary(self, path, loader=None, language=None, compilerSpec=None, baseAddress=None, profile=None, analysis=None, *, _request_id=None):
        return await self._open(_request_id, lambda op: self._do_open(path, op, loader, language, compilerSpec, baseAddress, profile, analysis))

    @rpc(lane="open")
    async def open_program(self, programId, analysis=None, *, _request_id=None):
        """Open a stored program by its key: no source file is read, hashed or needed."""
        return await self._open(_request_id, lambda op: self._do_open(None, op, None, None, None, None, None, analysis, stored=programId))

    async def _open(self, request_id, run):
        if self.ctx.lanes.opening is not None:
            raise RpcError(BUSY, "open_binary already in progress")
        op = self.ctx.lanes.opening = Opening(request_id)
        fut = self.ctx.loop.create_future()
        self.ctx.progress("import", 0, "starting import")

        def body():
            try:
                res, exc = run(op), None
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

    def _do_open(self, path, op, loader, language, compilerSpec, baseAddress, profile, analysis=None, stored=None):
        """Thread O. Stage the replacement before touching the active program on R. `stored` = a programId: load that program, path is None."""
        res = prog = consumer = None
        self.ctx.project.lock.acquire()  # waits for an R-side list/delete that slipped in just before this open started
        try:
            op.check()
            if analysis not in (None, "background", "blocking"):
                raise RpcError(INVALID, "bad analysis %r" % (analysis,))
            blocking = analysis == "blocking"
            proj = self.ctx.project.ghidra_project()
            if stored is not None:
                text_arg(stored, "programId")
                key, opts = stored, self.ctx.project.meta_get(stored).get("options") or {}
                name = self.ctx.project.meta_get(stored).get("name") or stored
                if proj.getProjectData().getFile("/" + key) is None:
                    raise RpcError(NOT_FOUND, "no stored program %s" % key)
            else:
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
                name = os.path.basename(path)
                size = os.path.getsize(path)
                h, done = hashlib.sha256(), 0
                with open(path, "rb") as f:
                    for chunk in iter(lambda: f.read(1 << 20), b""):
                        op.check()
                        h.update(chunk)
                        done += len(chunk)
                        self.ctx.progress("import", min(10, done * 10 // max(1, size)), "hashing")
                key = program_key(h.hexdigest(), opts, disabled)
            t0 = time.monotonic()
            persisted = stored is not None or proj.getProjectData().getFile("/" + key) is not None
            if persisted:
                self.ctx.progress("import", 100, "loading persisted analysis")
                prog, consumer = self._load_persisted(proj, key, op)
                op.check()
                self.ctx.project.meta_touch(key)
                log("reopened persisted program in %.2fs" % (time.monotonic() - t0))
                m = self.ctx.project.meta_get(key)  # a program from before round 7 has no record: it was analyzed
                rec, prof = m.get("analysis", "done"), m.get("analysisProfile") or opts.get("profile", "full")
                disabled = FAST_PROFILE if prof == "fast" else []
                if blocking and rec != "done":  # finish an interrupted analysis before replying
                    self._analyze(prog, op, disabled)
                    self._save_done(prog, op)
                    self.ctx.project.meta_update(key, analysis="done", analysisProfile=prof, analyzed=True)
                    rec = "done"
            else:
                prof = "fast" if sorted(disabled) == FAST_PROFILE else "full"
                res = self._import_and_analyze(path, key, proj, op, opts, disabled, blocking)
                prog = res.getPrimaryDomainObject()
                self._save(res, op)
                rec = "done" if blocking else "none"
                self.ctx.project.meta_touch(key, name=os.path.basename(path), sourcePath=os.path.abspath(path), sizeBytes=size,
                                            analyzed=blocking, analysis=rec, analysisProfile=prof, options=opts)
            # Claim the commit before queueing it, so shutdown waits for the whole swap.
            op.begin_commit()
            session = self.ctx.lanes.on_r(lambda: self._publish(prog, res, consumer, key, name, rec != "done"))
            published, res, prog, consumer = prog, None, None, None  # the session now owns the staged program
            self.ctx.analysis.reset(rec, prof)
            if rec != "done":  # background open of a new import, or of an interrupted analysis: resume
                self.ctx.analysis.start(published, key, disabled, prof)
            self.ctx.progress("ready", 100, "ready")
            self.open_secs = time.monotonic() - t0
            return {**session, "persisted": persisted, "analysis": self.ctx.analysis.state()}
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

    def _import_and_analyze(self, path, key, proj, op, opts, disabled, blocking):
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
            if blocking:
                self._analyze(res.getPrimaryDomainObject(), op, disabled)
        except BaseException:
            res.close()
            raise
        return res

    def _save_done(self, prog, op):
        """A blocking analysis of a stored program finished: write it (the point of no return for cancel_open, like _save)."""
        from ghidra.util.task import TaskMonitor
        op.begin_commit()
        prog.clearUndo()
        self.ctx.progress("saving", -1, "saving to project")
        with self.ses.save_lock:
            prog.getDomainFile().save(TaskMonitor.DUMMY)

    def _analyze(self, prog, op, disabled):
        """Blocking analysis on thread O (analysis="blocking"): same engine as the background one (analysis.execute), progress as `progress`
        events. The monitor is polled, never a Python callback: see domains/analysis.py. Ghidra has no global total, so pct is the current
        analyzer's progress/max when it reports one, else -1; `done` counts analyzer starts seen."""
        from ghidra.app.script import GhidraScriptUtil
        mon = op.adopt(analysis_mod.new_monitor())
        poller = analysis_mod.Poller(mon, lambda an, done, pct, msg: self.ctx.progress("analysis", pct, msg or an, analyzer=an, done=done))
        self.ctx.progress("analysis", -1, "analyzing")
        GhidraScriptUtil.acquireBundleHostReference()
        tx = prog.startTransaction("Analysis")
        try:
            analysis_mod.execute(prog, mon, disabled)
            op.check()
        finally:
            prog.endTransaction(tx, True)
            GhidraScriptUtil.releaseBundleHostReference()
            poller.stop()

    def _save(self, res, op):
        from ghidra.util.task import TaskMonitor
        op.begin_commit()
        self.ctx.progress("saving", -1, "saving to project")
        res.save(TaskMonitor.DUMMY)

    @rpc(lane="R")
    def undo_state(self, prog=None):
        return undo_state(prog or self.ses.need())

    def _undo_redo(self, undo, expect=None):
        prog = self.ses.need()
        if self.ses.analyzing:
            raise RpcError(BUSY, "analysis running")
        if not (prog.canUndo() if undo else prog.canRedo()):
            raise RpcError(INVALID, "nothing to %s" % ("undo" if undo else "redo"))
        if expect is not None:  # on R, so no edit can land between this check and the undo
            top = str(prog.getUndoName())
            if top != expect:
                raise RpcError(CANCELLED, "the top undo step is %r, not %r; nothing was undone" % (top, expect))
        try:
            prog.undo() if undo else prog.redo()
        except Exception as e:  # noqa
            raise RpcError(INTERNAL, "%s failed: %s" % ("undo" if undo else "redo", e))
        prog.flushEvents()  # RESTORED -> program_changed (ranges null) and cache clear
        with self.ses.lock:
            self.ses.revision += 1
        return self.ctx.session.refresh_undo(prog)

    @rpc(lane="R")
    def undo(self, expect=None):
        if expect is not None and not isinstance(expect, str):
            raise RpcError(INVALID, "expect must be a string")
        return self._undo_redo(True, expect)

    @rpc(lane="R")
    def redo(self):
        return self._undo_redo(False)

    @rpc(lane="loop")
    def cancel_open(self, id=None):
        op = self.ctx.lanes.opening
        return {"cancelled": bool(op is not None and (id is None or id == op.request_id) and op.cancel())}

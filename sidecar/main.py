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
from ghidrette.domains.project import FAST_PROFILE, RAW, Project, analysis_disabled, program_key
from ghidrette.domains.search import Search
from ghidrette.domains.highvars import HighVars
from ghidrette.domains.decompile import Decompile
from ghidrette.domains.edits import Edits
from ghidrette.domains.datatypes import DataTypes
from ghidrette.domains.listing import Listing
from ghidrette.domains.xrefs import Xrefs
from ghidrette.core.errors import (BUSY, CANCELLED, INTERNAL, INVALID, INVALID_JAVA, NO_PROGRAM, NOT_FOUND,
                                   PROJECT_LOCKED, TIMEOUT, RpcError, log)
class Sidecar:
    def __init__(self):
        self.ctx = ctx = Ctx()
        ctx.project = Project(ctx)
        ctx.shutdown_hooks += [lambda: self._close(), ctx.project.close]
        self.registry = Registry()
        self.registry.register(ctx.project)
        self.registry.register(self)
        for dom in (HighVars, Decompile, Edits, DataTypes, Listing, Search, Xrefs):
            self.registry.register(dom(ctx))
        self.server = Server(ctx, Dispatcher(ctx, self.registry).handle)
        ctx.lanes.start()

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
        self.ctx.project.lock.acquire()  # waits for an R-side list/delete that slipped in just before this open started
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
            key = program_key(h.hexdigest(), opts, disabled)
            proj = self.ctx.project.ghidra_project()
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
                    self.ctx.project.meta_touch(key)
                    log("reopened persisted program in %.2fs" % (time.monotonic() - t0))
            if not persisted:
                res, prog, consumer = self._import_and_analyze(path, key, proj, op, opts, disabled), None, None
                prog = res.getPrimaryDomainObject()
                self._save(res, op)
                self.ctx.project.meta_touch(key, name=os.path.basename(path), sourcePath=os.path.abspath(path), sizeBytes=os.path.getsize(path),
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
            self.ctx.project.lock.release()

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

    @rpc(lane="R")
    def undo_state(self, prog=None):
        return undo_state(prog or self.need())

    _name_arg = staticmethod(name_arg)

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

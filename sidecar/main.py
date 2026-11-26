#!/usr/bin/env python3
"""Ghidra sidecar: JSON-RPC 2.0 over WebSocket (see ../protocol.md for the contract and the threading rules).

Threads: the asyncio loop (dispatch, cancel_*), R (all program reads and ALL writes), O (one open_binary at a time:
import + analysis + save), and N decompiler workers sharing one queue, each owning a DecompInterface.
"""
import asyncio, concurrent.futures, datetime, hashlib, json, os, queue, re, signal, sys, threading, time
from collections import OrderedDict

import websockets

NO_PROGRAM, CANCELLED, TIMEOUT, NOT_FOUND, BUSY, INTERNAL, NO_METHOD, INVALID = -32001, -32002, -32003, -32004, -32005, -32603, -32601, -32602
KINDS = {0: "keyword", 1: "comment", 2: "type", 3: "function", 4: "variable", 5: "const",
         6: "param", 7: "variable", 8: "default", 9: "default", 10: "default"}
# program_changed kinds, see protocol.md. Everything not listed is "other".
ALL_KINDS = ["symbol", "comment", "function", "data", "code", "type", "other"]
KIND_PREFIX = [("SYMBOL_", "symbol"), ("EXTERNAL_", "symbol"), ("REFERENCE_", "symbol"), ("REFERNCE_", "symbol"), ("EQUATE_", "symbol"),
               ("COMMENT_", "comment"), ("FUNCTION_", "function"), ("VARIABLE_REFERENCE_", "function"),
               ("CODE_UNIT_PROPERTY_", "data"), ("MEMORY_BYTES_", "data"), ("CODE_", "code"), ("FALLTHROUGH_", "code"),
               ("FLOW_OVERRIDE_", "code"), ("LENGTH_OVERRIDE_", "code"), ("DATA_TYPE_", "type"), ("SOURCE_ARCHIVE_", "type")]
# kinds whose cache effect is fully described by their ranges (everything else clears the whole decompile cache)
RANGE_ONLY_KINDS = {"comment", "code"}
RAW = "Raw Binary"  # BinaryLoader.BINARY_NAME: the only stock loader with a base address option ("-loader-baseAddr")
KEY_RE = re.compile(r"^[0-9a-f]{64}(-[0-9a-f]{12})?$")
INVALID_JAVA = {"InvalidInputException", "DuplicateNameException", "ParseException", "InvalidDataTypeException",
                "IllegalArgumentException", "CancelledException", "UsrException", "AddressOutOfBoundsException",
                "LoadException", "LanguageNotFoundException", "CompilerSpecNotFoundException"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def hx(off):
    return "0x%x" % off


def lim(v, default, hi=None):
    v = default if v is None else int(v)
    if v < 0:
        raise RpcError(INVALID, "negative argument")
    return min(v, hi) if hi else v


def text_arg(v, what):
    if not isinstance(v, str):
        raise RpcError(INVALID, "%s must be a string" % what)
    return v


class Job:
    """A decompile request (loop thread creates it, a pool worker runs it)."""
    def __init__(self, epoch):
        self.cancelled, self.mon, self.epoch = False, None, epoch


class Opening:
    """The open_binary in progress. cancel() is called from the loop thread, mon is swapped by thread O."""
    def __init__(self):
        self.cancelled, self.mon, self.saving, self.finished = False, None, False, False
        self.lock = threading.Lock()

    def cancel(self):
        with self.lock:
            if self.saving:  # saving to the project is not interruptible: a half-written program must never happen
                return False
            self.cancelled = True
            if self.mon is not None:
                self.mon.cancel()
            return True

    def monitor(self, cb=None):
        from ghidra.pyghidra import PyGhidraTaskMonitor
        m = PyGhidraTaskMonitor(None, cb)
        with self.lock:
            self.mon = m
            if self.cancelled:
                m.cancel()
        return m

    def check(self):
        if self.cancelled:
            raise RpcError(CANCELLED, "open cancelled")


class Worker:
    def __init__(self):
        self.decomp, self.epoch, self.busy = None, -1, False


class Sidecar:
    def __init__(self):
        self.loop = None
        self.ws = None
        self.jobs = queue.Queue()    # thread R: reads, edits, undo/redo. Never waits behind a decompile or an open.
        self.djobs = queue.Queue()   # decompiler pool, one shared queue
        self.program = self.results = self.consumer = self.listener = None
        self.epoch = 0               # bumped whenever the program changes (open/close); guarded by pool_lock
        self.pool_lock = threading.Lock()
        self.running = set()         # decompile Jobs currently inside a worker; pool_lock
        self.workers = []
        self.cache = OrderedDict()   # entry offset -> (lo, hi, result); cache_lock
        self.cache_ver = 0
        self.cache_lock = threading.Lock()
        self.dj = {}                 # request id -> Job, loop thread only
        self.mon_lock = threading.Lock()
        self.opening = None          # Opening, loop thread only
        self.proj = None
        self.proj_lock = threading.Lock()  # held by thread O for a whole open, briefly by R for list/delete/candidates: never concurrent
        self.program_id = None
        self.undo_snap = {"canUndo": False, "canRedo": False, "dirty": False}
        self.save_lock = threading.Lock()  # held for the duration of every save; shutdown never exits while it is held
        self.sd_lock, self.sd_started = threading.Lock(), False
        self.strings = None          # list_strings scan cache, reset on any program change
        self.pending = {"ranges": [], "kinds": set(), "broad": False, "armed": False}
        self.plock = threading.Lock()
        self.tl = threading.local()
        threading.Thread(target=self._worker, args=(self.jobs,), daemon=True).start()
        for _ in range(max(1, int(os.environ.get("SIDECAR_DECOMP_WORKERS", "2")))):
            w = Worker()
            self.workers.append(w)
            threading.Thread(target=self._pool_worker, args=(w,), daemon=True).start()

    # ---- worker plumbing ----
    def _worker(self, q):
        while True:
            fn, fut = q.get()
            try:
                res, exc = fn(), None
            except BaseException as e:  # noqa
                res, exc = None, e
            self._deliver(fut, res, exc)

    def _pool_worker(self, w):
        self.tl.w = w
        while True:
            try:
                item = self.djobs.get(timeout=0.1)
            except queue.Empty:
                item = None
            # dispose on the owning thread once the program this interface was opened on is gone
            if w.decomp is not None and w.epoch != self.epoch:
                self._dispose(w)
            if item is None:
                continue
            fn, fut = item
            try:
                res, exc = fn(), None
            except BaseException as e:  # noqa
                res, exc = None, e
            self._deliver(fut, res, exc)

    @staticmethod
    def _dispose(w):
        d, w.decomp = w.decomp, None
        if d is not None:
            try:
                d.dispose()
            except Exception:
                pass

    @staticmethod
    def _settle(fut, res, exc):
        if not fut.done():
            fut.set_exception(exc) if exc else fut.set_result(res)

    def _deliver(self, fut, res, exc):
        if isinstance(fut, concurrent.futures.Future):  # waited on by a thread, not the loop
            self._settle(fut, res, exc)
        else:
            self.loop.call_soon_threadsafe(self._settle, fut, res, exc)

    def run(self, fn, q=None):
        fut = self.loop.create_future()
        (q or self.jobs).put((fn, fut))
        return fut

    def on_r(self, fn):
        """Blocking call from another thread (O, shutdown): run fn on thread R, after everything queued before it."""
        f = concurrent.futures.Future()
        self.jobs.put((fn, f))
        return f.result()

    def notify(self, method, params):  # thread-safe
        def send():
            if self.ws is not None:
                asyncio.ensure_future(self._send(json.dumps({"jsonrpc": "2.0", "method": method, "params": params})))
        self.loop.call_soon_threadsafe(send)

    async def _send(self, s):
        try:
            await self.ws.send(s)
        except Exception:
            pass

    def progress(self, phase, pct, message="", **extra):
        self.notify("progress", {"phase": phase, "pct": pct, "message": message, **extra})

    # ---- helpers ----
    def need(self):
        if self.program is None:
            raise RpcError(NO_PROGRAM, "no program open")
        return self.program

    def addr(self, s, prog=None):
        prog = prog or self.need()
        try:
            off = int(s, 16)
            # shortcut: single default address space only, upgrade when segmented/overlay binaries matter
            return prog.getAddressFactory().getDefaultAddressSpace().getAddress(off)
        except Exception:
            raise RpcError(INVALID, "bad address %r" % (s,))

    @staticmethod
    def _projects_dir():
        return os.environ.get("SIDECAR_PROJECTS_DIR") or os.path.expanduser("~/Library/Application Support/ghidra-desktop-spike/projects")

    def _project(self):
        """One Ghidra project for all programs, programs named by their programId. Only with proj_lock held (thread O
        during an open, thread R for list/delete).
        shortcut: a second sidecar on the same projects dir fails on the project lock; one process per dir."""
        if self.proj is None:
            from ghidra.base.project import GhidraProject
            from ghidra.framework.model import ProjectLocator
            d = self._projects_dir()
            os.makedirs(d, exist_ok=True)
            # GhidraProject, not pyghidra.open_project: that one builds a GUI-oriented DefaultProjectManager which hangs headless here
            gp = (GhidraProject.openProject(d, "spike", True) if ProjectLocator(d, "spike").exists()
                  else GhidraProject.createProject(d, "spike", False))
            self.proj = gp.getProject()
        return self.proj

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
                if chosen is None:  # only Raw Binary (always offered, needs a language) applies: "nothing recognises the file"
                    return {"candidates": []}
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
                return {"candidates": out}
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
        self._close()
        return {}

    # ---- program lifecycle ----
    def _close(self, strict=False):
        """Run on thread R. Order matters: stop new decompiles, cancel running ones, wait until every worker
        disposed its DecompInterface (on its own thread), only then release the program."""
        prog, res, consumer, lst = self.program, self.results, self.consumer, self.listener
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
        if prog is not None and lst is not None:
            try:
                prog.removeListener(lst)
            except Exception:
                pass
        self.listener = None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and any(w.busy or w.decomp is not None for w in self.workers):
            time.sleep(0.02)
        stuck = any(w.busy or w.decomp is not None for w in self.workers)
        if stuck:
            log("decompiler worker still busy after 10 s: leaking the old program instead of releasing it under a live decompiler")
        self.cache_clear()
        self.strings = None
        with self.plock:
            self.pending.update(ranges=[], kinds=set(), broad=False)
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
        self.undo_snap = self.undo_state(prog)
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
        lst = self._make_listener(prog)
        prog.addListener(lst)  # only now: progress covers the initial analysis
        self.listener, self.results, self.consumer = lst, res, consumer
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
    def _program_key(sha, opts):
        """protocol.md "Persistence key"."""
        if not opts:
            return sha
        canon = json.dumps({k: opts.get(k) for k in ("loader", "language", "compilerSpec", "baseAddress")}, separators=(",", ":"))
        return sha + "-" + hashlib.sha256(canon.encode()).hexdigest()[:12]

    async def open_binary(self, path, loader=None, language=None, compilerSpec=None, baseAddress=None):
        text_arg(path, "path")
        if self.opening is not None:
            raise RpcError(BUSY, "open_binary already in progress")
        if not os.path.isfile(path):
            raise RpcError(NOT_FOUND, "no such file: %s" % path)
        opts = self._check_options(loader, language, compilerSpec, baseAddress)
        op = self.opening = Opening()
        fut = self.loop.create_future()

        def body():
            try:
                res, exc = self._do_open(path, op, opts), None
            except BaseException as e:  # noqa
                res, exc = None, e
            self.loop.call_soon_threadsafe(self._settle, fut, res, exc)
        threading.Thread(target=body, daemon=True, name="open").start()
        try:
            return await fut
        finally:
            self.opening = None

    def _do_open(self, path, op, opts):
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
            key = self._program_key(h.hexdigest(), opts)
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
                res, prog, consumer = self._import_and_analyze(path, key, proj, op, opts), None, None
                prog = res.getPrimaryDomainObject()
                self._save(res, op)
                self._meta_touch(key, name=os.path.basename(path), sourcePath=os.path.abspath(path), sizeBytes=os.path.getsize(path),
                                 analyzed=True, options=opts)
            try:
                self._publish(prog, res, consumer, op, key)
            except BaseException:
                if self.listener is not None:
                    prog.removeListener(self.listener)
                self.listener = self.results = self.consumer = None
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

    def _import_and_analyze(self, path, key, proj, op, opts):
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
            self._analyze(res.getPrimaryDomainObject(), op)
        except BaseException:
            res.close()
            raise
        return res

    def _analyze(self, prog, op):
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
            mgr.initializeOptions()
            mgr.reAnalyzeAll(None)
            mgr.startAnalysis(mon)  # blocks this thread; cancel_open cancels mon from the loop thread
            op.check()
            GhidraProgramUtilities.markProgramAnalyzed(prog)
        finally:
            prog.endTransaction(tx, True)
            GhidraScriptUtil.releaseBundleHostReference()

    def _save(self, res, op):
        from ghidra.util.task import TaskMonitor
        with op.lock:
            if op.cancelled:
                raise RpcError(CANCELLED, "open cancelled")
            op.saving = True  # point of no return: cancel_open now answers cancelled=false
        self.progress("saving", -1, "saving to project")
        res.save(TaskMonitor.DUMMY)

    # ---- change events (listener runs on Ghidra's event thread; it only copies data and never touches the DB) ----
    def _make_listener(self, prog):
        from jpype import JClass, JImplements, JObject, JOverride
        sc, space = self, prog.getAddressFactory().getDefaultAddressSpace()

        @JImplements("ghidra.framework.model.DomainObjectListener")
        class L:
            @JOverride
            def domainObjectChanged(self, ev):
                try:
                    sc._on_events(ev, space)
                except Exception as e:  # noqa
                    log("listener error", repr(e))
                    sc._record(set(ALL_KINDS), None)
        # Ghidra keeps listeners in a weak set: hold a strong reference to the *Java* proxy, or a GC silently drops it
        return JObject(L(), JClass("ghidra.framework.model.DomainObjectListener"))

    def _on_events(self, ev, space):
        from ghidra.program.util import ProgramChangeRecord
        kinds, ranges, broad = set(), [], False
        for r in ev:
            name = str(r.getEventType())
            if not isinstance(r, ProgramChangeRecord):  # DomainObjectEvent: RESTORED (undo/redo), SAVED, ... : anything may have changed
                if name == "RESTORED":
                    kinds.update(ALL_KINDS)
                    broad = True
                continue
            kinds.add(next((k for p, k in KIND_PREFIX if name.startswith(p)), "other"))
            s, e = r.getStart(), r.getEnd()
            if s is None or s.isExternalAddress() or s.getAddressSpace() != space:
                broad = True  # type events, other spaces, ...: no usable range
            else:
                ranges.append((s.getOffset(), (e or s).getOffset()))
        if not kinds:
            return
        self._record(kinds, None if broad else ranges)

    def _record(self, kinds, ranges):
        self.strings = None
        # decompile output embeds names/types of other symbols, so only comment/code changes are ranged; shortcut:
        # symbol/function/data/type/other changes clear the whole cache, upgrade by tracking referenced addresses per entry.
        if ranges is None or not kinds <= RANGE_ONLY_KINDS:
            self.cache_clear()
        else:
            self.cache_invalidate(ranges)
        with self.plock:
            p = self.pending
            p["kinds"] |= kinds
            if ranges is None:
                p["broad"] = True
            else:
                p["ranges"].extend(ranges)
            if p["armed"]:
                return
            p["armed"] = True
        self.loop.call_soon_threadsafe(lambda: self.loop.call_later(0.05, self._emit))

    def _emit(self):
        with self.plock:
            p = self.pending
            kinds, broad, ranges = sorted(p["kinds"], key=ALL_KINDS.index), p["broad"], sorted(p["ranges"])
            p.update(ranges=[], kinds=set(), broad=False, armed=False)
        merged = []
        for s, e in ranges:
            if merged and s <= merged[-1][1] + 1:
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e])
        if broad or len(merged) > 1000:
            out = None
        else:
            out = [{"start": hx(s), "end": hx(e)} for s, e in merged]
        self.notify("program_changed", {"ranges": out, "kinds": kinds, "undo": self.undo_snap})

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
        for f in self.need().getFunctionManager().getFunctions(True):
            if f.isExternal():
                continue
            out.append((f.getEntryPoint().getOffset(), str(f.getName()), f.getBody().getNumAddresses()))
        out.sort()
        return [{"name": n, "entry": hx(o), "size": int(s)} for o, n, s in out]

    def get_function_at(self, address):
        prog = self.need()
        f = prog.getFunctionManager().getFunctionContaining(self.addr(address))
        if f is None:
            return None
        return {"name": str(f.getName()), "entry": hx(f.getEntryPoint().getOffset()),
                "size": int(f.getBody().getNumAddresses()), "signature": str(f.getSignature().getPrototypeString())}

    @staticmethod
    def _sym_kind(prog, s):
        from ghidra.program.model.symbol import SymbolType
        t = s.getSymbolType()
        if t == SymbolType.FUNCTION:
            return "function"
        if s.isExternal():
            return "external"
        if t == SymbolType.LABEL:
            d = prog.getListing().getDefinedDataAt(s.getAddress())
            return "data" if d is not None else "label"
        return "other"

    def search_symbols(self, query, limit=100):
        """shortcut: linear scan of all symbols in Python, upgrade to an in-sidecar name index when binaries have > ~1M symbols."""
        prog = self.need()
        text_arg(query, "query")
        limit = lim(limit, 100, 5000)
        st, out, seen = prog.getSymbolTable(), [], set()
        q = query.strip().lower()
        if not q:
            return []
        try:  # a hex address: symbols there, else a bare address hit if it is mapped memory
            a = self.addr(q if q.startswith("0x") else "0x" + q)
            if prog.getMemory().contains(a):
                syms = list(st.getSymbols(a))
                for s in syms:
                    out.append({"name": str(s.getName()), "address": hx(a.getOffset()), "kind": self._sym_kind(prog, s)})
                if not syms:
                    out.append({"name": hx(a.getOffset()), "address": hx(a.getOffset()), "kind": "other"})
                seen.update(o["name"] + o["address"] for o in out)
        except RpcError:
            pass
        for s in st.getAllSymbols(False):
            if len(out) >= limit:
                break
            n = str(s.getName())
            if q in n.lower():
                a = s.getAddress()
                if a.isExternalAddress() or a.getAddressSpace() != prog.getAddressFactory().getDefaultAddressSpace():
                    continue
                o = {"name": n, "address": hx(a.getOffset()), "kind": self._sym_kind(prog, s)}
                if o["name"] + o["address"] not in seen:
                    out.append(o)
        return out[:limit]

    def xrefs_to(self, address, limit=500):
        prog = self.need()
        limit, a, out = lim(limit, 500, 10000), self.addr(address), []
        fm = prog.getFunctionManager()
        for r in prog.getReferenceManager().getReferencesTo(a):
            if len(out) >= limit:
                break
            fa = r.getFromAddress()
            o = {"from": hx(fa.getOffset()), "type": str(r.getReferenceType().getName())}
            f = fm.getFunctionContaining(fa)
            if f is not None:
                o["function"] = str(f.getName())
            out.append(o)
        out.sort(key=lambda o: int(o["from"], 16))
        return out

    def xrefs_from(self, address):
        prog = self.need()
        a = self.addr(address)
        cu = prog.getListing().getCodeUnitContaining(a)
        a = cu.getMinAddress() if cu is not None else a
        out = []
        for r in prog.getReferenceManager().getReferencesFrom(a):
            if r.isMemoryReference():  # shortcut: stack/register/external references are not listed
                out.append({"to": hx(r.getToAddress().getOffset()), "type": str(r.getReferenceType().getName())})
        return out

    def list_strings(self, offset=0, limit=500, minLength=4):
        """shortcut: full scan of defined strings per cache miss (cached until the next program change), upgrade to an index on huge binaries."""
        prog = self.need()
        offset, limit, minLength = lim(offset, 0), lim(limit, 500, 5000), lim(minLength, 4)
        if self.strings is None or self.strings[0] != minLength:
            from ghidra.program.util import DefinedStringIterator
            from ghidra.program.model.data import StringDataInstance
            items = []
            for d in DefinedStringIterator.forProgram(prog):
                v = StringDataInstance.getStringDataInstance(d).getStringValue()
                if v is not None and len(str(v)) >= minLength:
                    items.append({"address": hx(d.getMinAddress().getOffset()), "value": str(v), "length": int(d.getLength())})
            self.strings = (minLength, items)
        items = self.strings[1]
        return {"total": len(items), "items": items[offset:offset + limit]}

    def list_data_types(self, query, limit=100):
        from ghidra.program.model.data import BuiltInDataTypeManager
        prog = self.need()
        text_arg(query, "query")
        limit, q = lim(limit, 100, 1000), query.strip().lower()
        hits, seen = [], set()
        for dtm in (BuiltInDataTypeManager.getDataTypeManager(), prog.getDataTypeManager()):
            for dt in dtm.getAllDataTypes():
                n = str(dt.getName())
                if q in n.lower() and str(dt.getPathName()) not in seen:
                    seen.add(str(dt.getPathName()))
                    hits.append((0 if n.lower().startswith(q) else 1, len(n), {"name": n, "path": str(dt.getPathName()), "size": int(dt.getLength())}))
        hits.sort(key=lambda h: h[:2])
        return [h[2] for h in hits[:limit]]

    def undo_state(self, prog=None):
        prog = prog or self.need()
        o = {"canUndo": bool(prog.canUndo()), "canRedo": bool(prog.canRedo()), "dirty": bool(prog.isChanged())}
        if o["canUndo"]:
            o["undoName"] = str(prog.getUndoName())
        if o["canRedo"]:
            o["redoName"] = str(prog.getRedoName())
        return o

    def listing_info(self):
        mem = self.need().getMemory()
        space = self.program.getAddressFactory().getDefaultAddressSpace()  # shortcut: default space only
        ranges = [{"start": hx(r.getMinAddress().getOffset()), "size": int(r.getLength())}
                  for r in mem.getLoadedAndInitializedAddressSet() if r.getMinAddress().getAddressSpace() == space]
        return {"ranges": ranges, "totalBytes": sum(r["size"] for r in ranges)}

    def listing_rows(self, address, count, direction="forward"):
        """Walk code units from an anchor address; no index. See protocol.md."""
        from ghidra.program.model.listing import CommentType, Instruction
        from jpype import JArray, JByte
        prog = self.need()
        fwd = direction != "backward"
        count = max(0, min(int(count), 1000))
        listing, st, mem = prog.getListing(), prog.getSymbolTable(), prog.getMemory()
        loaded = mem.getLoadedAndInitializedAddressSet()
        a = self.addr(address)
        cu = listing.getCodeUnitContaining(a)
        a = cu.getMinAddress() if cu is not None else a
        lo, hi = loaded.getMinAddress(), loaded.getMaxAddress()
        if count == 0 or lo is None:
            return []
        if fwd:
            if a.compareTo(hi) > 0:
                return []
            view = loaded.intersectRange(a if a.compareTo(lo) >= 0 else lo, hi)
        else:
            if a.compareTo(lo) <= 0:
                return []
            end = a.previous()
            view = loaded.intersectRange(lo, end if end.compareTo(hi) <= 0 else hi)
        rows = []
        for cu in listing.getCodeUnits(view, fwd):
            if len(rows) >= count:
                break
            ca = cu.getMinAddress()
            n = cu.getLength()
            if isinstance(cu, Instruction):
                ops = ", ".join(str(cu.getDefaultOperandRepresentation(i)) for i in range(cu.getNumOperands()))
            else:
                ops = str(cu.getDefaultValueRepresentation())
            if n <= 16:
                b = bytes(x & 0xFF for x in cu.getBytes())
            else:  # shortcut: show the first 16 bytes of big data units only
                buf = JArray(JByte)(16)
                mem.getBytes(ca, buf)
                b = bytes(x & 0xFF for x in buf)
            row = {"address": hx(ca.getOffset()), "length": int(n), "bytes": b.hex(" ") + (" …" if n > 16 else ""),
                   "mnemonic": str(cu.getMnemonicString()), "operands": ops}
            sym = st.getPrimarySymbol(ca)
            if sym is not None:
                row["label"] = str(sym.getName())
            c = cu.getComment(CommentType.EOL)
            if c:
                row["comment"] = str(c)
            rows.append(row)
        if not fwd:
            rows.reverse()
        return rows

    # ---- edits (thread R). One transaction each; its name is the undo label. ----
    def edit(self, name, fn):
        """Run fn(prog) in one transaction, then flush Ghidra's event queue so the cache invalidation (listener) has
        happened before the reply is sent: a decompile requested after the reply can never see a stale entry."""
        import jpype
        prog = self.need()
        tx, ok = prog.startTransaction(name), False
        try:
            r = fn(prog)
            ok = True
        except jpype.JException as e:
            kind = str(e.getClass().getSimpleName())
            raise RpcError(INVALID if kind in INVALID_JAVA else INTERNAL, str(e.getMessage() or kind))
        finally:
            prog.endTransaction(tx, ok)  # not ok => rolled back, nothing on the undo stack
            prog.flushEvents()  # also on rollback: a decompile that saw the half-applied state must not be cached
        self.undo_snap = self.undo_state(prog)
        return r

    @staticmethod
    def _name_arg(v, what="name"):
        text_arg(v, what)
        if not v or any(c.isspace() for c in v):
            raise RpcError(INVALID, "invalid %s %r" % (what, v))
        return v

    @staticmethod
    def _cmd(cmd):
        def run(prog):
            if not cmd.applyTo(prog):
                raise RpcError(INVALID, str(cmd.getStatusMsg() or "command failed"))
        return run

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
        self.edit("Create function at %s" % hx(a.getOffset()), self._cmd(cmd))
        f = fm.getFunctionAt(a)
        if f is None:
            raise RpcError(INTERNAL, "function was not created")
        return {"entry": hx(a.getOffset()), "name": str(f.getName())}

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
        self._record({"data"}, [self._data_ranges])
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
            hi = a.getAddressSpace().getMaxAddress() if a.getOffset() + n - 1 > a.getAddressSpace().getMaxAddress().getOffset() else a.add(n - 1)
        view = AddressSet(lo, hi).intersect(mem)
        # ClearCmd.applyTo returns true even when it did nothing; an empty transaction would not be undoable
        if not any(not hasattr(cu, "isDefined") or cu.isDefined() for cu in listing.getCodeUnits(view, True)):
            raise RpcError(INVALID, "no instructions or defined data in range")
        self.edit("Clear code", lambda p: self._cmd(ClearCmd(view))(p))
        self._record({"code", "data"}, [(lo.getOffset(), hi.getOffset())])
        return {}

    def _function(self, entry):
        prog = self.need()
        f = prog.getFunctionManager().getFunctionAt(self.addr(entry))
        if f is None:
            raise RpcError(NOT_FOUND, "no function at %s" % entry)
        return prog, f

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

    def _high_edit(self, tx_name, entry, name, fn):
        """rename_variable / retype_variable. Decided: the whole thing runs on thread R with a short-lived DecompInterface
        (not a pool worker). The HighFunction is only valid for the program state it was decompiled from; every write
        also runs on R, so no edit can slip between the decompile and the commit. Cost: R is blocked for one decompile.
        shortcut: fixed 30 s decompile timeout on R and not cancellable, upgrade with a cancel path if huge functions bite."""
        from ghidra.app.decompiler import DecompInterface
        from ghidra.pyghidra import PyGhidraTaskMonitor
        text_arg(name, "name")
        prog, func = self._function(entry)
        d = DecompInterface()
        try:
            if not d.openProgram(prog):
                raise RpcError(INTERNAL, "decompiler failed to open program: %s" % d.getLastMessage())
            res = d.decompileFunction(func, 30, PyGhidraTaskMonitor(None, None))
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

    def rename_variable(self, entry, name, newName):
        from ghidra.program.model.pcode import HighFunctionDBUtil
        from ghidra.program.model.symbol import SourceType
        self._name_arg(newName, "newName")

        def go(prog, func, hf, sym):
            if prog.getSymbolTable().getSymbols(newName, func):
                raise RpcError(INVALID, "name %r already used in this function" % newName)
            if self._needs_full_commit(sym, hf):
                HighFunctionDBUtil.commitParamsToDatabase(hf, False, HighFunctionDBUtil.ReturnCommitOption.NO_COMMIT, func.getSignatureSource())
            HighFunctionDBUtil.updateDBVariable(sym, newName, None, SourceType.USER_DEFINED)
        return self._high_edit("Rename variable in %s", entry, name, go)

    def retype_variable(self, entry, name, dataType):
        from ghidra.program.model.data import DataTypeConflictHandler
        from ghidra.program.model.pcode import HighFunctionDBUtil
        from ghidra.program.model.symbol import SourceType
        from ghidra.util.data import DataTypeParser
        from ghidra.util.data.DataTypeParser import AllowedDataTypes
        text_arg(dataType, "dataType")

        def go(prog, func, hf, sym):
            dtm = prog.getDataTypeManager()
            dt = DataTypeParser(dtm, dtm, None, AllowedDataTypes.FIXED_LENGTH).parse(dataType)
            if dt is None or dt.getLength() <= 0:
                raise RpcError(INVALID, "type %r has no fixed size" % dataType)
            dt = dtm.resolve(dt, DataTypeConflictHandler.DEFAULT_HANDLER)
            if self._needs_full_commit(sym, hf):
                HighFunctionDBUtil.commitParamsToDatabase(hf, func.getSignatureSource() != SourceType.DEFAULT,
                                                          HighFunctionDBUtil.ReturnCommitOption.NO_COMMIT, SourceType.USER_DEFINED)
            HighFunctionDBUtil.updateDBVariable(sym, None, dt, SourceType.USER_DEFINED)
        return self._high_edit("Retype variable in %s", entry, name, go)

    def _undo_redo(self, undo):
        prog = self.need()
        if not (prog.canUndo() if undo else prog.canRedo()):
            raise RpcError(INVALID, "nothing to %s" % ("undo" if undo else "redo"))
        try:
            prog.undo() if undo else prog.redo()
        except Exception as e:  # noqa
            raise RpcError(INTERNAL, "%s failed: %s" % ("undo" if undo else "redo", e))
        prog.flushEvents()  # RESTORED -> program_changed (ranges null) and cache clear
        self.undo_snap = self.undo_state(prog)
        return self.undo_snap

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
                self._dispose(w)
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
                    self.cache[key] = (body.getMinAddress().getOffset(), body.getMaxAddress().getOffset(), out)
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
        fm = prog.getFunctionManager()
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
                    tok["address"] = hx(ma.getOffset())
                if kind in ("variable", "param"):
                    tok["varName"] = s
                if isinstance(t, ClangFuncNameToken):
                    # only tokens that belong to a call op; the function's own name in its signature has no op
                    op = t.getPcodeOp()
                    if op is not None and op.getOpcode() == PcodeOp.CALL:
                        f = fm.getFunctionAt(op.getInput(0).getAddress())
                        if f is not None:
                            tok["targetFunction"] = hx(f.getEntryPoint().getOffset())
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

    def cancel_open(self):
        return {"cancelled": bool(self.opening is not None and self.opening.cancel())}

    R_METHODS = ("list_functions", "listing_info", "listing_rows", "get_function_at", "search_symbols", "xrefs_to",
                 "xrefs_from", "list_strings", "list_data_types", "undo_state", "rename_symbol", "set_comment",
                 "create_function", "set_function_signature", "rename_variable", "retype_variable", "undo", "redo",
                 "define_data", "clear_code", "save")
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
            elif method == "cancel_open":
                result = self.cancel_open(**params)
            elif method == "open_binary":
                result = await self.open_binary(**params)
            elif method in self.P_METHODS:
                if self.opening is not None and method != "list_languages":
                    raise RpcError(BUSY, "open_binary in progress")
                fn = getattr(self, method)
                result = await self.run(lambda: fn(**params))
            elif method == "decompile" or method in self.R_METHODS:
                if self.opening is not None:  # fail fast: never queue behind an open
                    raise RpcError(NO_PROGRAM, "open_binary in progress")
                if method == "decompile":
                    if rid is None or rid in self.dj:
                        raise RpcError(INVALID, "decompile needs a unique request id")
                    job = self.dj[rid] = Job(self.epoch)
                    try:
                        result = await self.run(lambda: self.decompile(job=job, **params), self.djobs)
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

    async def conn(self, ws):
        if self.ws is not None:  # shortcut: newest client wins nothing; second client just rejected
            await ws.close(1013, "one client at a time")
            return
        self.ws = ws
        try:
            async for raw in ws:
                asyncio.create_task(self.handle(ws, raw))
        finally:
            self.ws = None

    def shutdown(self):
        """stdin EOF / SIGTERM. Never exits while a save is running; the close on thread R saves unsaved edits."""
        with self.sd_lock:
            if self.sd_started:
                return
            self.sd_started = True
        if self.opening is not None:
            self.opening.cancel()
        with self.pool_lock:
            for j in list(self.running):  # let running decompiles return so dispose() can reach the native child
                j.cancelled = True
                if j.mon is not None:
                    j.mon.cancel()
        for j in list(self.dj.values()):
            j.cancelled = True

        op = self.opening
        while op is not None and op.saving and not op.finished:
            time.sleep(0.02)  # never exit mid-save: a half-written project file would load as "persisted"
        t0 = time.monotonic()
        f = concurrent.futures.Future()
        self.jobs.put((self._close, f))  # close (and autosave) on thread R, like every other program change
        # R may be busy with a long edit; give up only if it is not saving (Electron's SIGKILL is the backstop)
        while not f.done() and (time.monotonic() - t0 < 45 or self.save_lock.locked()):
            time.sleep(0.02)
        log("shutdown: close finished in %.2fs" % (time.monotonic() - t0))
        os._exit(0)


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
    launcher.add_vmargs("-Djava.awt.headless=true")  # else project code initialises AppKit from a non-main thread and hangs
    launcher.start()
    log("jvm start: %.2fs" % (time.monotonic() - t0))

    sc = Sidecar()

    async def serve():
        sc.loop = asyncio.get_running_loop()
        token = os.environ.get("SIDECAR_TOKEN")  # empty only with SIDECAR_ALLOW_NO_AUTH=1 (checked in main)

        def guard(conn, request):  # a web page can reach 127.0.0.1; require the secret URL path set by Electron main
            if token and request.path != "/" + token:
                return conn.respond(403, "forbidden\n")

        async with websockets.serve(sc.conn, "127.0.0.1", 0, max_size=None, process_request=guard) as srv:
            port = srv.sockets[0].getsockname()[1]
            print(port, file=out, flush=True)
            await asyncio.Future()

    def watch_stdin():
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except Exception:
            pass
        sc.shutdown()

    threading.Thread(target=watch_stdin, daemon=True).start()
    for _sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(_sig, lambda *_: threading.Thread(target=sc.shutdown, daemon=True).start())
    asyncio.run(serve())


if __name__ == "__main__":
    main()

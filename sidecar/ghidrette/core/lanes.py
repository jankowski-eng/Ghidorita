"""The thread runtime: which work runs where. Ownership (the architecture doc has the picture):

  asyncio loop  dispatch, cancel_* (they only flip flags), reply delivery
  R             `jobs` queue, one thread: ALL program reads that are not slow, and ALL writes (edits, undo/redo, save, close)
  S (scan)      `sjobs` queue, SIDECAR_SCAN_WORKERS threads: symbol table, strings, memory search, variable-edit preparation. Never run on R, so a long scan
                cannot delay listing fetches
  D (decomp)    `djobs` queue, SIDECAR_DECOMP_WORKERS threads, each owns one DecompInterface (created, used and disposed on that thread)
  O             one thread per open_binary (import + analysis + save); started by the open lane, at most one at a time (`opening`)

Locks: session.lock guards the program swap (program/epoch) together with `running` and `active`; mon_lock guards Job/Scan monitor
hand-over; the per-domain locks are documented where they are declared.
"""
import concurrent.futures, contextlib, os, queue, threading

from .errors import BUSY, CANCELLED, NO_PROGRAM, RpcError


class Job:
    """A decompile request (loop thread creates it, a pool worker runs it)."""
    def __init__(self, epoch):
        self.cancelled, self.mon, self.epoch = False, None, epoch

    def cancel(self):
        self.cancelled = True
        if self.mon is not None:
            self.mon.cancel()


class Scan:
    """A slow read (list_symbols, list_strings, search_*, search_memory): created by the loop thread, run by a scan worker, cancellable by request id."""
    def __init__(self, epoch):
        self.cancelled, self.mon, self.epoch = False, None, epoch

    def monitor(self):
        """A Ghidra TaskMonitor that cancel() cancels, for loops that run inside Java (core/jscans.py)."""
        from ghidra.pyghidra import PyGhidraTaskMonitor
        mon = PyGhidraTaskMonitor(None, None)
        self.mon = mon
        if self.cancelled:
            mon.cancel()
        return mon

    def java(self, fn, *args):
        """Runs a GhidretteScans call (GIL released while it runs); a cancelled monitor surfaces as the Cancelled error."""
        import jpype
        try:
            return fn(*args, self.monitor())
        except jpype.JException as e:
            if str(e.getClass().getSimpleName()) == "CancelledException":
                raise RpcError(CANCELLED, "cancelled")
            raise

    def cancel(self):
        self.cancelled = True
        if self.mon is not None:
            self.mon.cancel()

    def check(self):
        if self.cancelled:
            raise RpcError(CANCELLED, "cancelled")


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


class Lanes:
    def __init__(self, ctx):
        self.ctx = ctx
        self.jobs = queue.Queue(maxsize=128)   # thread R: reads, edits, undo/redo
        self.djobs = queue.Queue(maxsize=128)  # decompiler pool, one shared queue
        self.sjobs = queue.Queue(maxsize=128)  # scan workers, one shared queue
        self.workers = []
        self.running = set()         # decompile Jobs currently inside a worker; session.lock
        self.active = set()          # Scans currently running; session.lock
        self.mon_lock = threading.Lock()
        self.dj = {}                 # request id -> Job, loop thread only
        self.sj = {}                 # request id -> Scan, loop thread only
        self.opening = None          # Opening, loop thread only
        self.tl = threading.local()

    def start(self):
        threading.Thread(target=self._worker, args=(self.jobs,), daemon=True).start()
        for _ in range(max(1, int(os.environ.get("SIDECAR_SCAN_WORKERS", "2")))):
            threading.Thread(target=self._worker, args=(self.sjobs,), daemon=True).start()
        for _ in range(max(1, int(os.environ.get("SIDECAR_DECOMP_WORKERS", "2")))):
            w = Worker()
            self.workers.append(w)
            threading.Thread(target=self._pool_worker, args=(w,), daemon=True).start()

    def worker(self):
        """The pool Worker of the calling thread (decompiler threads only)."""
        return self.tl.w

    def _worker(self, q):
        while True:
            fn, fut = q.get()
            if fut.cancelled():
                continue
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
            if w.decomp is not None and w.epoch != self.ctx.session.epoch:
                self.dispose(w)
            if item is None:
                continue
            fn, fut = item
            if fut.cancelled():
                continue
            try:
                res, exc = fn(), None
            except BaseException as e:  # noqa
                res, exc = None, e
            self._deliver(fut, res, exc)

    @staticmethod
    def dispose(w):
        d, w.decomp = w.decomp, None
        if d is not None:
            try:
                d.dispose()
            except Exception:
                pass

    @staticmethod
    def settle(fut, res, exc):
        if not fut.done():
            fut.set_exception(exc) if exc else fut.set_result(res)

    def _deliver(self, fut, res, exc):
        if isinstance(fut, concurrent.futures.Future):  # waited on by a thread, not the loop
            self.settle(fut, res, exc)
        else:
            self.ctx.loop.call_soon_threadsafe(self.settle, fut, res, exc)

    def run(self, fn, q=None):
        fut = self.ctx.loop.create_future()
        try:
            (q or self.jobs).put_nowait((fn, fut))
        except queue.Full:
            raise RpcError(BUSY, "worker queue full")
        return fut

    def on_r(self, fn):
        """Blocking call from another thread (O, shutdown): run fn on thread R, after everything queued before it."""
        f = concurrent.futures.Future()
        self.jobs.put((fn, f))
        return f.result()

    def cancel(self, job):
        """Cancel a Job (queued or running): the flag, and the monitor of the decompile inside, if any."""
        with self.mon_lock:
            job.cancelled = True
            if job.mon is not None:
                job.mon.cancel()

    # ---- slow reads: scan workers (thread S). They never run on R, so a long scan cannot delay listing fetches. ----
    @contextlib.contextmanager
    def scanning(self, scan):
        ses = self.ctx.session
        with ses.lock:
            prog = ses.program
            if scan.cancelled or scan.epoch != ses.epoch:  # cancelled while queued, or the program was closed/swapped meanwhile
                raise RpcError(CANCELLED, "cancelled")
            if prog is None:
                raise RpcError(NO_PROGRAM, "no program open")
            self.active.add(scan)
        try:
            yield prog
        finally:
            with ses.lock:
                self.active.discard(scan)

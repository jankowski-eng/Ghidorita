"""Analysis of the open program: runs Ghidra's AutoAnalysisManager on its own thread (lane A), so listing reads, decompiles and scans
on R, D and S keep working while it runs. The rules this follows are in protocol.md "Analysis" and SPIKE_REPORT.md "Round 7":

- the whole analysis is ONE Ghidra transaction; a second transaction would join it, so edits/undo/redo are Busy while it runs
  (`ses.analyzing`, checked in Session.edit and the undo/redo RPCs) and the analysis never lands on the undo stack;
- the monitor is a plain Java monitor (BasicTaskMonitor) that a Python thread polls: PyGhidraTaskMonitor calls into Python on every
  setProgress, which doubled a first open (Create Address Tables 18.8 s instead of 0.3 s, SPIKE_REPORT Round 7);
- this thread never waits for R (close() on R waits for this thread), and it saves the program itself while edits are still Busy.
"""
import threading, time

from ..core.errors import BUSY, INVALID, NO_PROGRAM, RpcError, log
from ..core.events import ALL_KINDS
from ..core.rpc import rpc
from .project import FAST_PROFILE

POLL_SECS = 0.05     # how often the monitor is read
NOTIFY_SECS = 0.25   # at most one analysis_state / progress event per this, when something changed
STOP_SECS = 60       # close/save/shutdown wait this long for the analysis to react to cancel; shortcut: a decompile that ignores cancel can exceed it, then close fails Internal (strict) or leaks the program (shutdown)


def idle(analysis="none", profile="full"):
    return {"state": "idle", "analysis": analysis, "profile": profile, "analyzer": "", "done": 0, "pct": -1}


def new_monitor():
    """Ghidra's own BasicTaskMonitor (stores message/progress/max, cancellable, no callbacks). It is package-private, hence reflection;
    shortcut: its fields are not volatile (Ghidra's TaskRunner uses it the same way); upgrade: a small Java class if that ever bites."""
    from jpype import JClass, JObject
    c = JClass("java.lang.Class").forName("ghidra.util.task.BasicTaskMonitor", True, JClass("java.lang.ClassLoader").getSystemClassLoader())
    k = c.getDeclaredConstructor()
    k.setAccessible(True)
    return JObject(k.newInstance(), JClass("ghidra.util.task.TaskMonitor"))


def configure(prog, disabled, enabled=()):
    """Analyzer on/off switches (exact analyzer names, they are the program's analysis options). Unknown names are logged and ignored."""
    from ghidra.program.model.listing import Program
    opts = prog.getOptions(Program.ANALYSIS_PROPERTIES)
    for names, value in ((disabled, False), (enabled, True)):
        for n in names:
            if opts.contains(n):
                opts.setBoolean(n, value)
            else:
                log("unknown analyzer: %r" % n)
    if disabled:
        log("analyzers disabled: %s" % list(disabled))


def execute(prog, mon, disabled, upgrade=False):
    """Run the analysis on the calling thread inside the caller's transaction. upgrade: a finished fast program gets only the analyzers
    fast skipped (Ghidra's one-shot analysis over the whole program); otherwise everything is queued (Ghidra's re-analyze command,
    which also resumes an interrupted run: finished regions are cheap, not free; shortcut: the analyzer queue is not persisted)."""
    from ghidra.app.plugin.core.analysis import AutoAnalysisManager
    from ghidra.app.services import Analyzer
    from ghidra.program.util import GhidraProgramUtilities
    from ghidra.util.classfinder import ClassSearcher
    mgr = AutoAnalysisManager.getAnalysisManager(prog)
    prev = mgr.setIgnoreChanges(False)  # analyzers must see each other's changes; _publish switched it off for the idle program
    try:
        if upgrade:
            configure(prog, [], FAST_PROFILE)
            mgr.initializeOptions()
            whole = prog.getMemory().getLoadedAndInitializedAddressSet()
            for a in ClassSearcher.getInstances(Analyzer):
                if str(a.getName()) in FAST_PROFILE:
                    mgr.scheduleOneTimeAnalysis(a, whole)
        else:
            configure(prog, disabled, [n for n in FAST_PROFILE if n not in disabled])
            mgr.initializeOptions()
            mgr.reAnalyzeAll(None)
        mgr.startAnalysis(mon)  # blocks this thread; cancelling the monitor stops it at the next check
        log("analysis task times (cancelled=%s):\n%s" % (mon.isCancelled(), mgr.getTaskTimesString()))
        if not mon.isCancelled():
            GhidraProgramUtilities.markProgramAnalyzed(prog)
    finally:
        mgr.setIgnoreChanges(prev)


class Poller:
    """Reads a TaskMonitorAdapter every POLL_SECS on its own thread and reports (analyzer, done, pct, message) to sink at most every
    NOTIFY_SECS when something changed. done = analyzer starts seen (a poll can miss an analyzer that runs shorter than POLL_SECS)."""
    def __init__(self, mon, sink):
        from ghidra.app.services import Analyzer
        from ghidra.util.classfinder import ClassSearcher
        self.mon, self.sink = mon, sink
        self.names = {str(a.getName()) for a in ClassSearcher.getInstances(Analyzer)}
        self.stop_ev = threading.Event()
        self.cur, self.done, self.last, self.sent = "", 0, None, 0.0
        self.t = threading.Thread(target=self._loop, daemon=True, name="analysis-poll")
        self.t.start()

    def _loop(self):
        while not self.stop_ev.wait(POLL_SECS):
            try:
                self._poll()
            except Exception:  # noqa
                pass

    def _poll(self):
        msg, p, mx = str(self.mon.getMessage() or ""), int(self.mon.getProgress()), int(self.mon.getMaximum())
        if msg in self.names and msg != self.cur:
            self.cur, self.done = msg, self.done + 1
        pct = min(100, p * 100 // mx) if mx > 0 and p > 0 else -1
        key = (self.cur, self.done, pct, msg)
        now = time.monotonic()
        if key != self.last and now - self.sent >= NOTIFY_SECS:
            self.last, self.sent = key, now
            self.sink(self.cur, max(0, self.done - 1), pct, msg)

    def stop(self):
        self.stop_ev.set()
        self.t.join(2)


class Analysis:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session
        self.lock = threading.Lock()  # st, mon
        self.st = idle()
        self.mon = None
        self.ended = threading.Event()
        self.ended.set()

    # ---- state ----
    def _publish(self, **kw):
        with self.lock:
            self.st = st = {**self.st, **kw}
        self.ctx.notify("analysis_state", {"sessionId": self.ses.session_id, **st})

    def state(self):
        with self.lock:
            return dict(self.st)

    @property
    def running(self):
        return self.st["state"] == "running"

    def reset(self, analysis, profile):
        """A program was published: the state of the one just opened (thread O / R)."""
        with self.lock:
            self.st = idle(analysis, profile)

    # ---- RPCs ----
    @rpc(lane="loop")
    def analysis_status(self):
        if self.ses.program is None:
            raise RpcError(NO_PROGRAM, "no program open")
        return self.state()

    @rpc(lane="loop")
    def cancel_analysis(self):
        with self.lock:
            mon, running = self.mon, self.st["state"] == "running"
        if running and mon is not None:
            mon.cancel()
        return {"cancelled": bool(running and mon is not None)}

    @rpc(lane="R")
    def start_analysis(self, profile=None):
        prog = self.ses.need()
        if profile not in (None, "full", "fast"):
            raise RpcError(INVALID, "bad profile %r" % (profile,))
        if self.running:
            raise RpcError(BUSY, "analysis already running")
        rec = self.ctx.project.meta_get(self.ses.program_id)
        have, prof = rec.get("analysis", "done"), rec.get("analysisProfile", "full")
        if have == "done":
            if profile in (None, "fast") or prof == "full":
                return self.state()  # already analyzed at least that well
            return self.start(prog, self.ses.program_id, [], "full", upgrade=True)
        want = "full" if "full" in (profile, prof) else "fast"  # never downgrade the recorded profile of a partial full analysis
        return self.start(prog, self.ses.program_id, FAST_PROFILE if want == "fast" else [], want)

    # ---- running ----
    def start(self, prog, key, disabled, profile, upgrade=False):
        """Spawn the analysis thread for the published program (any thread; flips the flags first so no edit slips in). Returns the state."""
        with self.lock:
            if self.st["state"] == "running":
                raise RpcError(BUSY, "analysis already running")
            mon = self.mon = new_monitor()
            self.ended.clear()
            self.st = {"state": "running", "analysis": "partial", "profile": profile, "analyzer": "", "done": 0, "pct": -1}
        self.ses.analyzing = True
        self.ctx.events.bulk = True
        self.ctx.project.meta_update(key, analysis="partial", analysisProfile=profile, analyzed=False)
        threading.Thread(target=self._run, args=(prog, key, self.ses.epoch, mon, disabled, profile, upgrade), daemon=True, name="analysis").start()
        st = self.state()
        self.ctx.notify("analysis_state", {"sessionId": self.ses.session_id, **st})
        return st

    def _run(self, prog, key, epoch, mon, disabled, profile, upgrade):
        from ghidra.app.script import GhidraScriptUtil
        from ghidra.util.task import TaskMonitor
        err, poller = None, None
        t0 = time.monotonic()
        try:
            poller = Poller(mon, lambda an, done, pct, msg: self._publish(analyzer=an, done=done, pct=pct))
            GhidraScriptUtil.acquireBundleHostReference()
            try:
                tx = prog.startTransaction("Analysis")
                try:
                    execute(prog, mon, disabled, upgrade)
                finally:
                    prog.endTransaction(tx, True)  # keeps what was found, also after cancel or failure (like Ghidra's BackgroundCommandTask)
            finally:
                GhidraScriptUtil.releaseBundleHostReference()
        except BaseException as e:  # noqa
            err = e
            log("analysis failed:", repr(e))
        finally:
            if poller is not None:
                poller.stop()
        completed = err is None and not mon.isCancelled()
        try:
            prog.clearUndo()  # the analysis is not undoable (Ghidra's GUI cannot undo it while it runs either)
            if self.ses.program is prog:  # close() waits for this thread, so normally always true; saving needs edits to stay Busy
                with self.ses.save_lock:
                    prog.getDomainFile().save(TaskMonitor.DUMMY)
                self.ses.refresh_undo(prog)
        except Exception as e:  # noqa
            log("analysis save failed:", repr(e))
            err, completed = err or e, False  # unsaved: not done
        finally:  # whatever failed above, edits become possible again and stop() is released
            try:
                self.ctx.project.meta_update(key, analysis="done" if completed else "partial", analysisProfile=profile, analyzed=completed)
            except Exception as e:  # noqa
                log("analysis meta update failed:", repr(e))
            log("analysis %s in %.1fs" % ("done" if completed else "cancelled" if err is None else "failed", time.monotonic() - t0))
            self.ses.analyzing = False
            self.ctx.events.bulk = False
            try:
                self.ctx.events.record(set(ALL_KINDS), None)  # one last refresh of everything the client shows
                self._publish(state="done" if completed else "failed" if err is not None else "cancelled", analysis="done" if completed else "partial",
                              analyzer="", pct=100 if completed else -1, **({"error": str(err)} if err is not None else {}))
            finally:
                self.ended.set()

    def stop(self, timeout=STOP_SECS):
        """Cancel a running analysis and wait until its thread is gone and has saved (close, save, shutdown; thread R). False = still running."""
        with self.lock:
            mon = self.mon
        if mon is not None and not self.ended.is_set():
            mon.cancel()
        return self.ended.wait(timeout)

"""The Ghidra project: one project for all programs (named by programId), programs.json metadata, the program browser RPCs and the
persistence key (protocol.md "Persistence"). `lock` serializes thread O (a whole open) against thread R users (list/delete/candidates).
ctx.project is this object: the program domain opens programs through it."""
import datetime, hashlib, json, os, re, threading

from ..core.args import text_arg
from ..core.errors import BUSY, NOT_FOUND, PROJECT_LOCKED, RpcError, log
from ..core.rpc import rpc

# analysis profiles (open_binary `profile`): "fast" switches these off for the first-open analysis (measured in SPIKE_REPORT round 4)
FAST_PROFILE = ["Call Convention ID", "Decompiler Switch Analysis", "Stack"]
RAW = "Raw Binary"  # BinaryLoader.BINARY_NAME: the only stock loader with a base address option ("-loader-baseAddr")
KEY_RE = re.compile(r"^[0-9a-f]{64}(-[0-9a-f]{12})?$")


def analysis_disabled():
    """Analyzer names from SIDECAR_ANALYSIS_DISABLE ("Name 1;Name 2"), empty if unset."""
    return [n for n in os.environ.get("SIDECAR_ANALYSIS_DISABLE", "").split(";") if n]


def program_key(sha, opts, disabled=None):
    """protocol.md "Persistence key". disabled = analyzer names switched off (default: SIDECAR_ANALYSIS_DISABLE)."""
    disabled = analysis_disabled() if disabled is None else disabled
    if not any(k in opts for k in ("loader", "language", "compilerSpec", "baseAddress")) and not disabled:
        return sha
    c = {k: opts.get(k) for k in ("loader", "language", "compilerSpec", "baseAddress")}
    if disabled:  # a reduced analysis never shares a key with a full one
        c["analysisDisable"] = sorted(disabled)
    canon = json.dumps(c, separators=(",", ":"))
    return sha + "-" + hashlib.sha256(canon.encode()).hexdigest()[:12]


class Project:
    def __init__(self, ctx):
        self.ctx, self.ses = ctx, ctx.session
        self.proj = self.gp = None
        self.lock = threading.Lock()  # held by thread O for a whole open, briefly by R for list/delete/candidates: never concurrent

    @staticmethod
    def _projects_dir():
        return os.environ.get("SIDECAR_PROJECTS_DIR") or os.path.expanduser("~/Library/Application Support/ghidra-desktop-spike/projects")

    def ghidra_project(self):
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

    def close(self):
        """Shutdown only (thread R, after _close): release the project so Ghidra removes its lock files."""
        if not self.lock.acquire(timeout=30):  # an open that does not stop: leave the project to the OS, Ghidra detects the stale lock
            log("project still in use by an open, not closing it")
            return
        try:
            gp, self.gp, self.proj = self.gp, None, None
            if gp is not None:
                gp.close()
        except Exception as e:  # noqa
            log("project close failed:", repr(e))
        finally:
            self.lock.release()

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

    def meta_touch(self, key, **fields):
        meta = self._meta_load()
        e = meta.setdefault(key, {})
        e.update(fields, lastOpened=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self._meta_save(meta)

    class _ProjGuard:
        """Non-blocking proj_lock for R-side project users: Busy while an open runs."""
        def __init__(self, sc):
            self.sc = sc

        def __enter__(self):
            if self.sc.ctx.lanes.opening is not None or not self.sc.lock.acquire(blocking=False):
                raise RpcError(BUSY, "open_binary in progress")

        def __exit__(self, *a):
            self.sc.lock.release()

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
            for f in self.ghidra_project().getProjectData().getRootFolder().getFiles():
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
            if programId == self.ses.program_id:
                raise RpcError(BUSY, "program is open")
            f = self.ghidra_project().getProjectData().getFile("/" + programId) if KEY_RE.match(programId) else None
            if f is None:
                raise RpcError(NOT_FOUND, "no such program: %s" % programId)
            f.delete()
            meta = self._meta_load()
            if meta.pop(programId, None) is not None:
                self._meta_save(meta)
        return {}

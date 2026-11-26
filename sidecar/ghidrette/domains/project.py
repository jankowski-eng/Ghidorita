"""The Ghidra project: one project for all programs (named by programId), programs.json metadata, the program browser RPCs and the
persistence key (protocol.md "Persistence"). `lock` serializes thread O (a whole open) against thread R users (list/delete/candidates).
ctx.project is this object: the program domain opens programs through it."""
import datetime, hashlib, json, os, re, threading

from ..core.args import text_arg
from ..core.errors import BUSY, NOT_FOUND, PROJECT_LOCKED, RpcError, log
from ..core.rpc import rpc
from .layout import file_layout, shannon

# analysis profiles (open_binary `profile`): "fast" switches these off for the first-open analysis (measured in SPIKE_REPORT round 4)
FAST_PROFILE = ["Call Convention ID", "Decompiler Switch Analysis", "Stack"]
RAW = "Raw Binary"  # BinaryLoader.BINARY_NAME: the only stock loader with a base address option ("-loader-baseAddr")
KEY_RE = re.compile(r"^[0-9a-f]{64}(-[0-9a-f]{12})?$")


def entropy_profile(path, size, buckets=48, sample=16384):
    """Shannon entropy (bits/byte, 0-8) of up to `buckets` evenly spaced slices of the file, `sample` bytes read from the start of each:
    constant cost whatever the file size. shortcut: sampled, so a short packed stretch can hide inside a slice; upgrade to a full pass if triage must be exact."""
    n, out = max(1, min(buckets, -(-size // 4096))), []
    with open(path, "rb") as f:
        for i in range(n):
            f.seek(size * i // n)
            b = f.read(min(sample, max(1, size // n)))  # never past this slice
            out.append(shannon(b))
    return out


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
        self.meta_lock = threading.Lock()  # programs.json is read-modified-written by O, R and the analysis thread
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
            raise RuntimeError("project still in use by an open; close did not finish")
        try:
            gp, self.gp, self.proj = self.gp, None, None
            if gp is not None:
                gp.close()
        except Exception as e:  # noqa
            log("project close failed:", repr(e))
            raise
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
        self.meta_update(key, lastOpened=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **fields)

    def meta_update(self, key, **fields):
        with self.meta_lock:
            meta = self._meta_load()
            meta.setdefault(key, {}).update(fields)
            self._meta_save(meta)

    def meta_get(self, key):
        with self.meta_lock:
            return dict(self._meta_load().get(key, {}))

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
    def import_candidates(self, path, *, _versioned=False):
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
                ent = entropy_profile(path, size)
                choices = {"sizeBytes": size, "entropy": ent, "layout": file_layout(path),
                           "profiles": [{"id": "full", "label": "Full"},
                                        {"id": "fast", "label": "Fast (skips switch analysis, call-convention ID, stack)"}],
                           "defaultProfile": "fast" if size > 20 * 1048576 else "full"}
                if chosen is None:  # only Raw Binary (always offered, needs a language) applies: "nothing recognises the file"
                    raw = {"loader": RAW, "language": None, "compilerSpec": None, "preferred": True, "acceptsBaseAddress": True}
                    return {**choices, "candidates": [raw] if _versioned else [],
                            "note": "No loader recognises this file. You can import it as a Raw Binary."}
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
                return {**choices, "candidates": out}
            finally:
                p.close()

    @rpc(lane="project")
    def list_programs(self):
        with self._ProjGuard(self):
            with self.meta_lock:
                meta = self._meta_load()
            out = []
            for f in self.ghidra_project().getProjectData().getRootFolder().getFiles():
                key = str(f.getName())
                m = meta.get(key, {})
                an = m.get("analysis") or ("done" if m.get("analyzed", True) else "none")  # a program from before round 7 has only `analyzed`
                e = {"programId": key, "name": m.get("name", key), "sizeBytes": m.get("sizeBytes", 0), "analyzed": an == "done",
                     "analysis": an, "analysisProfile": m.get("analysisProfile") or m.get("options", {}).get("profile", "full"),
                     "options": m.get("options", {})}
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
            with self.meta_lock:
                meta = self._meta_load()
                if meta.pop(programId, None) is not None:
                    self._meta_save(meta)
        return {}

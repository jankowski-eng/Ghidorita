#!/usr/bin/env python3
"""Ghidra sidecar: JSON-RPC 2.0 over WebSocket (see ../protocol.md)."""
import asyncio, concurrent.futures, hashlib, json, os, queue, signal, sys, tempfile, threading, time
from collections import OrderedDict

import websockets

NO_PROGRAM, CANCELLED, TIMEOUT, NOT_FOUND, INTERNAL, NO_METHOD = -32001, -32002, -32003, -32004, -32603, -32601
KINDS = {0: "keyword", 1: "comment", 2: "type", 3: "function", 4: "variable", 5: "const",
         6: "param", 7: "variable", 8: "default", 9: "default", 10: "default"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def hx(off):
    return "0x%x" % off


class Job:
    def __init__(self):
        self.cancelled, self.mon = False, None


class Sidecar:
    def __init__(self):
        self.loop = None
        self.ws = None
        self.jobs = queue.Queue()    # open_binary, listing, function list: never waits behind a decompile
        self.djobs = queue.Queue()   # decompile thread: owns self.decomp and self.cache
        self.program = None
        self.results = None
        self.consumer = None
        self.decomp = None
        self.cache = OrderedDict()  # decompile thread only; shortcut: not invalidated (program is read-only after analysis), fine until editing is added
        self.dj = {}                # request id -> Job, loop thread only
        self.mon_lock = threading.Lock()
        for q in (self.jobs, self.djobs):
            threading.Thread(target=self._worker, args=(q,), daemon=True).start()

    # ---- worker plumbing ----
    def _worker(self, q):
        while True:
            fn, fut = q.get()
            try:
                res, exc = fn(), None
            except BaseException as e:  # noqa
                res, exc = None, e
            self._deliver(fut, res, exc)

    @staticmethod
    def _settle(fut, res, exc):
        if not fut.done():
            fut.set_exception(exc) if exc else fut.set_result(res)

    def _deliver(self, fut, res, exc):
        if isinstance(fut, concurrent.futures.Future):  # waited on by a worker thread, not the loop
            self._settle(fut, res, exc)
        else:
            self.loop.call_soon_threadsafe(self._settle, fut, res, exc)

    def run(self, fn, q=None):
        fut = self.loop.create_future()
        (q or self.jobs).put((fn, fut))
        return fut

    def on_decomp_thread(self, fn):
        """Blocking call from the read thread: run fn on the decompile thread (serialises decomp/cache changes)."""
        f = concurrent.futures.Future()
        self.djobs.put((fn, f))  # _worker only calls loop.call_soon_threadsafe(_settle,..); see _settle
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

    def progress(self, phase, pct, message=""):
        self.notify("progress", {"phase": phase, "pct": pct, "message": message})

    # ---- helpers (worker thread only) ----
    def need(self):
        if self.program is None:
            raise RpcError(NO_PROGRAM, "no program open")
        return self.program

    def addr(self, s):
        try:
            off = int(s, 16)
        except Exception:
            raise RpcError(NOT_FOUND, "bad address %r" % (s,))
        # shortcut: single default address space only, upgrade when segmented/overlay binaries matter
        return self.program.getAddressFactory().getDefaultAddressSpace().getAddress(off)

    def monitor(self, phase, scale_msg=True):
        from ghidra.pyghidra import PyGhidraTaskMonitor
        last = [0.0, None]

        def cb(msg, prog, mx):
            now = time.monotonic()
            pct = int(prog * 100 / mx) if (phase == "import" and mx and mx > 0) else -1
            if now - last[0] < 0.1 and pct == last[1]:
                return
            last[0], last[1] = now, pct
            self.progress(phase, pct, str(msg or ""))
        return PyGhidraTaskMonitor(None, cb)

    # ---- methods (worker) ----
    def _project(self):
        """One Ghidra project for all programs, programs named by file sha256.
        shortcut: a second sidecar on the same projects dir fails on the project lock; one process per dir."""
        if getattr(self, "proj", None) is None:
            from ghidra.base.project import GhidraProject
            from ghidra.framework.model import ProjectLocator
            d = os.environ.get("SIDECAR_PROJECTS_DIR") or os.path.expanduser("~/Library/Application Support/ghidra-desktop-spike/projects")
            os.makedirs(d, exist_ok=True)
            # GhidraProject, not pyghidra.open_project: that one builds a GUI-oriented DefaultProjectManager which hangs headless here
            gp = (GhidraProject.openProject(d, "spike", True) if ProjectLocator(d, "spike").exists()
                  else GhidraProject.createProject(d, "spike", False))
            self.proj = gp.getProject()
        return self.proj

    def _close_program(self):
        if self.results is not None:
            self.results.close()
        elif self.program is not None:
            self.program.release(self.consumer)
        self.program = self.results = None

    def open_binary(self, path):
        import pyghidra
        from ghidra.app.util.importer import ProgramLoader
        from ghidra.program.util import GhidraProgramUtilities
        self.on_decomp_thread(self._drop_decomp)
        self._close_program()
        if not os.path.isfile(path):
            raise RpcError(NOT_FOUND, "no such file: %s" % path)
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        key = h.hexdigest()
        proj = self._project()
        t0 = time.monotonic()
        persisted = proj.getProjectData().getFile("/" + key) is not None
        if persisted:
            self.progress("import", 100, "loading persisted analysis")
            prog, self.consumer = pyghidra.consume_program(proj, "/" + key)
            log("reopened persisted program in %.2fs" % (time.monotonic() - t0))
        else:
            self.progress("import", 0, "importing")
            self.consumer = None
            try:
                res = (ProgramLoader.builder().source(path).project(proj).projectFolderPath("/").name(key)
                       .monitor(self.monitor("import")).load())
            except Exception as e:
                raise RpcError(INTERNAL, "import failed: %s" % e)
            self.results = res
            prog = res.getPrimaryDomainObject()
            res.save(self.monitor("import"))  # creates the domain file in the project
            self.progress("import", 100, "imported")
        self.program = prog
        if not GhidraProgramUtilities.isAnalyzed(prog):
            self.progress("analysis", -1, "analyzing")
            pyghidra.analyze(prog, self.monitor("analysis"))
            self.progress("analysis", -1, "saving")
            prog.save("analyzed", self.monitor("analysis"))
            # shortcut: a cancelled/crashed analysis leaves an unanalyzed (or half-analyzed, not saved) program; it is re-analyzed on next open
        self.on_decomp_thread(lambda: self._open_decomp(prog))
        self.progress("ready", 100, "ready")
        self.open_secs = time.monotonic() - t0
        return {"programId": key, "name": os.path.basename(path), "persisted": persisted}

    def _drop_decomp(self):
        if self.decomp is not None:
            self.decomp.dispose()
            self.decomp = None
        self.cache.clear()

    def _open_decomp(self, prog):
        from ghidra.app.decompiler import DecompInterface
        d = DecompInterface()
        if not d.openProgram(prog):
            raise RpcError(INTERNAL, "decompiler failed to open program: %s" % d.getLastMessage())
        self.decomp = d

    def list_functions(self):
        out = []
        for f in self.need().getFunctionManager().getFunctions(True):
            if f.isExternal():
                continue
            out.append((f.getEntryPoint().getOffset(), str(f.getName()), f.getBody().getNumAddresses()))
        out.sort()
        return [{"name": n, "entry": hx(o), "size": int(s)} for o, n, s in out]

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

    def decompile(self, entry, timeoutSecs=30, job=None):
        from ghidra.pyghidra import PyGhidraTaskMonitor
        prog = self.need()
        if job is not None and job.cancelled:  # cancelled while queued
            raise RpcError(CANCELLED, "decompile cancelled")
        a = self.addr(entry)
        func = prog.getFunctionManager().getFunctionAt(a)
        if func is None:
            raise RpcError(NOT_FOUND, "no function at %s" % entry)
        key = a.getOffset()
        if key in self.cache:
            self.cache.move_to_end(key)
            r = dict(self.cache[key])
            r["cached"] = True
            return r
        mon = PyGhidraTaskMonitor(None, None)
        if job is not None:
            with self.mon_lock:
                job.mon = mon
                if job.cancelled:
                    mon.cancel()
        res = self.decomp.decompileFunction(func, int(timeoutSecs), mon)
        if res.isCancelled() or mon.isCancelled():
            raise RpcError(CANCELLED, "decompile cancelled")
        if res.isTimedOut():
            raise RpcError(TIMEOUT, "decompile timed out after %ss" % timeoutSecs)
        if not res.decompileCompleted():
            raise RpcError(INTERNAL, "decompile failed: %s" % res.getErrorMessage())
        out = self._tokens(prog, res)
        self.cache[key] = out
        if len(self.cache) > 256:
            self.cache.popitem(last=False)
        return {**out, "cached": False}

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

    async def handle(self, ws, raw):
        try:
            msg = json.loads(raw)
            rid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        except Exception:
            return
        try:
            if method == "cancel_decompile":
                result = self.cancel_decompile(**params)
            elif method == "decompile":
                job = self.dj[rid] = Job()
                try:
                    result = await self.run(lambda: self.decompile(job=job, **params), self.djobs)
                finally:
                    self.dj.pop(rid, None)
            elif method in ("open_binary", "list_functions", "listing_info", "listing_rows"):
                fn = getattr(self, method)
                result = await self.run(lambda: fn(**params))
            else:
                raise RpcError(NO_METHOD, "method not found: %s" % method)
            reply = {"jsonrpc": "2.0", "id": rid, "result": result}
        except RpcError as e:
            reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": e.code, "message": str(e)}}
        except TypeError as e:
            reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": "invalid params: %s" % e}}
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
        for job in list(self.dj.values()):  # let running decompiles return so dispose() can reach the native child
            job.cancelled = True
            if job.mon is not None:
                job.mon.cancel()

        def d():
            try:
                self.on_decomp_thread(self._drop_decomp)  # dispose on the thread that owns it
            except Exception:
                pass
        t = threading.Thread(target=d, daemon=True)
        t.start()
        t.join(2.5)  # a stuck decompile must not block exit (Electron SIGKILLs at 3 s)
        os._exit(0)


def main():
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
        token = os.environ.get("SIDECAR_TOKEN")  # shortcut: no token => no auth (tests only), make mandatory before shipping

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
    signal.signal(signal.SIGTERM, lambda *_: sc.shutdown())
    asyncio.run(serve())


if __name__ == "__main__":
    main()

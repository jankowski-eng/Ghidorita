#!/usr/bin/env python3
"""Ghidra sidecar: JSON-RPC 2.0 over WebSocket (see ../protocol.md)."""
import asyncio, bisect, json, os, queue, signal, sys, tempfile, threading, time
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


class Sidecar:
    def __init__(self):
        self.loop = None
        self.ws = None
        self.jobs = queue.Queue()
        self.program = None
        self.results = None
        self.decomp = None
        self.cache = OrderedDict()  # shortcut: cache not invalidated (program is read-only after analysis), fine until editing is added
        self.index = []  # sorted code unit start offsets
        self.cur_monitor = None
        self.mon_lock = threading.Lock()
        threading.Thread(target=self._worker, daemon=True).start()

    # ---- worker plumbing ----
    def _worker(self):
        while True:
            fn, fut = self.jobs.get()
            try:
                res, exc = fn(), None
            except BaseException as e:  # noqa
                res, exc = None, e
            self.loop.call_soon_threadsafe(self._settle, fut, res, exc)

    @staticmethod
    def _settle(fut, res, exc):
        if not fut.done():
            fut.set_exception(exc) if exc else fut.set_result(res)

    def run(self, fn):
        fut = self.loop.create_future()
        self.jobs.put((fn, fut))
        return fut

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
    def open_binary(self, path):
        import pyghidra
        from ghidra.app.util.importer import ProgramLoader
        from ghidra.app.decompiler import DecompInterface
        if self.decomp is not None:
            self.decomp.dispose()
            self.decomp = None
        if self.results is not None:
            self.results.close()
            self.program = self.results = None
        self.cache.clear()
        self.index = []
        if not os.path.isfile(path):
            raise RpcError(NOT_FOUND, "no such file: %s" % path)
        self.progress("import", 0, "importing")
        # shortcut: in-memory program, no throwaway project dir (nothing is saved); upgrade if saving/analysis state must persist
        try:
            res = ProgramLoader.builder().source(path).monitor(self.monitor("import")).load()
        except Exception as e:
            raise RpcError(INTERNAL, "import failed: %s" % e)
        self.results = res
        prog = res.getPrimaryDomainObject()
        self.progress("import", 100, "imported")
        self.progress("analysis", -1, "analyzing")
        pyghidra.analyze(prog, self.monitor("analysis"))
        self.program = prog
        self.progress("index", 0, "building listing index")
        t = time.monotonic()
        self._build_index()
        log("index build: %d rows in %.3fs" % (len(self.index), time.monotonic() - t))
        self.index_secs = time.monotonic() - t
        self.decomp = DecompInterface()
        if not self.decomp.openProgram(prog):
            raise RpcError(INTERNAL, "decompiler failed to open program: %s" % self.decomp.getLastMessage())
        self.progress("ready", 100, "ready")
        return {"programId": str(prog.getName()), "name": str(prog.getName())}  # shortcut: id == name, single program

    def _build_index(self):
        prog = self.program
        it = prog.getListing().getCodeUnits(prog.getMemory().getLoadedAndInitializedAddressSet(), True)
        # shortcut: offsets only unique per address space; assumes one default space; upgrade with (space,offset) keys
        arr = []
        for cu in it:
            arr.append(cu.getMinAddress().getOffset())
        self.index = arr

    def list_functions(self):
        out = []
        for f in self.need().getFunctionManager().getFunctions(True):
            if f.isExternal():
                continue
            out.append((f.getEntryPoint().getOffset(), str(f.getName()), f.getBody().getNumAddresses()))
        out.sort()
        return [{"name": n, "entry": hx(o), "size": int(s)} for o, n, s in out]

    def listing_info(self):
        self.need()
        return {"rowCount": len(self.index)}

    def row_to_address(self, index):
        self.need()
        if not 0 <= index < len(self.index):
            raise RpcError(NOT_FOUND, "row out of range")
        return {"address": hx(self.index[index])}

    def address_to_row(self, address):
        prog = self.need()
        cu = prog.getListing().getCodeUnitContaining(self.addr(address))
        if cu is None:
            raise RpcError(NOT_FOUND, "no code unit at %s" % address)
        i = bisect.bisect_left(self.index, cu.getMinAddress().getOffset())
        if i >= len(self.index) or self.index[i] != cu.getMinAddress().getOffset():
            raise RpcError(NOT_FOUND, "address not in listing index")
        return {"index": i}

    def fetch_rows(self, start, count):
        """Replaceable hot path: rows [start, start+count) already clamped by the caller."""
        from ghidra.program.model.listing import CommentType, Instruction
        prog = self.program
        listing, st = prog.getListing(), prog.getSymbolTable()
        rows = []
        for off in self.index[start:start + count]:
            a = self.addr(hx(off))
            cu = listing.getCodeUnitAt(a)
            if isinstance(cu, Instruction):
                ops = ", ".join(str(cu.getDefaultOperandRepresentation(i)) for i in range(cu.getNumOperands()))
            else:
                ops = str(cu.getDefaultValueRepresentation())
            b = bytes(x & 0xFF for x in cu.getBytes())
            row = {"address": hx(off), "bytes": b.hex(" "), "mnemonic": str(cu.getMnemonicString()), "operands": ops}
            sym = st.getPrimarySymbol(a)
            if sym is not None:
                row["label"] = str(sym.getName())
            c = cu.getComment(CommentType.EOL)
            if c:
                row["comment"] = str(c)
            rows.append(row)
        return rows

    def listing_rows(self, startIndex, count):
        self.need()
        s = max(0, int(startIndex))
        n = max(0, min(int(count), len(self.index) - s))
        return self.fetch_rows(s, n)

    def decompile(self, entry, timeoutSecs=30):
        from ghidra.pyghidra import PyGhidraTaskMonitor
        prog = self.need()
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
        with self.mon_lock:
            self.cur_monitor = mon
        try:
            res = self.decomp.decompileFunction(func, int(timeoutSecs), mon)
        finally:
            with self.mon_lock:
                self.cur_monitor = None
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
                    f = DecompilerUtils.getFunction(prog, t)
                    if f is None:
                        op = t.getPcodeOp()
                        if op is not None and op.getOpcode() == PcodeOp.CALL:
                            f = fm.getFunctionAt(op.getInput(0).getAddress())
                    if f is not None:
                        tok["targetFunction"] = hx(f.getEntryPoint().getOffset())
                tokens.append(tok)
            lines_out.append(text)
        return {"text": "\n".join(lines_out), "tokens": tokens}

    # ---- loop-thread side ----
    def cancel_decompile(self):
        with self.mon_lock:
            m = self.cur_monitor
            if m is not None:
                m.cancel()
        return {"cancelled": m is not None}

    async def handle(self, ws, raw):
        try:
            msg = json.loads(raw)
            rid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        except Exception:
            return
        try:
            if method == "cancel_decompile":
                result = self.cancel_decompile()
            elif method in ("open_binary", "list_functions", "decompile", "listing_info", "listing_rows",
                            "address_to_row", "row_to_address"):
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
        def d():
            try:
                if self.decomp is not None:
                    self.decomp.dispose()
            except Exception:
                pass
        t = threading.Thread(target=d, daemon=True)
        t.start()
        t.join(3)
        os._exit(0)


def main():
    # keep real stdout for the port line only; JVM/Ghidra chatter goes to stderr
    out = os.fdopen(os.dup(1), "w")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    t0 = time.monotonic()
    if "GHIDRA_INSTALL_DIR" not in os.environ:
        sys.exit("GHIDRA_INSTALL_DIR not set")
    import pyghidra
    pyghidra.start()
    log("jvm start: %.2fs" % (time.monotonic() - t0))

    sc = Sidecar()

    async def serve():
        sc.loop = asyncio.get_running_loop()
        async with websockets.serve(sc.conn, "127.0.0.1", 0, max_size=None) as srv:
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

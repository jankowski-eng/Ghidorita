"""@rpc registration and the dispatcher. A method becomes callable by being decorated in its domain module; nothing here lists methods.

Lanes (who runs the method, see lanes.py):
  R         thread R. NoProgram "open_binary in progress" while an open runs (fail fast, never queue behind an open).
            job=True: a Job is registered under the request id (unique id required) and passed as `job=`.
  scan      a scan worker (S), gets `scan=` (unique request id required, cancellable via cancel_search).
  decomp    a decompiler worker (D), gets `job=` (unique request id required).
  edit      prepare a variable edit on S, then commit on R after a revision check; gets `job=`.
  file      parse a local file off R, with a program generation check.
  project   thread R, but Busy instead of NoProgram during an open; busy_ok=True: answered during an open anyway.
  loop      the asyncio loop itself (cancel_*): must be quick and only flip flags. scoped=True: the sessionId is checked first
            (StaleSession), like on R, and the method runs under the session lock so no swap slips in between.
  open      awaited on the loop, runs its own thread O (open_binary).
"""
import asyncio, inspect, json, threading

from .errors import BUSY, CANCELLED, INTERNAL, INVALID, NO_METHOD, NO_PROGRAM, STALE_SESSION, RpcError, log
from .lanes import Job, Scan

LANES = ("R", "scan", "decomp", "edit", "file", "project", "loop", "open")


def rpc(lane="R", job=False, busy_ok=False, scoped=False):
    assert lane in LANES and not (job and lane != "R") and not (busy_ok and lane != "project") and not (scoped and lane != "loop"), (lane, job, busy_ok, scoped)

    def deco(fn):
        fn._rpc = (lane, job, busy_ok, scoped)
        return fn
    return deco


class Method:
    def __init__(self, name, fn, lane, job, busy_ok, scoped=False):
        self.name, self.fn, self.lane, self.job, self.busy_ok, self.scoped = name, fn, lane, job, busy_ok, scoped

    def describe(self):
        return self.lane + ("+job" if self.job else "") + ("+busy_ok" if self.busy_ok else "") + ("+scoped" if self.scoped else "")


class Registry:
    def __init__(self):
        self.methods = {}

    def register(self, obj):
        """Register every @rpc method of obj under its function name; a duplicate name is a startup error."""
        for name, attr in inspect.getmembers(type(obj)):
            spec = getattr(attr, "_rpc", None)
            if spec is None:
                continue
            if name in self.methods:
                raise ValueError("duplicate RPC method %s" % name)
            self.methods[name] = Method(name, getattr(obj, name), *spec)

    def describe(self):
        return {n: m.describe() for n, m in self.methods.items()}


class Dispatcher:
    def __init__(self, ctx, registry):
        self.ctx, self.registry = ctx, registry
        self.file_slots = asyncio.Semaphore(1)
        self.versioned_connection = None

    async def handle(self, ws, raw):
        try:
            msg = json.loads(raw)
            rid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
            if not isinstance(params, dict):
                raise TypeError("params must be an object")
        except Exception:
            return
        try:
            if method == "provider_info":
                self.versioned_connection = ws
            versioned = ws is self.versioned_connection
            result = await self._call(rid, method, params, msg.get("sessionId"), versioned)
            if method == "save" and not versioned:
                result = {"saved": result["saved"]}
            reply = {"jsonrpc": "2.0", "id": rid, "result": result}
        except asyncio.CancelledError:
            raise
        except RpcError as e:
            reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": e.code, "message": str(e)}}
        except (TypeError, ValueError) as e:
            reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": INVALID, "message": "invalid params: %s" % e}}
        except Exception as e:  # noqa
            log("internal error", repr(e))
            reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": INTERNAL, "message": str(e)}}
        if rid is not None:
            await self._send_to(ws, json.dumps(reply))

    async def _call(self, rid, method, params, session_id=None, versioned=False):
        ln, ses = self.ctx.lanes, self.ctx.session
        m = self.registry.methods.get(method) if isinstance(method, str) else None
        if m is None:
            raise RpcError(NO_METHOD, "method not found: %s" % method)
        fn, lane = m.fn, m.lane
        if lane == "loop":
            if method == "cancel_open" and versioned and type(params.get("id")) is not int:
                raise RpcError(INVALID, "cancel_open requires the open request id")
            if m.scoped and (versioned or session_id is not None):
                with ses.lock:
                    if not isinstance(session_id, str) or session_id != ses.session_id:
                        raise RpcError(STALE_SESSION, "program session is no longer active")
                    return fn(**params)
            return fn(**params)
        if lane == "open":
            if "_request_id" in params:
                raise RpcError(INVALID, "invalid open parameters")
            return await fn(_request_id=rid, **params)

        scoped = lane != "project" or method == "close_program"
        with ses.lock:
            epoch = ses.epoch
            if scoped and (versioned or session_id is not None):
                if not isinstance(session_id, str) or session_id != ses.session_id:
                    raise RpcError(STALE_SESSION, "program session is no longer active")

        def with_undo_name(call):
            """An edit's result also names the undo step it committed (additive: `undoName`), so a client can later undo exactly that step."""
            ses.begin_call()
            result = call()
            name = ses.take_committed()
            return {**result, "undoName": name} if name is not None and isinstance(result, dict) else result

        def run_on_r():
            if scoped and epoch != ses.epoch:
                raise RpcError(STALE_SESSION, "program session changed before execution")
            return with_undo_name(lambda: fn(**params))

        if lane == "project":
            if method == "import_candidates":
                if "_versioned" in params:
                    raise RpcError(INVALID, "invalid import parameters")
                params = {**params, "_versioned": versioned}
            if ln.opening is not None and not m.busy_ok:
                raise RpcError(BUSY, "open_binary in progress")
            return await ln.run(run_on_r)
        if ln.opening is not None:  # fail fast: never queue behind an open
            raise RpcError(NO_PROGRAM, "open_binary in progress")
        if lane == "file":
            with ses.lock:
                prog = ses.program
                if epoch != ses.epoch:
                    raise RpcError(STALE_SESSION, "program session changed before execution")
            if prog is None:
                raise RpcError(NO_PROGRAM, "no program open")
            stop = threading.Event()
            try:
                async with self.file_slots:
                    with ses.lock:
                        if ses.program is not prog or ses.epoch != epoch:
                            raise RpcError(CANCELLED, "program changed while waiting to read file")
                    result = await asyncio.to_thread(fn, _cancel=stop, **params)
            except asyncio.CancelledError:
                stop.set()
                raise
            with ses.lock:
                if ses.program is not prog or ses.epoch != epoch:
                    raise RpcError(CANCELLED, "program changed while reading file")
            return result
        if lane == "scan":
            if rid is None or rid in ln.sj:
                raise RpcError(INVALID, "%s needs a unique request id" % method)
            scan = ln.sj[rid] = Scan(epoch)
            try:
                return await ln.run(lambda: fn(scan=scan, **params), ln.sjobs)
            except asyncio.CancelledError:
                scan.cancel()
                raise
            finally:
                ln.sj.pop(rid, None)
        if lane in ("decomp", "edit") or m.job:
            if rid is None or rid in ln.dj:
                raise RpcError(INVALID, "%s needs a unique request id" % method)
            job = ln.dj[rid] = Job(epoch)
            try:
                def run_job():
                    if lane == "R" and epoch != ses.epoch:
                        raise RpcError(STALE_SESSION, "program session changed before execution")
                    return with_undo_name(lambda: fn(job=job, **params))
                return await ln.run(run_job, ln.djobs if lane == "decomp" else ln.sjobs if lane == "edit" else None)
            except asyncio.CancelledError:
                ln.cancel(job)
                raise
            finally:
                ln.dj.pop(rid, None)
        return await ln.run(run_on_r)

    @staticmethod
    async def _send_to(ws, s):
        try:
            await ws.send(s)
        except Exception:
            pass

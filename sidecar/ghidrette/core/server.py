"""The websocket server: connection handling (one client at a time), the auth guard, and shutdown."""
import asyncio, concurrent.futures, os, threading, time

import websockets

from .errors import log


class Server:
    def __init__(self, ctx, dispatch):
        """dispatch: async fn(ws, raw) answering one message (core/rpc.py)."""
        self.ctx, self.dispatch = ctx, dispatch
        self.sd_lock, self.sd_started = threading.Lock(), False

    async def conn(self, ws):
        ctx = self.ctx
        if ctx.ws is not None:  # shortcut: newest client wins nothing; second client just rejected
            await ws.close(1013, "one client at a time")
            return
        ctx.ws = ws
        try:
            async for raw in ws:
                asyncio.create_task(self.dispatch(ws, raw))
        finally:
            ctx.ws = None

    async def serve(self, out):
        """Serve until killed; the chosen port goes to `out` (the real stdout, kept apart from JVM chatter)."""
        self.ctx.loop = asyncio.get_running_loop()
        token = os.environ.get("SIDECAR_TOKEN")  # empty only with SIDECAR_ALLOW_NO_AUTH=1 (checked in main)

        def guard(conn, request):  # a web page can reach 127.0.0.1; require the secret URL path set by Electron main
            if token and request.path != "/" + token:
                return conn.respond(403, "forbidden\n")

        async with websockets.serve(self.conn, "127.0.0.1", 0, max_size=None, process_request=guard) as srv:
            port = srv.sockets[0].getsockname()[1]
            print(port, file=out, flush=True)
            await asyncio.Future()

    def shutdown(self):
        """stdin EOF / SIGTERM. Never exits while a save is running; the close on thread R saves unsaved edits."""
        ctx = self.ctx
        ln, ses = ctx.lanes, ctx.session
        with self.sd_lock:
            if self.sd_started:
                return
            self.sd_started = True
        if ln.opening is not None:
            ln.opening.cancel()
        with ses.lock:
            for j in list(ln.running):  # let running decompiles return so dispose() can reach the native child
                j.cancelled = True
                if j.mon is not None:
                    j.mon.cancel()
        with ln.mon_lock:
            for j in list(ln.dj.values()):  # queued decompiles and a variable edit running on R
                j.cancelled = True
                if j.mon is not None:
                    j.mon.cancel()
        for sc in list(ln.sj.values()):
            sc.cancel()

        op = ln.opening
        while op is not None and op.saving and not op.finished:
            time.sleep(0.02)  # never exit mid-save: a half-written project file would load as "persisted"
        t0 = time.monotonic()
        f = concurrent.futures.Future()

        def close_all():
            for hook in ctx.shutdown_hooks:  # the program close (autosave), then the project (releases the lock files)
                hook()
        ln.jobs.put((close_all, f))  # close (and autosave) on thread R, like every other program change
        # R may be busy with a long edit; give up only if it is not saving (Electron's SIGKILL is the backstop)
        while not f.done() and (time.monotonic() - t0 < 45 or ses.save_lock.locked()):
            time.sleep(0.02)
        log("shutdown: close finished in %.2fs" % (time.monotonic() - t0))
        os._exit(0)

"""The websocket server: connection handling (one client at a time), the auth guard, and shutdown."""
import asyncio, concurrent.futures, os, threading, time

import websockets

from .errors import log


class Server:
    MAX_MESSAGE_BYTES = 2 << 20
    MAX_OUTSTANDING = 64
    SHUTDOWN_QUEUE_TIMEOUT = 45

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
        slots = asyncio.Semaphore(self.MAX_OUTSTANDING)
        tasks = set()
        closed = asyncio.create_task(ws.wait_closed())
        try:
            async for raw in ws:
                acquire = asyncio.create_task(slots.acquire())
                done, _ = await asyncio.wait((acquire, closed), return_when=asyncio.FIRST_COMPLETED)
                if closed in done:
                    acquire.cancel()
                    break
                await acquire
                task = asyncio.create_task(self.dispatch(ws, raw))
                tasks.add(task)
                task.add_done_callback(lambda t: (tasks.discard(t), slots.release()))
        finally:
            ctx.ws = None
            closed.cancel()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def serve(self, out):
        """Serve until killed; the chosen port goes to `out` (the real stdout, kept apart from JVM chatter)."""
        self.ctx.loop = asyncio.get_running_loop()
        token = os.environ.get("SIDECAR_TOKEN")  # empty only with SIDECAR_ALLOW_NO_AUTH=1 (checked in main)

        def guard(conn, request):  # a web page can reach 127.0.0.1; require the secret URL path set by Electron main
            if token and request.path != "/" + token:
                return conn.respond(403, "forbidden\n")

        async with websockets.serve(self.conn, "127.0.0.1", 0, max_size=self.MAX_MESSAGE_BYTES,
                                    max_queue=16, process_request=guard) as srv:
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
            for j in list(ln.dj.values()):  # queued decompiles and variable edits preparing on S
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
        gate = threading.Lock()
        close_started = False
        timed_out = False

        def close_all():
            nonlocal close_started
            with gate:
                if timed_out:
                    return
                close_started = True
            for hook in ctx.shutdown_hooks:  # the program close (autosave), then the project (releases the lock files)
                hook()
        ln.jobs.put((close_all, f))  # close (and autosave) on thread R, like every other program change
        # A queued close may time out; once it starts, wait for its save and inspect its result.
        while not f.done():
            with gate:
                if not close_started and time.monotonic() - t0 >= self.SHUTDOWN_QUEUE_TIMEOUT:
                    timed_out = True
                    break
            time.sleep(0.02)
        if timed_out:
            log("shutdown: close did not start within %ss; edits may be unsaved" % self.SHUTDOWN_QUEUE_TIMEOUT)
            os._exit(2)
        try:
            f.result()
        except BaseException as e:
            log("shutdown: close failed; edits may be unsaved:", repr(e))
            os._exit(1)
        log("shutdown: close finished in %.2fs" % (time.monotonic() - t0))
        os._exit(0)

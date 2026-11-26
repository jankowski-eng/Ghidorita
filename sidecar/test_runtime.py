"""Runtime failure paths that do not need a JVM or a listening socket."""
import asyncio
import contextlib
import queue
import threading
from types import SimpleNamespace

import pytest

from ghidrette.core.events import Events
from ghidrette.core.context import Ctx
from ghidrette.core.errors import CANCELLED, RpcError
from ghidrette.core.lanes import Lanes
from ghidrette.core.rpc import Dispatcher, Method
from ghidrette.core.server import Server
from ghidrette.core.session import Session
from ghidrette.domains.program import Program
from ghidrette.domains.listing import Listing
from ghidrette.domains.highvars import HighVars


class Exited(Exception):
    def __init__(self, code):
        self.code = code


def test_close_save_failure_keeps_program():
    ses = Session()
    prog = ses.program = object()
    domain = Program(SimpleNamespace(session=ses))
    domain._save_program = lambda *_: (_ for _ in ()).throw(OSError("disk full"))
    with pytest.raises(RuntimeError, match="disk full"):
        domain.close()
    assert ses.program is prog and ses.epoch == 0


def test_permission_denied_never_counts_as_corrupt_project():
    assert Program._not_corruption(OSError("Permission denied"))
    assert Program._transient_open_error(OSError("Permission denied"))


@pytest.mark.parametrize("failure, expected", [(False, 0), (True, 1)])
def test_shutdown_uses_close_result(monkeypatch, failure, expected):
    ses = Session()

    class InlineQueue:
        def put(self, item):
            fn, fut = item
            try:
                fut.set_result(fn())
            except BaseException as e:
                fut.set_exception(e)

    lanes = SimpleNamespace(opening=None, running=set(), dj={}, sj={}, mon_lock=threading.Lock(), jobs=InlineQueue())

    def close():
        if failure:
            raise OSError("save failed")

    server = Server(SimpleNamespace(lanes=lanes, session=ses, shutdown_hooks=[close]), None)
    monkeypatch.setattr("ghidrette.core.server.os._exit", lambda code: (_ for _ in ()).throw(Exited(code)))
    with pytest.raises(Exited) as exc:
        server.shutdown()
    assert exc.value.code == expected


def test_shutdown_distinguishes_queued_timeout(monkeypatch):
    ses = Session()
    jobs = queue.Queue()
    lanes = SimpleNamespace(opening=None, running=set(), dj={}, sj={}, mon_lock=threading.Lock(), jobs=jobs)
    server = Server(SimpleNamespace(lanes=lanes, session=ses, shutdown_hooks=[lambda: None]), None)
    server.SHUTDOWN_QUEUE_TIMEOUT = 0
    monkeypatch.setattr("ghidrette.core.server.os._exit", lambda code: (_ for _ in ()).throw(Exited(code)))
    with pytest.raises(Exited) as exc:
        server.shutdown()
    assert exc.value.code == 2
    fn, fut = jobs.get_nowait()
    fn()  # a late R worker must not close the program after timeout


def test_old_event_timer_and_listener_are_ignored():
    scheduled, notes = [], []
    loop = SimpleNamespace(call_soon_threadsafe=lambda fn: fn(),
                           call_later=lambda _secs, fn, *args: scheduled.append((fn, args)))
    ses = Session()
    ses.program = object()
    events = Events(SimpleNamespace(loop=loop, session=ses,
                                    notify=lambda method, params, **_kw: notes.append((method, params))))
    old = events.generation
    events.record({"symbol"}, None)
    events.reset()
    ses.program = None
    fn, args = scheduled.pop(0)
    fn(*args)  # close left no program, but an old timer still fires
    ses.program = object()
    events.record({"comment"}, None, old)
    events.record({"function"}, None)
    for fn, args in scheduled:
        fn(*args)
    assert len(notes) == 1 and notes[0][1]["kinds"] == ["function"]


def test_queued_notification_dropped_after_program_reset():
    callbacks, sent = [], []
    ctx = Ctx()
    ctx.loop = SimpleNamespace(call_soon_threadsafe=callbacks.append)
    ctx.ws = SimpleNamespace(send=lambda s: sent.append(s))
    ctx.notify("program_changed", {}, generation=ctx.events.generation)
    ctx.events.reset()
    callbacks.pop()()
    assert sent == []


def test_cancelled_decompile_request_is_removed_from_queue():
    async def go():
        ctx = SimpleNamespace(loop=asyncio.get_running_loop(), session=Session())
        ctx.lanes = Lanes(ctx)
        registry = SimpleNamespace(methods={"slow": Method("slow", lambda job: None, "decomp", False, False)})
        dispatcher = Dispatcher(ctx, registry)
        task = asyncio.create_task(dispatcher._call(7, "slow", {}))
        await asyncio.sleep(0)
        job = ctx.lanes.dj[7]
        _, fut = ctx.lanes.djobs.get_nowait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert job.cancelled and fut.cancelled() and 7 not in ctx.lanes.dj
    asyncio.run(go())


def test_file_parse_rejects_program_swap_and_cancellation(tmp_path):
    path = tmp_path / "coverage.txt"
    path.write_text("0x10\n")
    stop = threading.Event()
    stop.set()
    listing = Listing(SimpleNamespace(session=Session()))
    with pytest.raises(RpcError) as exc:
        listing.load_coverage(str(path), _cancel=stop)
    assert exc.value.code == CANCELLED

    async def go():
        ses = Session()
        ses.program = object()
        ctx = SimpleNamespace(session=ses)
        ctx.lanes = SimpleNamespace(opening=None)

        def parse(_cancel):
            with ses.lock:
                ses.epoch += 1
            return {"ranges": []}

        registry = SimpleNamespace(methods={"parse": Method("parse", parse, "file", False, False)})
        with pytest.raises(RpcError) as exc:
            await Dispatcher(ctx, registry)._call(1, "parse", {})
        assert exc.value.code == CANCELLED
    asyncio.run(go())


def test_prepared_variable_edit_rejects_intervening_write(monkeypatch):
    symbol = SimpleNamespace(getName=lambda: "local")
    hf = SimpleNamespace(getLocalSymbolMap=lambda: SimpleNamespace(getSymbols=lambda: [symbol]))
    func = SimpleNamespace(getName=lambda: "function")
    prog = SimpleNamespace(getFunctionManager=lambda: SimpleNamespace(getFunctionAt=lambda _addr: func))
    ses = SimpleNamespace(lock=threading.Lock(), revision=0, epoch=1, program=prog,
                          addr=lambda _entry, _prog: object(), edit=lambda *_: pytest.fail("stale edit committed"))

    @contextlib.contextmanager
    def scanning(_job):
        yield prog

    @contextlib.contextmanager
    def decompile(*_args):
        yield hf

    def on_r(fn):
        with ses.lock:
            ses.revision += 1
        fn()

    ctx = SimpleNamespace(session=ses, lanes=SimpleNamespace(scanning=scanning, on_r=on_r))
    monkeypatch.setattr("ghidrette.domains.highvars.decompile_for_edit", decompile)
    with pytest.raises(RpcError) as exc:
        HighVars(ctx)._high_edit("Rename in %s", "0x10", "local", lambda *_: None, 30,
                                 SimpleNamespace(cancelled=False, epoch=1))
    assert exc.value.code == CANCELLED


def test_disconnected_open_keeps_opening_until_worker_stops(tmp_path):
    path = tmp_path / "binary"
    path.write_bytes(b"x")
    release = threading.Event()

    async def go():
        lanes = SimpleNamespace(opening=None, settle=Lanes.settle)
        ctx = SimpleNamespace(loop=asyncio.get_running_loop(), session=Session(), lanes=lanes)
        domain = Program(ctx)
        domain._check_options = lambda *_: {}
        domain._do_open = lambda *_: (release.wait(2), {})[1]
        task = asyncio.create_task(domain.open_binary(str(path)))
        await asyncio.sleep(0)
        op = lanes.opening
        assert op is not None
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert op.cancelled and lanes.opening is op
        release.set()
        for _ in range(20):
            if lanes.opening is None:
                break
            await asyncio.sleep(0.01)
        assert lanes.opening is None
    asyncio.run(go())


def test_connection_bounds_and_cancels_requests():
    async def go():
        started, cancelled = [], []
        inbox, closed = asyncio.Queue(), asyncio.Event()

        class WS:
            def __aiter__(self):
                return self

            async def __anext__(self):
                item = await inbox.get()
                if item is None:
                    raise StopAsyncIteration
                return item

            async def wait_closed(self):
                await closed.wait()

        async def dispatch(_ws, raw):
            started.append(raw)
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cancelled.append(raw)
                raise

        ctx = SimpleNamespace(ws=None)
        server = Server(ctx, dispatch)
        server.MAX_OUTSTANDING = 2
        ws = WS()
        connection = asyncio.create_task(server.conn(ws))
        for i in range(3):
            await inbox.put(str(i))
        for _ in range(20):
            if len(started) == 2:
                break
            await asyncio.sleep(0.01)
        assert started == ["0", "1"]
        closed.set()
        await inbox.put(None)
        await asyncio.wait_for(connection, 1)
        assert sorted(cancelled) == ["0", "1"] and ctx.ws is None
    asyncio.run(go())

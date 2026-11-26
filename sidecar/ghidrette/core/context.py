"""The one object every domain gets: the runtime pieces and the way to talk to the client."""
import asyncio, json

from .events import Events
from .lanes import Lanes
from .session import Session


class Ctx:
    """session: the open program. lanes: threads and queues. events: change events and cache invalidation.
    project: the Ghidra project (set by app.py, it is a domain too). notify/progress: server -> client notifications, thread-safe.
    shutdown_hooks: called in order on thread R at shutdown, after the program close was requested (app.py fills them)."""
    def __init__(self):
        self.loop = None   # the asyncio loop, set by server.serve()
        self.ws = None     # the one client connection, set by server.conn()
        self.session = Session()
        self.lanes = Lanes(self)
        self.events = Events(self)
        self.project = None
        self.analysis = None  # domains/analysis.py, set by app.py
        self.debug = None     # domains/debug.py (its constructor sets it): program.close() tears the debugger down first
        self.shutdown_hooks = []

    def notify(self, method, params, generation=None):  # thread-safe
        def send():
            if self.ws is not None and (generation is None or generation == self.events.generation):
                asyncio.ensure_future(self._send(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}), generation))
        self.loop.call_soon_threadsafe(send)

    async def _send(self, s, generation=None):
        try:
            if self.ws is not None and (generation is None or generation == self.events.generation):
                await self.ws.send(s)
        except Exception:
            pass

    def progress(self, phase, pct, message="", **extra):
        op = self.lanes.opening
        self.notify("progress", {"openId": op.request_id if op else None, "phase": phase, "pct": pct, "message": message, **extra})

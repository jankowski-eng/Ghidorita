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
        self.shutdown_hooks = []

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

    def progress(self, phase, pct, message="", **extra):
        self.notify("progress", {"phase": phase, "pct": pct, "message": message, **extra})

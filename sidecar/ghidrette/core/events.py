"""Change events: the DomainObjectListener, coalescing into program_changed notifications, and the invalidation hook.

The listener runs on Ghidra's event thread; it only copies data and never touches the DB. Everything that caches something derived
from the program (decompile cache, symbol/string snapshots) calls `subscribe(fn(kinds, ranges, broad))`: fn runs for every change
(and for `reset()`, a program swap) on whatever thread caused it, so it must be quick and thread-safe. `ranges` is a list of
(start, end) offsets, None when `broad` (no usable range: type events, other spaces, undo/redo, a swap).
"""
import threading

from .args import hx
from .errors import log

# program_changed kinds, see protocol.md. Everything not listed is "other".
ALL_KINDS = ["symbol", "comment", "function", "data", "code", "type", "other"]
KIND_PREFIX = [("SYMBOL_", "symbol"), ("EXTERNAL_", "symbol"), ("REFERENCE_", "symbol"), ("REFERNCE_", "symbol"), ("EQUATE_", "symbol"),
               ("COMMENT_", "comment"), ("FUNCTION_", "function"), ("VARIABLE_REFERENCE_", "function"),
               ("CODE_UNIT_PROPERTY_", "data"), ("MEMORY_BYTES_", "data"), ("CODE_", "code"), ("FALLTHROUGH_", "code"),
               ("FLOW_OVERRIDE_", "code"), ("LENGTH_OVERRIDE_", "code"), ("DATA_TYPE_", "type"), ("SOURCE_ARCHIVE_", "type")]


class Events:
    def __init__(self, ctx):
        self.ctx = ctx
        self.listener = None
        self.subscribers = []
        self.pending = {"ranges": [], "kinds": set(), "broad": False, "armed": False}
        self.plock = threading.Lock()

    def subscribe(self, fn):
        self.subscribers.append(fn)

    # ---- the Ghidra listener ----
    def attach(self, prog):
        lst = self._make_listener(prog)
        prog.addListener(lst)
        self.listener = lst

    def detach(self, prog):
        lst, self.listener = self.listener, None
        if prog is not None and lst is not None:
            try:
                prog.removeListener(lst)
            except Exception:
                pass

    def _make_listener(self, prog):
        from jpype import JClass, JImplements, JObject, JOverride
        ev_, space = self, prog.getAddressFactory().getDefaultAddressSpace()

        @JImplements("ghidra.framework.model.DomainObjectListener")
        class L:
            @JOverride
            def domainObjectChanged(self, ev):
                try:
                    ev_._on_events(ev, space)
                except Exception as e:  # noqa
                    log("listener error", repr(e))
                    ev_.record(set(ALL_KINDS), None)
        # Ghidra keeps listeners in a weak set: hold a strong reference to the *Java* proxy, or a GC silently drops it
        return JObject(L(), JClass("ghidra.framework.model.DomainObjectListener"))

    def _on_events(self, ev, space):
        from ghidra.program.util import ProgramChangeRecord
        kinds, ranges, broad = set(), [], False
        for r in ev:
            name = str(r.getEventType())
            if not isinstance(r, ProgramChangeRecord):  # DomainObjectEvent: RESTORED (undo/redo), SAVED, ... : anything may have changed
                if name == "RESTORED":
                    kinds.update(ALL_KINDS)
                    broad = True
                continue
            kinds.add(next((k for p, k in KIND_PREFIX if name.startswith(p)), "other"))
            s, e = r.getStart(), r.getEnd()
            if s is None or s.isExternalAddress() or s.getAddressSpace() != space:
                broad = True  # type events, other spaces, ...: no usable range
            else:
                ranges.append((s.getOffset(), (e or s).getOffset()))
        if not kinds:
            return
        self.record(kinds, None if broad else ranges)

    # ---- recording and emitting ----
    def record(self, kinds, ranges):
        """A change happened (listener, or an edit that knows its range): invalidate subscribers now, tell the client soon."""
        for fn in self.subscribers:
            fn(kinds, ranges, ranges is None)
        with self.plock:
            p = self.pending
            p["kinds"] |= kinds
            if ranges is None:
                p["broad"] = True
            else:
                p["ranges"].extend(ranges)
            if p["armed"]:
                return
            p["armed"] = True
        loop = self.ctx.loop
        loop.call_soon_threadsafe(lambda: loop.call_later(0.05, self._emit))

    def reset(self):
        """The program is being swapped or closed (thread R): everything derived from it is stale, nothing is announced."""
        for fn in self.subscribers:
            fn(set(ALL_KINDS), None, True)
        with self.plock:
            self.pending.update(ranges=[], kinds=set(), broad=False)

    def _emit(self):
        with self.plock:
            p = self.pending
            kinds, broad, ranges = sorted(p["kinds"], key=ALL_KINDS.index), p["broad"], sorted(p["ranges"])
            p.update(ranges=[], kinds=set(), broad=False, armed=False)
        merged = []
        for s, e in ranges:
            if merged and s <= merged[-1][1] + 1:
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e])
        if broad or len(merged) > 1000:
            out = None
        else:
            out = [{"start": hx(s), "end": hx(e)} for s, e in merged]
        self.ctx.notify("program_changed", {"ranges": out, "kinds": kinds, "undo": self.ctx.session.undo_snap})

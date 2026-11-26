"""Change events: the DomainObjectListener, coalescing into program_changed notifications, and the invalidation hook.

The listener runs on Ghidra's event thread; it only copies data and never touches the DB. Everything that caches something derived
from the program (decompile cache, symbol/string snapshots) calls `subscribe(fn(kinds, ranges, broad))`: fn runs for every change
(and for `reset()`, a program swap) on whatever thread caused it, so it must be quick and thread-safe. `ranges` is a list of
(space name, first offset, last offset), None when `broad` (no usable range: type events, stack/register addresses, undo/redo, a swap).
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
        self.generation = 0

    def subscribe(self, fn):
        self.subscribers.append(fn)

    # ---- the Ghidra listener ----
    def attach(self, prog):
        lst = self._make_listener(prog, self.generation)
        prog.addListener(lst)
        self.listener = lst

    def detach(self, prog):
        lst, self.listener = self.listener, None
        if prog is not None and lst is not None:
            try:
                prog.removeListener(lst)
            except Exception:
                pass

    def _make_listener(self, prog, generation):
        from jpype import JClass, JImplements, JObject, JOverride
        ev_ = self

        @JImplements("ghidra.framework.model.DomainObjectListener")
        class L:
            @JOverride
            def domainObjectChanged(self, ev):
                try:
                    ev_._on_events(ev, generation)
                except Exception as e:  # noqa
                    log("listener error", repr(e))
                    ev_.record(set(ALL_KINDS), None, generation)
        # Ghidra keeps listeners in a weak set: hold a strong reference to the *Java* proxy, or a GC silently drops it
        return JObject(L(), JClass("ghidra.framework.model.DomainObjectListener"))

    def _on_events(self, ev, generation):
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
            if s is None or not s.isMemoryAddress() or (e is not None and e.getAddressSpace() != s.getAddressSpace()):
                broad = True  # type events, stack/register/external addresses, a range across spaces: no usable range
            else:
                ranges.append(self.ctx.session.rng(s, e or s))
        if not kinds:
            return
        self.record(kinds, None if broad else ranges, generation)

    # ---- recording and emitting ----
    def record(self, kinds, ranges, generation=None):
        """A change happened (listener, or an edit that knows its range): invalidate subscribers now, tell the client soon."""
        with self.plock:
            generation = self.generation if generation is None else generation
            if generation != self.generation:
                return
        for fn in self.subscribers:
            fn(kinds, ranges, ranges is None)
        with self.plock:
            if generation != self.generation:
                return
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
        loop.call_soon_threadsafe(lambda: loop.call_later(0.05, self._emit, generation))

    def reset(self):
        """The program is being swapped or closed (thread R): everything derived from it is stale, nothing is announced."""
        with self.plock:
            self.generation += 1
            self.pending.update(ranges=[], kinds=set(), broad=False, armed=False)
        for fn in self.subscribers:
            fn(set(ALL_KINDS), None, True)

    def _emit(self, generation):
        with self.plock:
            if generation != self.generation:
                return
            p = self.pending
            kinds, broad, ranges = sorted(p["kinds"], key=ALL_KINDS.index), p["broad"], sorted(p["ranges"])
            p.update(ranges=[], kinds=set(), broad=False, armed=False)
        if not kinds and not broad:  # reset() dropped what was pending: no spurious program_changed for a closed program
            return
        merged = []
        for sp, s, e in ranges:
            if merged and merged[-1][0] == sp and s <= merged[-1][2] + 1:
                merged[-1][2] = max(merged[-1][2], e)
            else:
                merged.append([sp, s, e])
        ses = self.ctx.session
        with ses.lock:
            prog = ses.program
            if prog is None:
                return
            if broad or len(merged) > 1000:
                out = None
            else:
                f = ses.fmtr(prog)
                def at(sp, off):
                    return f(prog.getAddressFactory().getAddressSpace(sp).getAddress(off - (1 << 64) if off >= 1 << 63 else off))
                out = [{"start": at(sp, s), "end": at(sp, e)} for sp, s, e in merged]
            undo = ses.undo_snap
        with self.plock:
            if generation == self.generation:
                self.ctx.notify("program_changed", {"ranges": out, "kinds": kinds, "undo": undo}, generation=generation)

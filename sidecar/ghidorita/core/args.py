"""Argument validators shared by the domains."""
from .errors import INVALID, RpcError


MASK64 = (1 << 64) - 1


def hx(off):
    return "0x%x" % (off & MASK64)  # Ghidra offsets are signed longs: addresses above 2^63 read negative


def akey(s):
    """Sort key of a protocol address string: its offset (qualified addresses carry the space before the last ':')."""
    return int(s.rpartition(":")[2], 16)


def ref_kind(rt):
    if rt.isCall():
        return "call"
    if rt.isJump():
        return "jump"
    if rt.isRead() and rt.isWrite():
        return "readwrite"
    if rt.isRead():
        return "read"
    if rt.isWrite():
        return "write"
    if rt.isData():
        return "data"
    return "flow" if rt.isFlow() else "other"


def lim(v, default, hi=None):
    v = default if v is None else int(v)
    if v < 0:
        raise RpcError(INVALID, "negative argument")
    return min(v, hi) if hi else v


def text_arg(v, what):
    if not isinstance(v, str):
        raise RpcError(INVALID, "%s must be a string" % what)
    return v


def name_arg(v, what="name"):
    text_arg(v, what)
    if not v or any(c.isspace() for c in v):
        raise RpcError(INVALID, "invalid %s %r" % (what, v))
    return v

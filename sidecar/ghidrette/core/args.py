"""Argument validators shared by the domains."""
from .errors import INVALID, RpcError


def hx(off):
    return "0x%x" % off


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

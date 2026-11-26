"""Fixtures shared by the test files."""
import time

import pytest

from testlib import BIN, Client, Proc, run


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    d = tmp_path_factory.mktemp("proj")
    proc = Proc(d)
    state = {}

    async def first_open():
        async with Client(proc.port) as c:
            t = time.monotonic()
            state["open"] = await c.ok("open_binary", path=BIN)
            state["open_s"] = time.monotonic() - t
            state["notes"] = list(c.notes)
            state["fns"] = await c.ok("list_functions")
    run(first_open())
    state["proc"] = proc
    yield state
    proc.stop()


@pytest.fixture(scope="module")
def bproc(tmp_path_factory):
    d = tmp_path_factory.mktemp("bproj")
    proc = Proc(d / "projects")
    yield proc, d
    proc.stop()

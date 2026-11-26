"""Paths that need a real large binary (round 6). Not run unless its analysis is already stored (a first open takes 10-40 minutes):

  SPIKE_BIG_BINARY    default /opt/homebrew/Cellar/llvm/23.1.3_2/bin/llvm-exegesis (66.7 MB)
  SPIKE_BIG_PROJECTS  projects dir holding it analysed with the fast profile, default ../bench/projects/exegesis-fast
                      (create it with: SIDECAR_ANALYSIS_DISABLE="Call Convention ID;Decompiler Switch Analysis;Stack" ../sidecar/.venv/bin/python ../bench/bench_open.py <binary> <dir> out.json)
The tests only read the program (nothing is saved)."""
import asyncio, os, time

import pytest

from test_backend import CANCELLED, HERE, Client, Proc, run

TIMEOUT = -32003
BIG = os.environ.get("SPIKE_BIG_BINARY", "/opt/homebrew/Cellar/llvm/23.1.3_2/bin/llvm-exegesis")
PROJECTS = os.environ.get("SPIKE_BIG_PROJECTS", os.path.join(HERE, "..", "bench", "projects", "exegesis-fast"))
LARGE = 30 * 1024  # the UI's size-warning limit


@pytest.fixture(scope="module")
def big():
    if not (os.path.isfile(BIG) and os.path.isdir(PROJECTS)):
        pytest.skip("no stored analysis of the big binary (see the docstring of test_big.py)")
    proc = Proc(PROJECTS)
    state = {}

    async def go():
        async with Client(proc.port) as c:
            if not any(p.get("sourcePath") == BIG and p["options"].get("profile") == "fast" for p in await c.ok("list_programs")):
                pytest.skip("the big binary is not analysed in " + PROJECTS)
            r = await c.ok("open_binary", path=BIG, profile="fast")
            assert r["persisted"] is True
            state["fns"] = await c.ok("list_functions")
    try:
        run(go())
        state["proc"] = proc
        yield state
    finally:
        proc.stop()


def test_cancel_running_search_memory(big):
    """5.7 M matches of 00 00 00 00 on the big binary: a page that is running is cancelled in milliseconds, earlier pages stay valid, the listing stays responsive."""
    async def go():
        async with Client(big["proc"].port) as c:
            first = await c.ok("search_memory", pattern="00 00 00 00", limit=10000)
            assert len(first["items"]) == 10000 and first["next"]
            # page 2 runs for ~0.5 s (a page walks ~10,000 matches of Ghidra's searcher); cancel it while it is running
            rid = await c.send("search_memory", pattern="00 00 00 00", limit=10000, start=first["next"])
            await asyncio.sleep(0.1)
            t = time.monotonic()
            probe = await c.ok("listing_rows", address=big["fns"][100]["entry"], count=50)  # not blocked by the scan (thread R)
            probe_ms = (time.monotonic() - t) * 1000
            assert probe
            ack = await c.ok("cancel_search", id=rid)
            t = time.monotonic()
            r = await c.reply(rid)
            assert ack == {"cancelled": True}, "the page had already finished: the machine is too fast for this test"
            assert r["error"]["code"] == CANCELLED, r
            print("search cancelled: reply %.0f ms after the ack, listing fetch during the scan %.0f ms" % ((time.monotonic() - t) * 1000, probe_ms))
            # the first page is still what the second search starts from
            again = await c.ok("search_memory", pattern="00 00 00 00", limit=10, start=first["next"])
            assert again["items"][0]["address"] == first["next"] or int(again["items"][0]["address"], 16) >= int(first["next"], 16)
            # a no-match search over the whole binary, cancelled while it runs, then the next request is served
            rid = await c.send("search_memory", pattern="de ad be ef 00 ff 00 ff")
            await asyncio.sleep(0.05)
            ack = await c.ok("cancel_search", id=rid)
            r = await c.reply(rid)
            assert (ack["cancelled"] and r["error"]["code"] == CANCELLED) or ("result" in r and not ack["cancelled"])  # finished first on a fast machine: still no hang
            assert (await c.ok("search_memory", pattern="fd 7b bf a9", limit=5))["items"]
    run(go())


def test_decompile_and_variable_edit_timeout_on_a_huge_function(big):
    """A function over 30 KB: decompile / rename_variable / retype_variable with timeoutSecs=1 answer Timeout, write nothing, leave the sidecar usable;
    "Decompile anyway" (a long timeout) then really decompiles it."""
    fns = big["fns"]
    huge = min((f for f in fns if f["size"] > LARGE), key=lambda f: f["size"])

    async def go():
        async with Client(big["proc"].port) as c:
            t = time.monotonic()
            await c.err("decompile", TIMEOUT, entry=huge["entry"], timeoutSecs=1)
            assert (time.monotonic() - t) < 10, "Timeout must come back close to the limit"
            before = await c.ok("undo_state")
            assert before["dirty"] is False
            for method, kw in (("rename_variable", dict(name="param_1", newName="timeout_probe")), ("retype_variable", dict(name="param_1", dataType="long"))):
                t = time.monotonic()
                await c.err(method, TIMEOUT, entry=huge["entry"], timeoutSecs=1, **kw)
                assert (time.monotonic() - t) < 10, method
                assert await c.ok("undo_state") == before, "a timed-out edit must write nothing"
            # thread R was released: a listing read answers at once, a small function decompiles
            t = time.monotonic()
            await c.ok("listing_rows", address=huge["entry"], count=20)
            assert (time.monotonic() - t) < 1
            small = min((f for f in fns if f["size"] > 40), key=lambda f: f["size"])
            assert (await c.ok("decompile", entry=small["entry"]))["text"]
            # "Decompile anyway": the same function with a long timeout completes (10-30 s on this binary)
            t = time.monotonic()
            r = await c.ok("decompile", entry=huge["entry"], timeoutSecs=600)
            print("decompile anyway of %d bytes: %.1f s, %d lines" % (huge["size"], time.monotonic() - t, r["text"].count("\n")))
            assert r["text"].count("\n") > 50 and r["cached"] is False
            assert (await c.ok("decompile", entry=huge["entry"]))["cached"] is True  # the long result is cached like any other
    run(go())

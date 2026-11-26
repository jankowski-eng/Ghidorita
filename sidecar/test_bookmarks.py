"""Bookmarks: a row removes exactly its (address, type, category); list_bookmarks is a cancellable scan that never delays listing_rows."""
import asyncio, threading, time

import pytest

from ghidorita.core.errors import RpcError
from ghidorita.domains import bookmarks as bookmarks_mod
from testlib import BASE, CANCELLED, NOT_FOUND, X86, Client, inproc, run


async def settled(c):
    """The module's /bin/ls opens in background mode: edits are Busy until its analysis ends."""
    end = time.monotonic() + 300
    while (await c.ok("analysis_status"))["state"] == "running":
        assert time.monotonic() < end
        await asyncio.sleep(0.2)


def test_remove_one_category_keeps_the_others_and_undo_restores_it(env):
    async def go():
        async with Client(env["proc"].port) as c:
            await settled(c)
            a = env["fns"][len(env["fns"]) // 3]["entry"]
            await c.ok("set_bookmark", address=a, category="triage", comment="one")
            await c.ok("set_bookmark", address=a, category="todo", comment="two")
            notes = lambda: c.ok("list_bookmarks", type="Note")
            assert sorted(i["category"] for i in (await notes())["items"] if i["address"] == a) == ["todo", "triage"]
            await c.ok("remove_bookmark", address=a, type="Note", category="triage")  # a hidden-by-filter category would have gone too before
            assert [(i["category"], i["comment"]) for i in (await notes())["items"] if i["address"] == a] == [("todo", "two")]
            assert (await c.ok("listing_rows", address=a, count=1))[0]["bookmarks"] == [{"category": "todo", "comment": "two"}]
            await c.err("remove_bookmark", NOT_FOUND, address=a, type="Note", category="triage")
            await c.ok("undo")  # one undo step restores exactly that bookmark
            assert sorted(i["category"] for i in (await notes())["items"] if i["address"] == a) == ["todo", "triage"]
            await c.ok("redo")
            assert [i["category"] for i in (await notes())["items"] if i["address"] == a] == ["todo"]
            await c.ok("remove_bookmark", address=a, type="Note")  # category omitted: the explicit "all categories here"
            assert not [i for i in (await notes())["items"] if i["address"] == a]
            await c.ok("undo"); await c.ok("undo"); await c.ok("undo"); await c.ok("undo")  # leave the program as found
    run(go())


def test_list_bookmarks_is_cancellable_and_does_not_block_listing(sc, tmp_path, monkeypatch):
    blob = tmp_path / "b.bin"
    blob.write_bytes(bytes.fromhex("5589e5b8010000005dc3"))
    entered = threading.Event()

    def endless(self, prog, scan):  # a bookmark table big enough to take seconds
        entered.set()
        while True:
            scan.check()
            time.sleep(0.01)

    async def go():
        async with inproc(tmp_path, monkeypatch) as (ctx, call):
            await call("open_binary", path=str(blob), loader="Raw Binary", language=X86, baseAddress=BASE, analysis="blocking")
            with monkeypatch.context() as patch:
                patch.setattr(bookmarks_mod.Bookmarks, "_snapshot", endless)
                req = asyncio.create_task(call("list_bookmarks", rid=7))
                assert await asyncio.to_thread(entered.wait, 5)
                for _ in range(5):  # R is free meanwhile
                    assert await asyncio.wait_for(call("listing_rows", address=BASE, count=5), 1)
                assert await call("cancel_search", id=7) == {"cancelled": True}
                with pytest.raises(RpcError) as caught:
                    await asyncio.wait_for(req, 3)
                assert caught.value.code == CANCELLED
            # the real thing again: a snapshot, reused until the program changes
            assert (await call("list_bookmarks"))["total"] == 0
            await call("set_bookmark", address=BASE, category="c", comment="x")
            assert (await call("list_bookmarks", type="Note"))["total"] == 1  # the edit dropped the cache
            await call("remove_bookmark", address=BASE, type="Note", category="c")
            assert (await call("list_bookmarks", type="Note"))["total"] == 0
    run(go())


def test_list_bookmarks_type_list(env):
    async def go():
        async with Client(env["proc"].port) as c:
            allb = await c.ok("list_bookmarks", limit=1000)
            kinds = {t["type"]: t["count"] for t in allb["types"]}
            pair = [k for k in ("Error", "Warning") if k in kinds]
            assert pair, kinds  # the analysis of /bin/ls leaves some
            both = await c.ok("list_bookmarks", type=",".join(pair))
            assert both["total"] == sum(kinds[k] for k in pair) and {i["type"] for i in both["items"]} <= set(pair)
            one = await c.ok("list_bookmarks", type=pair[0])
            assert one["total"] == kinds[pair[0]]
    run(go())

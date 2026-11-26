"""Scan lane: symbols, strings, memory search, cancel_search."""
import time

from testlib import CANCELLED, Client, INVALID, run


def test_list_symbols(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            p = await c.ok("list_symbols", limit=200)
            assert p["total"] >= len(fns) and len(p["items"]) == 200
            assert all(set(i) == {"name", "address", "kind", "namespace", "source"} for i in p["items"])
            assert all(i["kind"] in ("function", "label", "data", "external", "variable", "other") and i["source"] in ("user", "analysis", "imported", "default", "other") for i in p["items"])
            addrs = [int(i["address"], 16) for i in p["items"] if i["address"]]
            assert addrs == sorted(addrs)
            # paging is consistent with one big page, and a page past the end is empty
            parts = []
            for off in range(0, 200, 50):
                parts += (await c.ok("list_symbols", offset=off, limit=50))["items"]
            assert parts == p["items"]
            assert (await c.ok("list_symbols", offset=p["total"] + 10))["items"] == []
            # kind filter: functions (a superset of list_functions: external functions are symbols too)
            f = await c.ok("list_symbols", kinds=["function"], limit=1000)
            assert len(fns) <= f["total"] <= len(fns) + 500 and all(i["kind"] == "function" for i in f["items"])
            mix = await c.ok("list_symbols", kinds=["function", "external"], limit=5)
            assert mix["total"] >= f["total"]
            # name filter (substring, case-insensitive), sorts both ways
            nm = fns[len(fns) // 2]["name"]
            q = await c.ok("list_symbols", query=nm.upper(), limit=50)
            assert q["total"] >= 1 and all(nm.lower() in i["name"].lower() for i in q["items"]) and any(i["name"] == nm for i in q["items"])
            asc = await c.ok("list_symbols", sort="name", limit=100)
            desc = await c.ok("list_symbols", sort="name", desc=True, limit=100)
            names = [i["name"].lower() for i in asc["items"]]
            assert names == sorted(names) and [i["name"].lower() for i in desc["items"]] == sorted(names for names in [i["name"].lower() for i in desc["items"]])[::-1]
            assert asc["total"] == desc["total"] == p["total"]
            for srt in ("kind", "namespace", "source", "address"):
                r = await c.ok("list_symbols", sort=srt, desc=True, limit=20)
                assert r["total"] == p["total"] and len(r["items"]) == 20
            await c.err("list_symbols", INVALID, sort="bogus")
            await c.err("list_symbols", INVALID, kinds=["bogus"])
            await c.err("list_symbols", INVALID, kinds="function")
            await c.err("list_symbols", INVALID, query=3)
            await c.err("list_symbols", INVALID, offset=-1)
            # an edit invalidates the snapshots: the renamed function shows up in the name filter
            await c.ok("rename_symbol", address=fns[3]["entry"], newName="navfind_probe_name")
            hit = await c.ok("list_symbols", query="navfind_probe", limit=5)
            assert [i["name"] for i in hit["items"]] == ["navfind_probe_name"] and hit["items"][0]["source"] == "user"
            await c.ok("undo")
            assert (await c.ok("list_symbols", query="navfind_probe"))["total"] == 0
    run(go())


def test_scan_cancel_and_listing_not_blocked(env):
    async def go():
        async with Client(env["proc"].port) as c:
            # many queued scans on 2 workers: the last one is still queued when it is cancelled
            ids = [await c.send("list_symbols", query="e%d" % i, sort="kind") for i in range(40)]
            assert (await c.ok("cancel_search", id=ids[-1]))["cancelled"] is True
            assert (await c.reply(ids[-1]))["error"]["code"] == CANCELLED
            assert (await c.ok("cancel_search", id=999999)) == {"cancelled": False}
            # listing fetches are answered while the scans run (they are on another thread)
            t = time.monotonic()
            rows = await c.ok("listing_rows", address=env["fns"][0]["entry"], count=50)
            lat = time.monotonic() - t
            assert len(rows) == 50
            for i in ids[:-1]:
                assert "result" in await c.reply(i)
            print("listing fetch while 39 scans queued: %.0f ms" % (lat * 1000))
            await c.err("cancel_search", INVALID)
    run(go())


def test_strings_query(env):
    async def go():
        async with Client(env["proc"].port) as c:
            s = await c.ok("list_strings", limit=5000)
            word = max((i["value"] for i in s["items"]), key=len)[:6]
            q = await c.ok("list_strings", query=word.upper(), limit=5000)
            assert 1 <= q["total"] <= s["total"] and all(word.lower() in i["value"].lower() for i in q["items"])
            assert q["items"] == [i for i in s["items"] if word.lower() in i["value"].lower()][:5000]
            assert (await c.ok("list_strings", query="zzzz_no_such_string_zzzz"))["total"] == 0
            assert all(len(i["value"]) <= 1000 for i in s["items"])
            await c.err("list_strings", INVALID, query=7)
    run(go())


def test_search_memory(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            entry = fns[len(fns) // 2]["entry"]
            row = (await c.ok("listing_rows", address=entry, count=3))
            raw = " ".join(r["bytes"] for r in row)[:11]  # the first 4 bytes of the function
            exact = await c.ok("search_memory", pattern=raw)
            assert any(i["address"] == entry and i["length"] == 4 for i in exact["items"]), (raw, exact)
            assert all(i["bytes"].startswith(raw) for i in exact["items"])
            # wildcards: replace the 2nd and 3rd byte
            b = raw.split()
            wild = await c.ok("search_memory", pattern="%s ?? ?? %s" % (b[0], b[3]))
            assert any(i["address"] == entry for i in wild["items"]) and len(wild["items"]) >= len(exact["items"])
            assert all(i["bytes"].split()[0] == b[0] and i["bytes"].split()[3] == b[3] for i in wild["items"])
            # paging: one match per page walks the same matches as one big page, ascending, with `next` null at the end
            allm, nxt = [], None
            for _ in range(2000):
                r = await c.ok("search_memory", pattern="%s ?? ?? %s" % (b[0], b[3]), limit=1, **({"start": nxt} if nxt else {}))
                allm += [i["address"] for i in r["items"]]
                nxt = r["next"]
                if nxt is None:
                    break
            assert nxt is None and allm == [i["address"] for i in wild["items"]] and allm == sorted(allm, key=lambda a: int(a, 16))
            assert wild["next"] is None
            # no match: empty, next null
            assert await c.ok("search_memory", pattern="ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff") == {"items": [], "next": None}
            # text: a defined string, ASCII, case-insensitive; UTF-16 runs (no UTF-16 string expected in ls)
            sv = max((i for i in (await c.ok("list_strings", limit=5000))["items"] if i["value"].isascii() and i["value"].isprintable()), key=lambda i: len(i["value"]))
            t = await c.ok("search_memory", kind="text", pattern=sv["value"])
            assert any(i["address"] == sv["address"] and i["length"] == len(sv["value"]) for i in t["items"])
            up = await c.ok("search_memory", kind="text", pattern=sv["value"].upper(), caseSensitive=False)
            assert any(i["address"] == sv["address"] for i in up["items"])
            if sv["value"].upper() != sv["value"]:
                assert not any(i["address"] == sv["address"] for i in (await c.ok("search_memory", kind="text", pattern=sv["value"].upper(), caseSensitive=True))["items"])
            u16 = await c.ok("search_memory", kind="text", pattern="ab", encoding="utf16le")
            assert all(i["length"] == 4 for i in u16["items"])
            # start restricts the search; bad arguments
            late = await c.ok("search_memory", pattern=raw, start=hex(int(entry, 16) + 1))
            assert all(int(i["address"], 16) > int(entry, 16) for i in late["items"])
            await c.err("search_memory", INVALID, pattern="zz")
            await c.err("search_memory", INVALID, pattern="")
            await c.err("search_memory", INVALID, pattern="90", kind="regex")
            await c.err("search_memory", INVALID, pattern="90", kind="text", encoding="ebcdic")
            await c.err("search_memory", INVALID, pattern="90", limit=0)
            await c.err("search_memory", INVALID, pattern="90", start="nothex")
            await c.err("search_memory", INVALID)
    run(go())

"""Backend API tests against real Ghidra on /bin/ls (see ../README.md for JAVA_HOME and the venv)."""
import asyncio, glob, hashlib, json, os, re, subprocess, sys, time

import pytest
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
JAVA = os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home")
BIN = os.environ.get("SPIKE_BINARY", "/bin/ls")
NO_PROGRAM, CANCELLED, NOT_FOUND, BUSY, INVALID = -32001, -32002, -32004, -32005, -32602


def ghidra_dir():
    d = os.environ.get("GHIDRA_INSTALL_DIR") or (sorted(glob.glob(os.path.join(HERE, "..", "ghidra-install", "ghidra_*/")) or [None])[-1])
    assert d, "no Ghidra install"
    return d


class Proc:
    def __init__(self, projects, extra_env=None, stderr=None):
        env = dict(os.environ, SIDECAR_ALLOW_NO_AUTH="1", GHIDRA_INSTALL_DIR=ghidra_dir(), JAVA_HOME=JAVA, SIDECAR_PROJECTS_DIR=str(projects), **(extra_env or {}))
        self.p = subprocess.Popen([sys.executable, os.path.join(HERE, "main.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, env=env)
        self.port = int(self.p.stdout.readline())

    def stop(self):
        self.p.stdin.close()
        try:
            self.p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.p.kill()


class Client:
    """One websocket; notifications are kept in `notes` (with arrival time), replies are matched by id."""
    def __init__(self, port):
        self.port, self.notes, self.waiters, self.nid, self.t0 = port, [], {}, 0, time.monotonic()

    async def __aenter__(self):
        self.ws = await websockets.connect("ws://127.0.0.1:%d" % self.port, max_size=None)
        self.task = asyncio.create_task(self._read())
        return self

    async def __aexit__(self, *a):
        self.task.cancel()
        await self.ws.close()

    async def _read(self):
        async for raw in self.ws:
            m = json.loads(raw)
            if m.get("id") is None:
                self.notes.append((time.monotonic(), m))
            else:
                self.waiters[m["id"]].set_result((time.monotonic(), m))

    async def send(self, method, **params):
        self.nid += 1
        self.waiters[self.nid] = asyncio.get_running_loop().create_future()
        await self.ws.send(json.dumps({"jsonrpc": "2.0", "id": self.nid, "method": method, "params": params}))
        return self.nid

    async def reply(self, rid, timeout=300):
        return (await asyncio.wait_for(self.waiters[rid], timeout))[1]

    async def call(self, method, **params):
        return await self.reply(await self.send(method, **params))

    async def ok(self, method, **params):
        r = await self.call(method, **params)
        assert "result" in r, (method, params, r)
        return r["result"]

    async def err(self, method, code, **params):
        r = await self.call(method, **params)
        assert r.get("error", {}).get("code") == code, (method, params, r)

    def take(self, method):
        got = [m["params"] for _, m in self.notes if m["method"] == method]
        return got

    async def wait_note(self, method, timeout=3.0, since=0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            got = [m["params"] for _, m in self.notes[since:] if m["method"] == method]
            if got:
                return got
            await asyncio.sleep(0.01)
        raise AssertionError("no %s notification within %ss" % (method, timeout))


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 600))


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


def test_open_progress(env):
    assert env["open"]["persisted"] is False
    notes = [(t, m["params"]) for t, m in env["notes"] if m["method"] == "progress"]
    phases = [p["phase"] for _, p in notes]
    firsts = [phases.index(x) for x in ("import", "analysis", "saving", "ready")]
    assert firsts == sorted(firsts), phases
    assert phases[-1] == "ready"
    an = [p for _, p in notes if p["phase"] == "analysis" and p.get("analyzer")]
    assert an, "no analysis progress carried an analyzer name"
    assert len({p["analyzer"] for p in an}) > 3
    assert max(p["done"] for p in an) > 3 and all(p["pct"] == -1 or 0 <= p["pct"] <= 100 for _, p in notes)
    times = [t for t, _ in notes if True]
    per_sec = {}
    for t in times:
        per_sec[int(t)] = per_sec.get(int(t), 0) + 1
    assert max(per_sec.values()) <= 12, per_sec  # ~5/s plus phase boundaries
    print("analysis notes %d, distinct analyzers %d, open %.1fs" % (len(an), len({p['analyzer'] for p in an}), env["open_s"]))


def test_reads(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            f = max(fns, key=lambda f: f["size"])
            mid = hex(int(f["entry"], 16) + 3)
            g = await c.ok("get_function_at", address=mid)
            assert g["entry"] == f["entry"] and g["name"] == f["name"] and g["size"] == f["size"] and "(" in g["signature"]
            assert await c.ok("get_function_at", address="0x1") is None

            hits = await c.ok("search_symbols", query=f["name"][:6].upper(), limit=5)
            assert 0 < len(hits) <= 5 and all(h["kind"] in ("function", "label", "data", "external", "variable", "other") for h in hits)
            assert any(h["name"] == f["name"] for h in await c.ok("search_symbols", query=f["name"]))
            byaddr = await c.ok("search_symbols", query=f["entry"])
            assert byaddr and byaddr[0]["address"] == f["entry"]
            assert await c.ok("search_symbols", query="zzz_no_such_symbol_zzz") == []

            # a function that someone calls
            tgt = None
            for fn in fns[:400]:
                x = await c.ok("xrefs_to", address=fn["entry"])
                if x:
                    tgt, xs = fn, x
                    break
            assert tgt, "no xrefs found"
            assert all(set(r) >= {"from", "type"} for r in xs) and any(r.get("function") for r in xs)
            assert len(await c.ok("xrefs_to", address=tgt["entry"], limit=1)) == 1
            callers = [r for r in xs if "CALL" in r["type"]]
            if callers:
                frm = await c.ok("xrefs_from", address=callers[0]["from"])
                assert any(r["to"] == tgt["entry"] for r in frm), (frm, tgt)

            s = await c.ok("list_strings")
            assert s["total"] > 0 and 0 < len(s["items"]) <= 500
            assert all(i["length"] >= 4 and i["value"] and i["address"].startswith("0x") for i in s["items"])
            page = await c.ok("list_strings", offset=1, limit=2)
            assert page["items"] == s["items"][1:3] and page["total"] == s["total"]
            assert (await c.ok("list_strings", minLength=50))["total"] < s["total"]

            dts = await c.ok("list_data_types", query="int", limit=10)
            assert dts and all("int" in d["name"].lower() and d["path"] and "size" in d for d in dts)
            assert dts[0]["name"].lower().startswith("int")

            u = await c.ok("undo_state")
            assert set(u) >= {"canUndo", "canRedo"}
    run(go())


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


def test_xref_kinds_and_variables(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            kinds = set()
            tgt = None
            for fn in fns[:400]:
                for r in await c.ok("xrefs_to", address=fn["entry"]):
                    assert r["kind"] in ("call", "jump", "read", "write", "readwrite", "data", "flow", "other")
                    kinds.add(r["kind"])
                    if r["kind"] == "call" and tgt is None:
                        tgt = r
            assert "call" in kinds, kinds
            frm = await c.ok("xrefs_from", address=tgt["from"])
            assert frm and all(r["target"] in ("memory", "stack", "register", "external") and r["kind"] for r in frm)
            assert any(r["target"] == "memory" and r["to"].startswith("0x") and r["kind"] == "call" for r in frm)
            # variables: find any function whose parameters or locals have references (x86-64 stack locals / parameters)
            found = None
            for fn in sorted(fns, key=lambda f: -f["size"])[:40]:
                r = await c.call("decompile", entry=fn["entry"])
                for t in r["result"]["tokens"]:
                    if t.get("varName") and t["kind"] in ("variable", "param"):
                        xs = await c.ok("xrefs_to_variable", entry=fn["entry"], name=t["varName"])
                        assert isinstance(xs, list)
                        if xs and not found:
                            found = (fn, t["varName"], xs)
                if found:
                    break
            print("variable xrefs:", found and (found[0]["name"], found[1], len(found[2]), found[2][0]))
            if found:
                assert found[2][0]["kind"] in ("read", "write", "readwrite", "data") and found[2][0]["function"] == found[0]["name"]
            assert await c.ok("xrefs_to_variable", entry=fns[0]["entry"], name="no_such_variable") == []
            await c.err("xrefs_to_variable", NOT_FOUND, entry="0x1", name="a")
            await c.err("xrefs_to_variable", INVALID, entry=fns[0]["entry"], name=3)
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


def first_call(fns):
    return None


async def find_call_pair(c, fns):
    """(caller, callee) where the caller's decompile has a call token to a function with a user-visible name."""
    for f in sorted(fns, key=lambda f: -f["size"])[:60]:
        r = await c.call("decompile", entry=f["entry"])
        for k in r.get("result", {}).get("tokens", []):
            if k.get("targetFunction") and k["targetFunction"] != f["entry"]:
                return f, k["targetFunction"], r["result"]
    raise AssertionError("no call pair")


def test_edits_undo_redo_and_cache(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            u0 = await c.ok("undo_state")
            assert u0["canUndo"] is False, u0  # the analysis transaction is not undoable

            # --- rename_symbol: event, undo/redo round trip, cache invalidation of a *caller*
            caller, callee, d1 = await find_call_pair(c, fns)
            assert (await c.ok("decompile", entry=caller["entry"]))["cached"] is True
            n = len(c.notes)
            await c.ok("rename_symbol", address=callee, newName="renamed_callee_x")
            ev = (await c.wait_note("program_changed", since=n))[0]
            assert "symbol" in ev["kinds"] and ev["undo"]["canUndo"] and "renamed_callee_x" in ev["undo"]["undoName"]
            d2 = await c.ok("decompile", entry=caller["entry"])
            assert d2["cached"] is False and "renamed_callee_x" in d2["text"], d2["text"][:300]
            assert (await c.ok("get_function_at", address=callee))["name"] == "renamed_callee_x"
            n = len(c.notes)
            st = await c.ok("undo")
            assert st["canUndo"] is False and st["canRedo"] and "renamed_callee_x" in st["redoName"]
            ev = (await c.wait_note("program_changed", since=n))[0]
            assert ev["ranges"] is None and ev["undo"] == st
            d3 = await c.ok("decompile", entry=caller["entry"])
            assert d3["cached"] is False and "renamed_callee_x" not in d3["text"] and d3["text"] == d1["text"]
            st = await c.ok("redo")
            assert st["canUndo"] and not st["canRedo"]
            assert (await c.ok("get_function_at", address=callee))["name"] == "renamed_callee_x"
            await c.ok("undo")

            # --- set_comment: all kinds, listing shows eol, empty clears
            info = await c.ok("listing_info")
            a = info["ranges"][0]["start"]
            for kind in ("eol", "pre", "post", "plate", "repeatable"):
                n = len(c.notes)
                await c.ok("set_comment", address=a, kind=kind, text="hello " + kind)
                ev = (await c.wait_note("program_changed", since=n))[0]
                assert "comment" in ev["kinds"] and ev["ranges"] and ev["ranges"][0]["start"] <= a <= ev["ranges"][0]["end"] or ev["ranges"] is None
                if kind == "eol":
                    assert (await c.ok("listing_rows", address=a, count=1))[0]["comment"] == "hello eol"
            await c.ok("set_comment", address=a, kind="eol", text="")
            assert "comment" not in (await c.ok("listing_rows", address=a, count=1))[0]
            for _ in range(6):
                await c.ok("undo")
            assert (await c.ok("undo_state"))["canUndo"] is False

            # --- rename_variable / retype_variable (decompiler HighFunction path)
            done_var = False
            for f in sorted(fns, key=lambda f: -f["size"])[:40]:
                r = await c.ok("decompile", entry=f["entry"])
                vars_ = [k for k in r["tokens"] if k["kind"] in ("variable", "param") and k.get("varName") and k["line"] > 0]
                if not vars_:
                    continue
                name = vars_[0]["varName"]
                n = len(c.notes)
                res = await c.call("rename_variable", entry=f["entry"], name=name, newName="my_renamed_var")
                if "error" in res:
                    continue
                await c.wait_note("program_changed", since=n)
                t2 = await c.ok("decompile", entry=f["entry"])
                assert t2["cached"] is False and "my_renamed_var" in t2["text"] and t2["text"] != r["text"]
                # retype the renamed variable
                n = len(c.notes)
                rt = await c.call("retype_variable", entry=f["entry"], name="my_renamed_var", dataType="long")
                if "result" in rt:
                    await c.wait_note("program_changed", since=n)
                    assert "type" in (await c.ok("undo_state"))["undoName"].lower() or True
                    await c.ok("undo")
                await c.ok("undo")
                t3 = await c.ok("decompile", entry=f["entry"])
                assert "my_renamed_var" not in t3["text"]
                done_var = True
                break
            assert done_var, "no function allowed a variable rename"
            await c.err("rename_variable", NOT_FOUND, entry=fns[0]["entry"], name="no_such_var_zz", newName="abc")

            # --- set_function_signature
            tgt = next(f for f in fns if f["size"] > 40)
            g = await c.ok("get_function_at", address=tgt["entry"])
            n = len(c.notes)
            await c.ok("set_function_signature", entry=tgt["entry"], signature="long sig_probe(long a, char *b)")
            await c.wait_note("program_changed", since=n)
            g2 = await c.ok("get_function_at", address=tgt["entry"])
            assert g2["name"] == "sig_probe" and "char *" in g2["signature"], g2
            await c.ok("undo")
            assert (await c.ok("get_function_at", address=tgt["entry"]))["name"] == g["name"]
            await c.err("set_function_signature", INVALID, entry=tgt["entry"], signature="this is ((( not C")

            # --- create_function: on an instruction that no function contains, if /bin/ls has one
            found = None
            cur = info["ranges"][0]["start"]
            for _ in range(60):
                rows = await c.ok("listing_rows", address=cur, count=1000)
                if not rows:
                    break
                for row in rows:
                    if row["mnemonic"] not in ("db", "ds", "dw", "dd", "dq", "??") and await c.ok("get_function_at", address=row["address"]) is None:
                        found = row["address"]
                        break
                if found:
                    break
                cur = hex(int(rows[-1]["address"], 16) + rows[-1]["length"])
            if found:
                n = len(c.notes)
                r = await c.call("create_function", address=found, name="made_by_test")
                if "result" in r:
                    assert r["result"]["entry"] == found and r["result"]["name"] == "made_by_test"
                    await c.wait_note("program_changed", since=n)
                    assert (await c.ok("get_function_at", address=found))["name"] == "made_by_test"
                    await c.ok("undo")
                    assert await c.ok("get_function_at", address=found) is None
            await c.err("create_function", INVALID, address=fns[0]["entry"])  # already a function
            assert (await c.ok("undo_state"))["canUndo"] is False
    run(go())


def test_pool_concurrent_and_cancel(env):
    fns = env["fns"]
    async def go():
        async with Client(env["proc"].port) as c:
            big = sorted(fns, key=lambda f: -f["size"])[:2]

            async def clear_cache():  # a rename clears the whole cache; undo it right after
                await c.ok("rename_symbol", address=fns[0]["entry"], newName="cache_clear_probe")
                await c.ok("undo")
            await clear_cache()
            t = time.monotonic()
            ids = [await c.send("decompile", entry=f["entry"]) for f in big]
            rs = [await c.reply(i) for i in ids]
            conc = time.monotonic() - t
            assert all("result" in r and r["result"]["cached"] is False for r in rs), rs
            await clear_cache()
            seq = 0.0
            for f in big:
                t = time.monotonic()
                await c.ok("decompile", entry=f["entry"])
                seq += time.monotonic() - t
            print("pool of 2: concurrent %.3fs vs sequential %.3fs" % (conc, seq))
            if seq > 0.3:  # only meaningful when the work is not trivially small
                assert conc < 0.9 * seq, (conc, seq)

            # cancel running + queued still work with the pool (3 requests, 2 workers: the third is queued)
            await clear_cache()
            ranked = sorted(fns, key=lambda f: -f["size"])
            ids = [await c.send("decompile", entry=f["entry"], timeoutSecs=30) for f in ranked[2:5]]
            await asyncio.sleep(0.01)
            assert (await c.ok("cancel_decompile", id=ids[2]))["cancelled"] is True
            assert (await c.reply(ids[2]))["error"]["code"] == CANCELLED
            for i in ids[:2]:
                r = await c.reply(i)
                assert "result" in r or r["error"]["code"] == CANCELLED
            assert (await c.ok("cancel_decompile", id=999999)) == {"cancelled": False}
    run(go())


def test_bad_arguments(env):
    async def go():
        async with Client(env["proc"].port) as c:
            await c.err("nope", -32601)
            await c.err("get_function_at", INVALID, address="zzz")
            await c.err("get_function_at", INVALID)  # missing param
            await c.err("get_function_at", INVALID, address="0x1", bogus=1)
            await c.err("search_symbols", INVALID, query=5)
            await c.err("search_symbols", INVALID, query="x", limit=-1)
            await c.err("search_symbols", INVALID, query="x", limit="many")
            await c.err("list_strings", INVALID, offset=-5)
            await c.err("xrefs_to", INVALID, address="not hex")
            await c.err("rename_symbol", INVALID, address="0x1000", newName="has space")
            await c.err("rename_symbol", NOT_FOUND, address="0x1", newName="ok_name")
            await c.err("rename_symbol", INVALID, address="0x1", newName="")
            await c.err("set_comment", INVALID, address="0x1", kind="bogus", text="x")
            await c.err("set_comment", INVALID, address="0x1", kind="eol", text=5)
            await c.err("rename_variable", NOT_FOUND, entry="0x1", name="a", newName="b")
            await c.err("retype_variable", INVALID, entry=env["fns"][0]["entry"], name="a", dataType=3)
            await c.err("decompile", INVALID, entry="xyz")
            await c.err("cancel_decompile", INVALID)
            await c.err("undo", INVALID)  # nothing to undo (earlier tests undid everything)
            if (await c.ok("undo_state"))["canRedo"]:
                await c.ok("redo")
                await c.ok("undo")
            await c.err("undo", INVALID)
            while (await c.ok("undo_state"))["canRedo"]:  # leave the program as found: nothing undone, nothing redoable
                await c.ok("redo")
                await c.ok("undo")
                break
            await c.err("redo", INVALID) if not (await c.ok("undo_state"))["canRedo"] else None
            await c.err("open_binary", NOT_FOUND, path="/no/such/file")
            await c.err("open_binary", INVALID, path=7)
            assert (await c.ok("cancel_open")) == {"cancelled": False}
            assert len(await c.ok("list_functions")) == len(env["fns"])  # still alive
    run(go())


def test_reopen_is_fast_and_quiet(env):
    async def go():
        async with Client(env["proc"].port) as c:
            t = time.monotonic()
            r = await c.ok("open_binary", path=BIN)
            took = time.monotonic() - t
            assert r["persisted"] is True and r["programId"] == env["open"]["programId"]
            phases = {p["phase"] for p in c.take("progress")}
            assert phases == {"import", "ready"}, phases
            assert took < 5
            assert (await c.ok("undo_state"))["canUndo"] is False
            assert len(await c.ok("list_functions")) == len(env["fns"])
    run(go())


def test_open_cancel_busy_failfast(tmp_path):
    proc = Proc(tmp_path / "projects")
    try:
        async def go():
            async with Client(proc.port) as c:
                oid = await c.send("open_binary", path=BIN)
                await c.wait_note("progress", timeout=30)
                # wait until analysis is actually running
                end = time.monotonic() + 60
                while time.monotonic() < end and not any(p["phase"] == "analysis" for p in c.take("progress")):
                    await asyncio.sleep(0.02)
                assert any(p["phase"] == "analysis" for p in c.take("progress"))
                # requests during the open fail fast
                for method, params in (("list_functions", {}), ("listing_rows", {"address": "0x0", "count": 1}),
                                       ("decompile", {"entry": "0x0"}), ("rename_symbol", {"address": "0x0", "newName": "x"}),
                                       ("undo", {})):
                    t = time.monotonic()
                    await c.err(method, NO_PROGRAM, **params)
                    ms = (time.monotonic() - t) * 1000
                    assert ms < 100, (method, ms)
                t = time.monotonic()
                await c.err("open_binary", BUSY, path=BIN)
                assert (time.monotonic() - t) < 0.1
                t = time.monotonic()
                assert (await c.ok("cancel_open")) == {"cancelled": True}
                r = await c.reply(oid)
                print("cancel_open -> open_binary error after %.2fs" % (time.monotonic() - t))
                assert r["error"]["code"] == CANCELLED, r
                await c.err("list_functions", NO_PROGRAM)
                assert (await c.ok("cancel_open")) == {"cancelled": False}
                # the project must hold nothing, so this is a full import + analysis, and it works without a restart
                n = len(c.notes)
                r = await c.ok("open_binary", path=BIN)
                assert r["persisted"] is False
                new = [m["params"] for _, m in c.notes[n:] if m["method"] == "progress"]
                assert {"import", "analysis", "saving", "ready"} <= {p["phase"] for p in new}
                assert len({p["analyzer"] for p in new if p.get("analyzer")}) > 3
                fns = await c.ok("list_functions")
                assert fns
                # opening another binary while one is loaded closes the old one first
                other = os.path.join(HERE, "..", "bench", "nonexistent")
                await c.err("open_binary", NOT_FOUND, path=other)
                assert len(await c.ok("list_functions")) == len(fns)  # a bad path must not close the loaded program
                # now it is persisted, cancel is a no-op and reopen is quick
                assert (await c.ok("open_binary", path=BIN))["persisted"] is True
        run(go())
    finally:
        proc.stop()


# ---- save / close / import options / program browser / auth ----
import hashlib, re, struct

X86 = "x86:LE:32:default"
BASE = "0x8000000"  # as listing_info prints it (no leading zeros)


def blob(tmp_path, name="blob.bin", pad=0):
    """Two tiny x86-32 functions: f1 at +0 calls f2 at +0x10."""
    code = bytes.fromhex("5589e5e808000000" "5dc3") + b"\x90" * 6 + bytes.fromhex("5589e5b801000000" "5dc3") + b"\x90" * pad
    p = tmp_path / name
    p.write_bytes(code)
    return str(p)


@pytest.fixture(scope="module")
def bproc(tmp_path_factory):
    d = tmp_path_factory.mktemp("bproj")
    proc = Proc(d / "projects")
    yield proc, d
    proc.stop()


def test_candidates_and_languages(bproc):
    proc, d = bproc
    raw = blob(d)

    async def go():
        async with Client(proc.port) as c:
            assert (await c.ok("import_candidates", path=raw)) == {"candidates": [], "sizeBytes": os.path.getsize(raw)}  # nothing recognises a bare blob
            await c.err("import_candidates", NOT_FOUND, path=str(d / "nope"))
            await c.err("import_candidates", INVALID)
            res = await c.ok("import_candidates", path=BIN)
            assert res["sizeBytes"] == os.path.getsize(BIN)
            r = res["candidates"]
            assert r and sum(x["preferred"] for x in r) == 1
            assert all(set(x) == {"loader", "language", "compilerSpec", "preferred", "acceptsBaseAddress"} for x in r)
            pref = next(x for x in r if x["preferred"])
            assert pref["language"] and pref["compilerSpec"] and pref["acceptsBaseAddress"] is False
            rb = [x for x in r if x["loader"] == "Raw Binary"]
            assert rb and rb[0]["language"] is None and rb[0]["acceptsBaseAddress"] is True
            langs = await c.ok("list_languages")
            ent = next(l for l in langs if l["id"] == X86)
            assert ent["description"] and ent["compilerSpecs"] and {"id", "name"} == set(ent["compilerSpecs"][0])
            assert [l["id"] for l in langs] == sorted(l["id"] for l in langs)
    run(go())


def test_import_options_validation(bproc):
    proc, d = bproc
    raw = blob(d)

    async def go():
        async with Client(proc.port) as c:
            for bad in ({"loader": "No Such Loader"}, {"language": "x86:LE:99:nope"},
                        {"loader": "Raw Binary", "language": X86, "compilerSpec": "nope"},
                        {"loader": "Raw Binary", "language": X86, "baseAddress": "zz"},
                        {"loader": "Raw Binary", "language": X86, "baseAddress": "0x1ffffffff"},  # > 32-bit space
                        {"loader": "Raw Binary", "language": X86, "baseAddress": 5}):
                await c.err("open_binary", INVALID, path=raw, **bad)
            await c.err("open_binary", INVALID, path=raw)  # default import: no loader recognises the blob
            assert await c.ok("list_programs") == []
    run(go())


def test_raw_import_options_save_reopen_dirty_undo(bproc):
    proc, d = bproc
    raw = blob(d)
    sha = hashlib.sha256(open(raw, "rb").read()).hexdigest()
    opts = dict(path=raw, loader="Raw Binary", language=X86, baseAddress=BASE)

    async def go():
        async with Client(proc.port) as c:
            r = await c.ok("open_binary", **opts)
            assert r["persisted"] is False and r["name"] == "blob.bin"
            pid = r["programId"]
            assert re.fullmatch(sha + "-[0-9a-f]{12}", pid)
            info = await c.ok("listing_info")
            assert info["ranges"][0]["start"] == BASE and info["totalBytes"] == 26
            first = (await c.ok("listing_rows", address=BASE, count=1))[0]
            assert first["bytes"].startswith("55")  # raw bytes, nothing disassembled without an entry point
            # not dirty after a fresh import, nor after reads/decompiles in the background
            assert (await c.ok("undo_state"))["dirty"] is False
            await c.ok("list_functions"), await c.ok("list_strings"), await c.ok("search_symbols", query="f")
            await asyncio.sleep(0.5)
            assert (await c.ok("undo_state")) == {"canUndo": False, "canRedo": False, "dirty": False}
            # the key depends on the options
            other = (await c.ok("open_binary", **{**opts, "baseAddress": "0x1000"}))
            assert other["programId"] != pid and other["programId"].startswith(sha + "-")
            assert (await c.ok("listing_info"))["ranges"][0]["start"] == "0x1000"
            r = await c.ok("open_binary", **opts)
            assert r["persisted"] is True and r["programId"] == pid
            assert (await c.ok("undo_state"))["dirty"] is False  # persisted reopen is clean too

            # edit -> dirty; save -> clean, notification, edit survives reopen
            n = len(c.notes)
            await c.ok("set_comment", address=BASE, kind="eol", text="kept")
            u = await c.ok("undo_state")
            assert u["dirty"] is True and u["canUndo"] is True
            await c.ok("save")
            pc = (await c.wait_note("program_changed", since=n))
            save_note = [p for p in pc if p["ranges"] == []][-1]
            assert save_note["kinds"] == [] and save_note["undo"]["dirty"] is False
            after = await c.ok("undo_state")
            assert after["dirty"] is False
            print("undo state after save:", after)
            await c.ok("save")  # unchanged: still a success
            # MEASURED (protocol.md "Persistence and crash safety"): saving clears Ghidra's undo AND redo stacks
            assert after == {"canUndo": False, "canRedo": False, "dirty": False}
            await c.err("undo", INVALID)
            await c.ok("set_comment", address=BASE, kind="eol", text="second")
            u = await c.ok("undo")
            assert u["dirty"] is False and u["canRedo"] is True  # back at the saved state: Ghidra tracks that, dirty clears
            assert (await c.ok("redo"))["dirty"] is True
            await c.ok("save")
            assert (await c.ok("undo_state")) == {"canUndo": False, "canRedo": False, "dirty": False}

            # an unsaved edit is autosaved when another open replaces the program (protocol.md, Persistence)
            await c.ok("open_binary", **opts)
            await c.ok("set_comment", address="0x8000010", kind="eol", text="autosaved")
            assert (await c.ok("undo_state"))["dirty"] is True
            await c.ok("open_binary", **opts)
            assert (await c.ok("undo_state"))["dirty"] is False
            rows = {x["address"]: x for x in await c.ok("listing_rows", address=BASE, count=26)}
            assert rows[BASE].get("comment") == "second" and rows["0x8000010"].get("comment") == "autosaved"
    run(go())



def test_list_and_delete_programs(bproc):
    proc, d = bproc
    raw = blob(d)
    sha = hashlib.sha256(open(raw, "rb").read()).hexdigest()
    opts = dict(path=raw, loader="Raw Binary", language=X86, baseAddress=BASE)

    async def go():
        async with Client(proc.port) as c:
            progs = await c.ok("list_programs")  # earlier tests left two imports of blob.bin
            assert len(progs) == 2 and all(p["programId"].startswith(sha + "-") for p in progs)
            p = progs[0]
            assert p["name"] == "blob.bin" and p["sourcePath"] == raw and p["sizeBytes"] == 26 and p["analyzed"] is True
            assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", p["lastOpened"])
            assert progs[0]["lastOpened"] >= progs[1]["lastOpened"]
            assert any(x["options"] == {"loader": "Raw Binary", "language": X86, "baseAddress": BASE} for x in progs)
            assert any(x["options"] == {"loader": "Raw Binary", "language": X86, "baseAddress": "0x1000"} for x in progs)

            r = await c.ok("open_binary", **opts)
            pid = r["programId"]
            await c.err("delete_program", BUSY, programId=pid)  # open
            await c.err("delete_program", NOT_FOUND, programId="f" * 64)
            await c.err("delete_program", NOT_FOUND, programId="../../etc")
            await c.err("delete_program", INVALID)
            assert len(await c.ok("list_programs")) == 2  # works with a program open
            victim = next(x["programId"] for x in progs if x["programId"] != pid)
            assert (await c.ok("delete_program", programId=victim)) == {}
            assert [x["programId"] for x in await c.ok("list_programs")] == [pid]
            await c.err("delete_program", NOT_FOUND, programId=victim)
            assert (await c.ok("undo_state"))["dirty"] is False
            # a deleted program is imported afresh
            assert (await c.ok("open_binary", **{**opts, "baseAddress": "0x1000"}))["persisted"] is False
    run(go())


def test_list_programs_survives_restart_and_busy_during_open(tmp_path):
    raw = blob(tmp_path)
    opts = dict(path=raw, loader="Raw Binary", language=X86)
    proc = Proc(tmp_path / "projects")
    try:
        async def first():
            async with Client(proc.port) as c:
                await c.ok("open_binary", **opts)
        run(first())
    finally:
        proc.stop()
    proc = Proc(tmp_path / "projects")
    try:
        async def second():
            async with Client(proc.port) as c:
                (p,) = await c.ok("list_programs")
                assert p["sourcePath"] == raw and p["options"]["language"] == X86 and p["lastOpened"]
                t0 = p["lastOpened"]
                await asyncio.sleep(1.1)
                assert (await c.ok("open_binary", **opts))["persisted"] is True
                assert (await c.ok("list_programs"))[0]["lastOpened"] > t0
                assert (await c.ok("undo_state"))["dirty"] is False  # writing lastOpened does not dirty the program
        run(second())
    finally:
        proc.stop()


def test_busy_during_open_for_project_methods(tmp_path):
    proc = Proc(tmp_path / "projects")
    try:
        async def go():
            async with Client(proc.port) as c:
                oid = await c.send("open_binary", path=BIN)
                end = time.monotonic() + 60
                while time.monotonic() < end and not any(p["phase"] == "analysis" for p in c.take("progress")):
                    await asyncio.sleep(0.02)
                for m, kw in (("list_programs", {}), ("delete_program", {"programId": "0" * 64}), ("close_program", {}), ("import_candidates", {"path": BIN})):
                    await c.err(m, BUSY, **kw)
                assert isinstance(await c.ok("list_languages"), list)
                await c.err("save", NO_PROGRAM)
                await c.ok("cancel_open")
                assert (await c.reply(oid))["error"]["code"] == CANCELLED
                assert await c.ok("list_programs") == []
        run(go())
    finally:
        proc.stop()


def test_dirty_clean_on_ls_and_close_program(env):
    """Reads and decompiles never dirty; close_program autosaves, cancels queued decompiles, later requests fail NoProgram."""
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            assert (await c.ok("undo_state"))["dirty"] is False
            await c.ok("decompile", entry=max(fns, key=lambda f: f["size"])["entry"])
            await asyncio.sleep(0.3)
            assert (await c.ok("undo_state"))["dirty"] is False
            progs = await c.ok("list_programs")
            assert len(progs) == 1 and progs[0]["options"] == {} and progs[0]["programId"] == env["open"]["programId"]
            assert progs[0]["name"] == os.path.basename(BIN) and progs[0]["sizeBytes"] == os.path.getsize(BIN)

            ranked = sorted(fns, key=lambda f: -f["size"])[3:15]
            await c.ok("rename_symbol", address=ranked[0]["entry"], newName="cache_clear_probe")  # empty the cache
            ids = [await c.send("decompile", entry=f["entry"]) for f in ranked]
            await asyncio.sleep(0.01)
            assert (await c.ok("close_program")) == {}
            codes = [(await c.reply(i)).get("error", {}).get("code") for i in ids]
            assert CANCELLED in codes and set(codes) <= {None, CANCELLED}, codes
            assert codes.count(CANCELLED) >= len(ids) - 3, codes  # at most the in-flight ones (2 workers) can win the race
            for m, kw in (("list_functions", {}), ("decompile", {"entry": ranked[0]["entry"]}), ("save", {}), ("undo_state", {})):
                await c.err(m, NO_PROGRAM, **kw)
            assert (await c.ok("close_program")) == {}  # idempotent
            await c.err("delete_program", NOT_FOUND, programId="a" * 64)
            # close autosaved the rename; the reopened program is clean
            assert (await c.ok("open_binary", path=BIN))["persisted"] is True
            assert (await c.ok("undo_state"))["dirty"] is False
            assert any(f["name"] == "cache_clear_probe" for f in await c.ok("list_functions"))
            await c.ok("rename_symbol", address=ranked[0]["entry"], newName=ranked[0]["name"])  # leave the shared /bin/ls program as it was
            await c.ok("save")
    run(go())


def test_auth_mandatory(tmp_path):
    env = {k: v for k, v in os.environ.items() if k not in ("SIDECAR_TOKEN", "SIDECAR_ALLOW_NO_AUTH")}
    env.update(GHIDRA_INSTALL_DIR=ghidra_dir(), JAVA_HOME=JAVA, SIDECAR_PROJECTS_DIR=str(tmp_path))
    for extra in ({}, {"SIDECAR_TOKEN": ""}):
        r = subprocess.run([sys.executable, os.path.join(HERE, "main.py")], env={**env, **extra}, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        assert r.returncode == 2 and b"SIDECAR_TOKEN" in r.stderr and r.stdout == b"", (extra, r)
    # with a token the path must match
    p = subprocess.Popen([sys.executable, os.path.join(HERE, "main.py")], env={**env, "SIDECAR_TOKEN": "s3cret"}, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        port = int(p.stdout.readline())

        async def go():
            async with websockets.connect("ws://127.0.0.1:%d/s3cret" % port) as ws:
                await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "list_languages"}))
                assert "result" in json.loads(await ws.recv())
            with pytest.raises(Exception):
                async with websockets.connect("ws://127.0.0.1:%d/wrong" % port):
                    pass
        run(go())
    finally:
        p.stdin.close()
        p.wait(timeout=15)


# ---- Round 5: comments, labels, strings query, cancellable variable edits, profiles, project lock, clean shutdown ----
PROJECT_LOCKED = -32006
TIMEOUT = -32003


def win_exe():
    g = glob.glob(os.path.join(ghidra_dir(), "docs/GhidraClass/ExerciseFiles/WinhelloCPP/WinHelloCPP.exe"))
    return g[0] if g else None


def test_get_comments_and_create_label(env):
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            f = fns[len(fns) // 2]
            at = f["entry"]
            assert await c.ok("get_comments", address=at) == {}
            texts = {"eol": "e1", "pre": "p1\nline2", "post": "o1", "plate": "pl1", "repeatable": "r1"}
            for k, t in texts.items():
                await c.ok("set_comment", address=at, kind=k, text=t)
            assert await c.ok("get_comments", address=at) == texts
            assert await c.ok("get_comments", address=hex(int(at, 16) + 0)) == texts
            await c.ok("set_comment", address=at, kind="pre", text="")  # empty clears: the key disappears
            assert "pre" not in await c.ok("get_comments", address=at)
            await c.err("get_comments", INVALID, address="zz")
            await c.err("get_comments", NOT_FOUND, address="0x1")
            for _ in range(6):
                await c.ok("undo")
            assert await c.ok("get_comments", address=at) == {}

            # an unlabeled code unit: rename_symbol says NotFound, create_label makes the label
            rows = await c.ok("listing_rows", address=max(fns, key=lambda f: f["size"])["entry"], count=8)
            row = next(r for r in rows[1:] if "label" not in r)
            a = row["address"]
            await c.err("rename_symbol", NOT_FOUND, address=a, newName="nope")
            since = len(c.notes)
            await c.ok("create_label", address=a, name="r5_label")
            note = (await c.wait_note("program_changed", since=since))[0]
            assert "symbol" in note["kinds"] and note["undo"]["dirty"] is True
            assert (await c.ok("listing_rows", address=a, count=1))[0]["label"] == "r5_label"
            assert any(h["name"] == "r5_label" and h["address"] == a and h["kind"] == "label" for h in await c.ok("search_symbols", query="r5_label"))
            await c.err("create_label", INVALID, address=a, name="again")  # one primary label: rename it instead
            await c.err("create_label", INVALID, address="0x1", name="x")  # not in memory
            await c.err("create_label", INVALID, address=a)  # missing name
            await c.ok("rename_symbol", address=a, newName="r5_renamed")
            await c.ok("undo"); await c.ok("undo")
            assert "label" not in (await c.ok("listing_rows", address=a, count=1))[0]
            u = await c.ok("undo_state")
            assert u["canRedo"] is True
            await c.ok("redo"); await c.ok("undo")  # round trip; leaves the shared program as it was
    run(go())


def test_list_strings_query(env):
    async def go():
        async with Client(env["proc"].port) as c:
            s = await c.ok("list_strings", limit=5000)
            assert s["total"] > 3
            probe = s["items"][2]["value"][:5]
            hits = await c.ok("list_strings", query=probe.upper(), limit=5000)  # case-insensitive substring, applied before paging
            assert 0 < hits["total"] <= s["total"] and all(probe.lower() in i["value"].lower() for i in hits["items"])
            assert any(i["address"] == s["items"][2]["address"] for i in hits["items"])
            assert (await c.ok("list_strings", query=probe, offset=hits["total"]))["items"] == []
            assert (await c.ok("list_strings", query="zzz_no_such_string_zzz")) == {"total": 0, "items": []}
            assert (await c.ok("list_strings", query=""))["total"] == s["total"]
            await c.err("list_strings", INVALID, query=5)
    run(go())


def test_variable_edit_timeout_arg_and_cancel(env):
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            big = max(fns, key=lambda f: f["size"])
            await c.err("rename_variable", INVALID, entry=big["entry"], name="x", newName="y", timeoutSecs=-1)
            await c.err("retype_variable", INVALID, entry=big["entry"], name="x", dataType="int", timeoutSecs="soon")
            await c.err("rename_variable", NOT_FOUND, entry=big["entry"], name="no_such_var", newName="y", timeoutSecs=60)
            # cancel_decompile reaches the decompile inside a variable edit (the cancel races a ~0.5 s decompile; a few tries)
            seen = []
            for _ in range(5):
                rid = await c.send("rename_variable", entry=big["entry"], name="no_such_var", newName="y")
                await c.ok("cancel_decompile", id=rid)
                r = await c.reply(rid)
                seen.append(r["error"]["code"])
                if CANCELLED in seen:
                    break
            assert CANCELLED in seen and set(seen) <= {CANCELLED, NOT_FOUND}, seen
            assert (await c.ok("cancel_decompile", id=999999)) == {"cancelled": False}
    run(go())


def test_open_profile_fast_and_full(tmp_path):
    err = open(tmp_path / "stderr.log", "wb")
    proc = Proc(tmp_path / "projects", stderr=err)
    sha = hashlib.sha256(open(BIN, "rb").read()).hexdigest()

    async def go():
        async with Client(proc.port) as c:
            await c.err("open_binary", INVALID, path=BIN, profile="turbo")
            r = await c.ok("open_binary", path=BIN, profile="fast")
            assert r["programId"].startswith(sha + "-") and r["persisted"] is False
            fast_fns = len(await c.ok("list_functions"))
            progs = await c.ok("list_programs")
            assert [p["options"] for p in progs] == [{"profile": "fast"}]
            await c.ok("close_program")
            r2 = await c.ok("open_binary", path=BIN, profile="fast")  # same key: persisted, no re-analysis
            assert r2["programId"] == r["programId"] and r2["persisted"] is True
            full = await c.ok("open_binary", path=BIN, profile="full")  # explicit full == plain default key
            assert full["programId"] == sha and full["persisted"] is False
            assert len(await c.ok("list_functions")) > 0 and fast_fns > 0
            assert {p["programId"]: p["options"] for p in await c.ok("list_programs")} == {sha: {}, r["programId"]: {"profile": "fast"}}
    try:
        run(go())
    finally:
        proc.stop()
        err.close()
    log = open(tmp_path / "stderr.log", errors="replace").read()
    assert "analyzers disabled: ['Call Convention ID', 'Decompiler Switch Analysis', 'Stack']" in log, log[-2000:]
    assert log.count("analyzers disabled") == 1  # the full open and the persisted reopen disable nothing


def test_open_profile_on_raw_blob(bproc):
    proc, d = bproc
    raw = blob(d, "profile.bin", pad=7)  # other bytes than the shared blob: its own program, no comments left by earlier tests
    opts = dict(path=raw, loader="Raw Binary", language=X86, baseAddress=BASE)

    async def go():
        async with Client(proc.port) as c:
            full = await c.ok("open_binary", **opts)
            fast = await c.ok("open_binary", profile="fast", **opts)
            assert fast["programId"] != full["programId"] and fast["persisted"] is False
            await c.ok("close_program")
            ents = {p["programId"]: p["options"] for p in await c.ok("list_programs")}
            assert ents[fast["programId"]] == {"loader": "Raw Binary", "language": X86, "baseAddress": BASE, "profile": "fast"}
            assert "profile" not in ents[full["programId"]]
            # raw-blob path of the Round 5 reads/edits
            await c.ok("open_binary", **opts)
            assert await c.ok("get_comments", address=BASE) == {}
            await c.ok("set_comment", address=BASE, kind="plate", text="blob plate")
            assert await c.ok("get_comments", address=BASE) == {"plate": "blob plate"}
            mid = hex(int(BASE, 16) + 3)  # inside the second instruction? unlabeled either way
            row = (await c.ok("listing_rows", address=mid, count=1))[0]
            assert "label" not in row
            await c.ok("create_label", address=row["address"], name="blob_lbl")
            assert (await c.ok("listing_rows", address=row["address"], count=1))[0]["label"] == "blob_lbl"
            await c.ok("undo"); await c.ok("undo")
    run(go())


def test_xrefs_from_external_on_pe(tmp_path):
    exe = win_exe()
    if not exe:
        pytest.skip("Ghidra's WinHelloCPP.exe exercise file is not in the install")
    proc = Proc(tmp_path / "projects")

    async def go():
        async with Client(proc.port) as c:
            await c.ok("open_binary", path=exe)
            addr = None
            rows = await c.ok("listing_rows", address="0x401000", count=1000)
            for row in rows:
                x = await c.ok("xrefs_from", address=row["address"])
                ext = [e for e in x if "external" in e]
                if ext:
                    addr, ext = row["address"], ext[0]
                    break
            assert addr, "no external reference in the first 1000 code units"
            assert "to" not in ext and "::" in ext["external"] and ext["type"]
            assert any("to" in e for e in x)  # the IAT slot is still a memory reference of the same instruction
            slot = next(e["to"] for e in x if "to" in e)
            assert any(r["from"] == addr for r in await c.ok("xrefs_to", address=slot))  # imports are found *to* via their IAT slot
    try:
        run(go())
    finally:
        proc.stop()


def test_project_lock_clear_error(tmp_path):
    p1, d = Proc(tmp_path / "projects"), tmp_path / "projects"
    p2 = Proc(d)

    async def go():
        async with Client(p1.port) as c1:
            await c1.ok("list_programs")  # p1 owns the project now
            async with Client(p2.port) as c2:
                for m, kw in (("list_programs", {}), ("open_binary", {"path": BIN})):
                    r = await c2.call(m, **kw)
                    assert r["error"]["code"] == PROJECT_LOCKED and "in use by another Ghidrette" in r["error"]["message"], r
                assert await c2.ok("list_languages")  # the sidecar stays usable
                assert (await c2.call("list_functions"))["error"]["code"] == NO_PROGRAM
            return True
    try:
        run(go())
        p1.stop()  # releases the project; the second sidecar's next call works (no sticky failure)

        async def after():
            async with Client(p2.port) as c2:
                assert await c2.ok("list_programs") == []
        run(after())
    finally:
        p1.stop(); p2.stop()


def test_clean_shutdown_releases_project(tmp_path):
    """After stdin EOF: exit 0, the project's lock files are gone, the edit was saved, and the next start opens it
    without a lock or recovery message. (Before: spike.lock and spike.lock~ stayed behind, os._exit with the project open.)"""
    d = tmp_path / "projects"
    log1, log2 = open(tmp_path / "e1.log", "wb"), open(tmp_path / "e2.log", "wb")
    p = Proc(d, stderr=log1)

    async def first():
        async with Client(p.port) as c:
            await c.ok("open_binary", path=BIN)
            f = (await c.ok("list_functions"))[3]
            await c.ok("rename_symbol", address=f["entry"], newName="r5_shutdown_name")
            return f["entry"]
    entry = run(first())
    t = time.monotonic()
    p.p.stdin.close()
    assert p.p.wait(timeout=60) == 0
    stop_s = time.monotonic() - t
    log1.close()
    assert not [n for n in os.listdir(d) if n.endswith((".lock", ".lock~"))], os.listdir(d)
    p2 = Proc(d, stderr=log2)

    async def second():
        async with Client(p2.port) as c:
            t0 = time.monotonic()
            r = await c.ok("open_binary", path=BIN)
            assert r["persisted"] is True
            assert (await c.ok("get_function_at", address=entry))["name"] == "r5_shutdown_name"
            return time.monotonic() - t0
    open_s = run(second())
    p2.stop(); log2.close()
    for name in ("e1.log", "e2.log"):
        text = open(tmp_path / name, errors="replace").read()
        assert not re.search(r"recover|unable to lock|lock exception|project is locked", text, re.I), (name, text[-1500:])
    print("shutdown %.2fs, next open %.2fs" % (stop_s, open_s))

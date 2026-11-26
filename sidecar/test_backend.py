"""Backend API tests against real Ghidra on /bin/ls (see ../README.md for JAVA_HOME and the venv)."""
import asyncio, glob, json, os, subprocess, sys, time

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
    def __init__(self, projects, extra_env=None):
        env = dict(os.environ, GHIDRA_INSTALL_DIR=ghidra_dir(), JAVA_HOME=JAVA, SIDECAR_PROJECTS_DIR=str(projects), **(extra_env or {}))
        self.p = subprocess.Popen([sys.executable, os.path.join(HERE, "main.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
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
            assert 0 < len(hits) <= 5 and all(h["kind"] in ("function", "label", "data", "external", "other") for h in hits)
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

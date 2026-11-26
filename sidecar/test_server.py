"""Protocol-level behavior: auth, bad arguments across methods, shutdown."""
import json, os, re, subprocess, sys, time

import pytest

import websockets

from testlib import BIN, Client, HERE, INVALID, JAVA, NOT_FOUND, NO_PROGRAM, Proc, ghidra_dir, run


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
            async with websockets.connect("ws://127.0.0.1:%d/s3cret" % port) as ws:
                await ws.send("x" * ((2 << 20) + 1))
                with pytest.raises(websockets.exceptions.ConnectionClosedError) as exc:
                    await ws.recv()
                assert exc.value.rcvd.code == 1009
        run(go())
    finally:
        p.stdin.close()
        p.wait(timeout=15)


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
            await c.err("list_functions", NO_PROGRAM)  # a failed open leaves no program open, whatever the reason
            assert (await c.ok("open_binary", path=BIN))["persisted"] is True  # and the sidecar is still alive
            assert len(await c.ok("list_functions")) == len(env["fns"])
    run(go())


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

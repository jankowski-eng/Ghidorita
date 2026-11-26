"""Helpers shared by the test files: spawn a sidecar (Proc), talk to it (Client), run a coroutine (run), constants."""
import asyncio, glob, json, os, subprocess, sys, time

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


# ---- Round 5: comments, labels, strings query, cancellable variable edits, profiles, project lock, clean shutdown ----
PROJECT_LOCKED = -32006


TIMEOUT = -32003


def win_exe():
    g = glob.glob(os.path.join(ghidra_dir(), "docs/GhidraClass/ExerciseFiles/WinhelloCPP/WinHelloCPP.exe"))
    return g[0] if g else None


X86 = "x86:LE:32:default"


BASE = "0x8000000"  # as listing_info prints it (no leading zeros)


def blob(tmp_path, name="blob.bin", pad=0):
    """Two tiny x86-32 functions: f1 at +0 calls f2 at +0x10."""
    code = bytes.fromhex("5589e5e808000000" "5dc3") + b"\x90" * 6 + bytes.fromhex("5589e5b801000000" "5dc3") + b"\x90" * pad
    p = tmp_path / name
    p.write_bytes(code)
    return str(p)


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

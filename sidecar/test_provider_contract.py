"""One versioned black-box browsing scenario. Launches the real providers over authenticated loopback."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest
import websockets
from websockets.exceptions import InvalidStatus

from testlib import BIN, CANCELLED, Client, Proc, run

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "app/providers/example.ghidrette.json"
TOKEN = "browsing-contract-test"
STALE = -32007


@pytest.fixture(params=["fixture", "pyghidra"])
def provider(request, tmp_path):
    if request.param == "pyghidra":
        proc = Proc(tmp_path / "projects", extra_env={"SIDECAR_TOKEN": TOKEN})
        try:
            yield request.param, proc.port, BIN
        finally:
            proc.stop()
        return
    node = shutil.which("node")
    assert node, "Install Node to run the fixture provider contract"
    with subprocess.Popen([node, ROOT / "app/providers/fixture.mjs"], env={**os.environ, "SIDECAR_TOKEN": TOKEN},
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as proc:
        try:
            yield request.param, int(proc.stdout.readline()), str(SAMPLE)
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)


def test_browsing_protocol(provider, tmp_path):
    name, port, sample = provider

    async def check():
        with pytest.raises(InvalidStatus):
            async with websockets.connect(f"ws://127.0.0.1:{port}/wrong"):
                pytest.fail("accepted an invalid token")
        async with Client(port, TOKEN) as c:
            if name == "fixture":
                c.analysis = None  # no `analysis` capability
            info = await c.ok("provider_info")
            assert info["provider"] == name and info["version"] == 1
            assert await c.ok("active_session") is None
            assert (await c.ok("cancel_open", id=99))["cancelled"] is False

            # Pipeline both frames, so a fast provider gets the cancel before finishing disk I/O.
            opening = await c.send("open_binary", path=sample)
            assert (await c.ok("cancel_open", id=opening))["cancelled"] is True
            assert (await c.reply(opening))["error"]["code"] == CANCELLED
            assert await c.ok("active_session") is None
            assert any(p["openId"] == opening for p in c.take("progress"))

            first = await c.ok("open_binary", path=sample)
            session = first["sessionId"]
            assert (await c.ok("active_session"))["sessionId"] == session
            functions = await c.ok("list_functions", session_id=session)
            assert functions
            fn = functions[-1] if name == "fixture" else functions[0]
            assert (await c.ok("get_function_at", address=fn["entry"], session_id=session))["name"] == fn["name"]
            options = {"address": fn["entry"], "count": 1, "session_id": session}
            landing = await c.ok("listing_rows", **options)
            assert landing[0]["address"] == fn["entry"]
            assert all(r["address"] != fn["entry"] for r in await c.ok("listing_rows", **options, direction="backward"))
            ranges = await c.ok("listing_info", session_id=session)
            start = ranges["ranges"][0]["start"]
            forward = await c.ok("listing_rows", address=start, count=12, session_id=session)
            assert len(forward) == 12
            backward = await c.ok("listing_rows", address=forward[-1]["address"], count=11, direction="backward", session_id=session)
            assert backward == forward[:-1]

            if name == "fixture":
                assert info["capabilities"] == []
                assert fn["entry"] == "overlay::fedcba9876543060"
                assert len(ranges["ranges"]) == 3
                await c.err("decompile", -32601, session_id=session, entry=fn["entry"])
                for m in ("export_gzf",):  # every optional method of the quick wins: a provider without the capability does not have it
                    await c.err(m, -32601, session_id=session, path="/tmp/x")
            else:
                assert "exportGzf" in info["capabilities"]

            second = await c.ok("open_binary", path=sample)
            assert first["programId"] == second["programId"]
            assert second["sessionId"] != session
            await c.err("listing_info", STALE, session_id=session)
            await c.err("listing_info", STALE)  # versioned requests must be scoped
            await c.err("close_program", STALE, session_id=session)
            if "editing" in info["capabilities"]:
                await c.err("set_comment", STALE, session_id=session, address=fn["entry"], kind="eol", text="must not be applied")
                assert (await c.ok("get_comments", session_id=second["sessionId"], address=fn["entry"])).get("eol") != "must not be applied"
            assert (await c.ok("active_session"))["sessionId"] == second["sessionId"]
            await c.ok("close_program", session_id=second["sessionId"])
            await c.err("list_functions", STALE, session_id=second["sessionId"])
            assert await c.ok("active_session") is None

            if name == "fixture":
                empty = tmp_path / "no-functions.json"
                empty.write_text('{"format":"ghidrette-listing-v1","ranges":[],"functions":[]}')
                third = await c.ok("open_binary", path=str(empty))
                assert await c.ok("list_functions", session_id=third["sessionId"]) == []
                assert await c.ok("listing_info", session_id=third["sessionId"]) == {"ranges": [], "totalBytes": 0}
                await c.ok("close_program", session_id=third["sessionId"])
    run(check())

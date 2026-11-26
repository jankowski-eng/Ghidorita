"""Variable edits through the decompiler (cancellable, timeout)."""

import asyncio
import threading
import time
from types import SimpleNamespace

import pytest

from ghidrette.app import App
from ghidrette.core.errors import RpcError
from ghidrette.core.rpc import Dispatcher
from ghidrette.domains import highvars
from testlib import BASE, CANCELLED, Client, INVALID, NOT_FOUND, TIMEOUT, X86, run


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


def test_structure_inference_callees_and_cancellation(sc, tmp_path, monkeypatch):
    # caller(p) returns callee(p). Only callee reads the field at offset 16.
    binary = tmp_path / "callee.bin"
    caller = bytes.fromhex("5589e5ff7508e81500000083c4045dc3")
    callee = bytes.fromhex("5589e58b45088b40105dc3")
    binary.write_bytes(caller.ljust(32, b"\x90") + callee)
    monkeypatch.setenv("SIDECAR_PROJECTS_DIR", str(tmp_path / "projects"))
    entered = threading.Event()

    def wait_for_cancel(_prog, _root, _existing, _decompiler, monitor):
        entered.set()
        end = time.monotonic() + 4
        while time.monotonic() < end:
            monitor.checkCancelled()
            time.sleep(0.01)
        pytest.fail("inference monitor was not cancelled")

    async def go():
        app = App(start=False)
        ctx = app.ctx
        ctx.loop = asyncio.get_running_loop()
        ctx.lanes.start()
        dispatcher = Dispatcher(ctx, app.registry)

        async def call(method, rid=1, **params):
            return await dispatcher._call(rid, method, params)

        try:
            await call("open_binary", path=str(binary), loader="Raw Binary", language=X86, baseAddress=BASE, analysis="blocking")
            entries = {f["entry"] for f in await call("list_functions")}
            for entry, name in (("0x8000020", "callee"), (BASE, "caller")):
                if entry not in entries:
                    await call("create_function", address=entry, name=name)
                await call("set_function_signature", entry=entry, signature="int %s(void *p)" % name)
            before = await call("undo_state")
            args = dict(entry=BASE, name="p", structName="Inferred")
            with monkeypatch.context() as patch:
                patch.setattr(highvars, "scans", lambda: SimpleNamespace(inferStructure=wait_for_cancel))
                for rid, expected in ((2, CANCELLED), (3, TIMEOUT)):
                    entered.clear()
                    request = asyncio.create_task(call("auto_create_structure", rid, timeoutSecs=1 if expected == TIMEOUT else 30, **args))
                    assert await asyncio.to_thread(entered.wait, 3)
                    assert await asyncio.wait_for(call("listing_info"), 0.5)
                    if expected == CANCELLED:
                        assert await call("cancel_decompile", id=rid) == {"cancelled": True}
                    with pytest.raises(RpcError) as caught:
                        await asyncio.wait_for(request, 3)
                    assert caught.value.code == expected
                    assert await call("undo_state") == before

            result = await call("auto_create_structure", **args)
            assert result == {"path": "/auto_structs/Inferred"}
            struct = await call("get_data_type", path=result["path"])
            assert [(c["offset"], c["length"]) for c in struct["components"] if not c["undefined"]] == [(16, 4)]
            await call("undo")
            with pytest.raises(RpcError) as caught:
                await call("get_data_type", path=result["path"])
            assert caught.value.code == NOT_FOUND

            existing = (await call("create_data_type", kind="struct", name="Existing"))["path"]
            await call("edit_struct", path=existing, op={"op": "add", "type": "int", "name": "first", "comment": "keep"})
            await call("retype_variable", entry=BASE, name="p", dataType="Existing *")
            assert await call("auto_create_structure", entry=BASE, name="p") == {"path": existing}
            fields = [c for c in (await call("get_data_type", path=existing))["components"] if not c["undefined"]]
            assert [c["offset"] for c in fields] == [0, 16]
            assert (fields[0]["name"], fields[0]["comment"]) == ("first", "keep")
        finally:
            for hook in ctx.shutdown_hooks:
                await asyncio.to_thread(ctx.lanes.on_r, hook)
    run(go())

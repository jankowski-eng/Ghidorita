"""Variable edits through the decompiler (cancellable, timeout)."""

from testlib import CANCELLED, Client, INVALID, NOT_FOUND, run


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

"""Listing edits: comments and labels."""

from testlib import Client, INVALID, NOT_FOUND, run


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


def test_function_source_and_load_coverage(env, tmp_path):
    fns = env["fns"]

    async def go():
        async with Client(env["proc"].port) as c:
            assert all(f["source"] in ("user", "analysis", "imported", "default") for f in await c.ok("list_functions"))
            f = fns[0]
            await c.ok("rename_symbol", address=f["entry"], name="cov_renamed")
            assert next(g for g in await c.ok("list_functions") if g["entry"] == f["entry"])["source"] == "user"
            p = tmp_path / "cov.txt"
            p.write_text("# trace\n0x401000-0x40100f\n\n0x401020  # one\n")
            assert await c.ok("load_coverage", path=str(p)) == {"ranges": [{"start": "0x401000", "end": "0x40100f"}, {"start": "0x401020", "end": "0x401020"}]}
            p.write_text("0x10\nnope\n")
            await c.err("load_coverage", INVALID, path=str(p))
            p.write_text("0x20-0x10\n")
            await c.err("load_coverage", INVALID, path=str(p))
            await c.err("load_coverage", NOT_FOUND, path=str(tmp_path / "missing"))
            await c.ok("undo")

    run(go())

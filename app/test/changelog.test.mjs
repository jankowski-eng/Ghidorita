import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/changeLog.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { ChangeLog } = await import("data:text/javascript," + encodeURIComponent(js));
const live = (l) => l.items.filter((c) => !c.undone).map((c) => c.label);

test("edits are logged, reads are not", () => {
  const l = new ChangeLog();
  l.record("list_functions", {}, []);
  l.record("rename_symbol", { address: "0x10", newName: "main" }, {});
  l.record("set_comment", { address: "0x10", kind: "eol", text: "x" }, {});
  assert.deepEqual(live(l), ["Rename to main", "Comment (eol)"]);
});

test("undo/redo flip entries; a new edit drops the undone ones", () => {
  const l = new ChangeLog();
  l.record("rename_symbol", { address: "0x1", newName: "a" }, {});
  l.record("rename_symbol", { address: "0x2", newName: "b" }, {});
  l.record("undo", {}, {});
  assert.deepEqual(live(l), ["Rename to a"]);
  l.record("redo", {}, {});
  assert.deepEqual(live(l), ["Rename to a", "Rename to b"]);
  l.record("undo", {}, {});
  l.record("define_data", { address: "0x3", dataType: "int" }, {});
  assert.equal(l.items.length, 2);
  l.record("redo", {}, {}); // nothing to redo after a new edit
  assert.deepEqual(live(l), ["Rename to a", "Define int"]);
});

test("a save freezes earlier entries: undo skips them; open clears", () => {
  const l = new ChangeLog();
  l.record("rename_symbol", { address: "0x1", newName: "a" }, {});
  l.record("save", {}, { saved: true });
  l.record("undo", {}, {});
  assert.equal(l.items[0].undone, false);
  assert.equal(l.items[0].saved, true);
  l.record("open_binary", {}, {});
  assert.equal(l.items.length, 0);
});

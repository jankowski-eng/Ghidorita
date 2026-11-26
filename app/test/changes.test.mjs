import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const r = await build({ entryPoints: [new URL("../src/renderer/changes.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const { onProgramChanged, functionsMayChange } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
const undo = { canUndo: true, canRedo: false, dirty: true };
const deps = (log) => ({
  refetchFunctions: async () => { log.push("funcs"); return [{ name: "a", entry: "0x10", size: 4 }, { name: "b", entry: "0x20", size: 4 }]; },
  currentFunctions: () => [{ name: "a", entry: "0x10", size: 4 }, { name: "b", entry: "0x20", size: 4 }],
  tabs: () => [{ id: 1, entry: "0x10" }, { id: 2, entry: "0x20" }],
  reloadTab: (id) => log.push("tab" + id), refreshListing: () => log.push("listing"), refreshXrefs: () => log.push("xrefs"), setUndo: (u) => log.push("undo:" + u.dirty),
});
test("symbol change reloads all tabs and refetches functions", async () => {
  const log = []; await onProgramChanged({ ranges: [{ start: "0x10", end: "0x10" }], kinds: ["symbol"], undo }, deps(log));
  assert.deepEqual(log, ["undo:true", "funcs", "tab1", "tab2", "listing", "xrefs"]);
});
test("comment change reloads only overlapping tabs, no function refetch", async () => {
  const log = []; await onProgramChanged({ ranges: [{ start: "0x21", end: "0x21" }], kinds: ["comment"], undo }, deps(log));
  assert.deepEqual(log, ["undo:true", "tab2", "listing", "xrefs"]);
});
test("symbol change away from any function entry skips the function refetch, type edits too", async () => {
  const log = []; await onProgramChanged({ ranges: [{ start: "0x14", end: "0x14" }], kinds: ["symbol"], undo }, deps(log));
  assert.deepEqual(log, ["undo:true", "tab1", "tab2", "listing", "xrefs"]);
  const log2 = []; await onProgramChanged({ ranges: null, kinds: ["type"], undo }, deps(log2));
  assert.ok(!log2.includes("funcs"));
});
test("functionsMayChange", () => {
  const f = [{ name: "a", entry: "0x10", size: 4 }, { name: "b", entry: "0x20", size: 4 }];
  const p = (kinds, ranges) => ({ kinds, ranges, undo });
  assert.equal(functionsMayChange(p(["symbol"], [{ start: "0x20", end: "0x20" }]), f), true);
  assert.equal(functionsMayChange(p(["symbol"], [{ start: "0x11", end: "0x1f" }]), f), false);
  assert.equal(functionsMayChange(p(["symbol"], [{ start: "0x0", end: "0x100" }]), f), true);
  assert.equal(functionsMayChange(p(["symbol"], null), f), true);
  assert.equal(functionsMayChange(p(["function"], []), f), true);
  assert.equal(functionsMayChange(p(["data", "code"], null), f), false);
});

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

test("qualified function entries (overlay, other spaces) and entries above 2^63 never throw and match only their own space", async () => {
  const f = [{ name: "hi", entry: "0xffffffff80000000", size: 0x20 }, { name: "ov", entry: "OVL1::1000", size: 0x20 }, { name: "lo", entry: "0x1000", size: 0x20 }];
  const p = (kinds, ranges) => ({ kinds, ranges, undo });
  assert.equal(functionsMayChange(p(["symbol"], [{ start: "OVL1::1000", end: "OVL1::1000" }]), f), true);
  assert.equal(functionsMayChange(p(["symbol"], [{ start: "OVL1::1004", end: "OVL1::1004" }]), f), false);
  assert.equal(functionsMayChange(p(["symbol"], [{ start: "0xffffffff80000000", end: "0xffffffff80000000" }]), f), true);
  assert.equal(functionsMayChange(p(["symbol"], [{ start: "OVL2::1000", end: "OVL2::1000" }]), f), false); // same offset, another space
  const log = [];
  const d = { refetchFunctions: async () => f, currentFunctions: () => f, tabs: () => [{ id: 1, entry: "0xffffffff80000000" }, { id: 2, entry: "OVL1::1000" }, { id: 3, entry: "0x1000" }],
    reloadTab: (id) => log.push("tab" + id), refreshListing: () => {}, refreshXrefs: () => {}, setUndo: () => {} };
  await onProgramChanged({ ranges: [{ start: "OVL1::1008", end: "OVL1::1008" }], kinds: ["comment"], undo }, d);
  assert.deepEqual(log, ["tab2"]); // the comment in the overlay function reloads only that tab; 0x1008 would have hit tab 3 if the space were ignored
  log.length = 0;
  await onProgramChanged({ ranges: [{ start: "0xffffffff8000001f", end: "0xffffffff8000001f" }], kinds: ["comment"], undo }, d);
  assert.deepEqual(log, ["tab1"]);
});

test("coverage ignores qualified (overlay) rows instead of throwing", async () => {
  const { Coverage } = await import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL("../src/renderer/coverage.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
  const c = new Coverage([{ start: "0x1000", end: "0x1fff" }, { start: "0xffffffff80000000", end: "0xffffffff80000010" }]);
  assert.equal(c.has("0x1004", 4), true); assert.equal(c.has("0xffffffff80000008", 4), true);
  assert.equal(c.has("OVL1::1004", 4), false); assert.equal(c.has("code:1004", 1), false);
});

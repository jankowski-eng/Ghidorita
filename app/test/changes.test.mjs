import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const r = await build({ entryPoints: [new URL("../src/renderer/changes.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const { onProgramChanged } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
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

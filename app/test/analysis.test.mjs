import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const load = async (f) => {
  const r = await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false });
  return import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
};
const { analysisLabel, analysisAction, analysisRunning } = await load("analysis.ts");
const { onProgramChanged } = await load("changes.ts");
const st = (o) => ({ state: "idle", analysis: "done", profile: "full", analyzer: "", done: 0, pct: -1, ...o });

test("label: running shows analyzer, done count and pct when known", () => {
  assert.equal(analysisLabel(st({ state: "running", analysis: "partial", analyzer: "Stack", done: 14, pct: 37 })), "Analyzing: Stack · 14 done · 37%");
  assert.equal(analysisLabel(st({ state: "running", analysis: "partial", done: 0 })), "Analyzing · 0 done");
});
test("label: cancelled, incomplete, failed, fast done, plain done", () => {
  assert.equal(analysisLabel(st({ state: "cancelled", analysis: "partial" })), "Analysis cancelled (partial)");
  assert.equal(analysisLabel(st({ analysis: "partial" })), "Analysis incomplete");
  assert.equal(analysisLabel(st({ state: "failed", analysis: "partial", error: "boom" })), "Analysis failed: boom");
  assert.equal(analysisLabel(st({ state: "done", profile: "fast" })), "Fast analysis done");
  assert.equal(analysisLabel(st({ state: "done" })), "");
  assert.equal(analysisLabel(null), "");
});
test("action: cancel while running, resume when partial/none, full on a fast program, else none", () => {
  assert.equal(analysisAction(st({ state: "running", analysis: "partial" })), "cancel");
  assert.equal(analysisAction(st({ state: "cancelled", analysis: "partial" })), "resume");
  assert.equal(analysisAction(st({ analysis: "none" })), "resume");
  assert.equal(analysisAction(st({ profile: "fast" })), "full");
  assert.equal(analysisAction(st({})), null);
  assert.equal(analysisAction(null), null);
  assert.equal(analysisRunning(st({ state: "running" })), true);
});

const undo = { canUndo: false, canRedo: false, dirty: false };
const deps = (log) => ({
  refetchFunctions: async () => { log.push("funcs"); return []; }, currentFunctions: () => [{ name: "a", entry: "0x10", size: 4 }],
  tabs: () => [{ id: 1, entry: "0x10" }], reloadTab: (id) => log.push("tab" + id), refreshListing: (r) => log.push("listing:" + r), refreshXrefs: () => log.push("xrefs"), setUndo: () => log.push("undo"),
});
test("program_changed while analysis runs: function list and listing only, no tab reload, no xrefs", async () => {
  const log = []; await onProgramChanged({ ranges: null, kinds: ["symbol", "function", "code", "data", "comment", "type", "other"], undo }, deps(log), true);
  assert.deepEqual(log, ["undo", "funcs", "listing:null"]);
});
test("the program_changed after the analysis ends reloads the tabs again", async () => {
  const log = []; await onProgramChanged({ ranges: null, kinds: ["symbol", "function", "code"], undo }, deps(log), false);
  assert.deepEqual(log, ["undo", "funcs", "tab1", "listing:null", "xrefs"]);
});

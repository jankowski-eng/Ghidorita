import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const load = async (f) => {
  const r = await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node" });
  return import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
};
const { programReducer, initialProgram, noUndo } = await load("store/program.ts");
const { viewsReducer, initialViews } = await load("store/views.ts");
const { createStore } = await load("store/createStore.ts");
const step = (s, ...actions) => actions.reduce(programReducer, s);

test("program: a new program drops what belongs to the old one, the messages stay", () => {
  const dirty = step(initialProgram, { type: "program", program: { session: { sessionId: "a" } } },
    { type: "browsed", funcs: [{ entry: "0x1" }], map: {}, rows: [{}] }, { type: "undo", u: { canUndo: true, canRedo: false, dirty: true } },
    { type: "stats", patch: { listingMs: 3 } }, { type: "error", message: "boom" }, { type: "notice", message: "hi" });
  const next = step(dirty, { type: "program", program: null });
  assert.equal(next.program, null);
  assert.deepEqual([next.funcs, next.map, next.initialRows, next.undo, next.stats], [[], null, [], noUndo, {}]);
  assert.equal(next.error, "boom"); assert.equal(next.notice, "hi");
});

test("program: open lifecycle, progress is dropped when not opening or while cancelling", () => {
  const p = { phase: "import", pct: 5, message: "" };
  assert.equal(step(initialProgram, { type: "progress", p }).progress, null);              // no open running
  let s = step(initialProgram, { type: "error", message: "old" }, { type: "openStarted", path: "/x", startedAt: 1 });
  assert.equal(s.error, ""); assert.deepEqual(s.opening, { path: "/x", startedAt: 1, cancelling: false });
  s = step(s, { type: "progress", p }); assert.equal(s.progress, p);
  s = step(s, { type: "cancelling", on: true }, { type: "progress", p: { ...p, pct: 9 } });
  assert.equal(s.progress, p); assert.equal(s.opening.cancelling, true);                    // late progress after Cancel
  s = step(s, { type: "cancelling", on: false }); assert.equal(s.opening.cancelling, false); // open not cancellable yet: retry
  s = step(s, { type: "openEnded" }); assert.deepEqual([s.opening, s.progress], [null, null]);
  assert.equal(step(initialProgram, { type: "cancelling", on: true }).opening, null);       // nothing to cancel
});

test("program: browsing, saving, undo, flash", () => {
  let s = step(initialProgram, { type: "reading" }, { type: "browseFailed", message: "no listing" }, { type: "readingDone" });
  assert.deepEqual([s.reading, s.browseError], [false, "no listing"]);
  s = step(s, { type: "reading" }); assert.equal(s.browseError, "");                       // retry clears the message
  s = step(s, { type: "saving", on: true }, { type: "closing", on: true }, { type: "unavailable" });
  assert.deepEqual([s.saving, s.closing, s.unavailable], [true, true, true]);
  assert.equal(programReducer(s, { type: "undo", u: s.undo }) === s, false);
});

test("views: reset keeps the layout and counters, forgets position, panels and dialogs; the scroll request keeps counting", () => {
  let v = viewsReducer(initialViews, { type: "set", patch: { dock: "strings", dlg: {}, searchOpen: true, xrefVersion: 4, visible: { functions: false, listing: true, decompiler: true }, graphOn: true, dataVersion: 7, importFor: "/p" } });
  v = viewsReducer(v, { type: "set", patch: (x) => ({ scrollReq: { address: "0x10", n: x.scrollReq.n + 1 } }) });
  const r = viewsReducer(v, { type: "reset" });
  assert.deepEqual([r.dock, r.dlg, r.searchOpen, r.xrefVersion], [null, null, false, 0]);
  assert.deepEqual([r.visible.functions, r.graphOn, r.dataVersion, r.importFor], [false, true, 7, "/p"]);
  assert.equal(r.scrollReq.address, ""); assert.equal(r.scrollReq.n, v.scrollReq.n + 1);
});

test("createStore: notifies on change only, unsubscribe works", () => {
  const st = createStore((s, a) => (a === "inc" ? s + 1 : s), 0);
  let calls = 0; const off = st.subscribe(() => calls++);
  st.dispatch("noop"); st.dispatch("inc"); off(); st.dispatch("inc");
  assert.deepEqual([st.getState(), calls], [2, 1]);
});

test("program: the analysis state belongs to one program and is dropped with it", () => {
  const running = { state: "running", analysis: "partial", profile: "full", analyzer: "Stack", done: 2, pct: 10 };
  const s = step(initialProgram, { type: "program", program: { session: { sessionId: "a" } } }, { type: "analysis", state: running });
  assert.deepEqual(s.analysis, running);
  assert.equal(step(s, { type: "program", program: null }).analysis, null);
});

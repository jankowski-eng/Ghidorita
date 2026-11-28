import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const r = await build({ stdin: { resolveDir: new URL("../src/", import.meta.url).pathname, loader: "ts", contents: `
export { uiTools } from "./agent/tools/ui"; export { MAX_HL_ADDRESSES } from "./agent/tools/ui";
export { agentMarks } from "./renderer/features/agentHighlight";
export { followTarget, debounced, followAgent } from "./renderer/features/agentFollow";
export { viewsReducer, initialViews } from "./renderer/store/views";` }, bundle: true, format: "esm", write: false, platform: "node" });
const { uiTools, MAX_HL_ADDRESSES, agentMarks, followTarget, debounced, followAgent, viewsReducer, initialViews } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
const highlight = uiTools.find((t) => t.name === "highlight");
const hit = (name, address) => ({ name, address, kind: "function" });
const ops = { searches: { searchSymbols: ({ query }) => ({ result: Promise.resolve(query === "main" ? [hit("main", "0x401000")] : []), cancel() {} }) }, functions: { containing: async ({ address }) => ({ name: "main", entry: "0x401000", size: 9, signature: "" , address }) } };
const rec = () => { const c = []; return { c, ui: { highlight: async (h) => c.push(h), clearHighlight: async () => c.push("clear") } }; };

test("highlight resolves names and function lines, dedupes, and hands the UI one structure", async () => {
  const { c, ui } = rec();
  const t = await highlight.handler({ ops, ui }, { addresses: ["main", "0x401010", "0x401010"], lines: [{ function: "main", from: 2, to: 4 }], label: "the loop" });
  assert.deepEqual(c, [{ addresses: ["0x401000", "0x401010"], lines: [{ entry: "0x401000", from: 2, to: 4 }], label: "the loop" }]);
  assert.match(t, /2 addresses and 1 line ranges \(the loop\)/);
});
test("highlight resolves names one at a time (never more than one search in flight) and stops when cancelled", async () => {
  let now = 0, peak = 0, calls = 0;
  const slow = { ...ops, searches: { searchSymbols: ({ query }) => { calls++; now++; peak = Math.max(peak, now); return { result: new Promise((r) => setTimeout(() => { now--; r([hit(query, "0x40" + (1000 + calls).toString(16))]); }, 2)), cancel() {} }; } } };
  const { c, ui } = rec();
  await highlight.handler({ ops: slow, ui }, { addresses: Array.from({ length: 30 }, (_, i) => "sym" + i) });
  assert.equal(peak, 1); assert.equal(c[0].addresses.length, 30);
  const ac = new AbortController(); calls = 0;
  const stop = { ...slow, searches: { searchSymbols: (p) => { if (calls === 2) ac.abort(); return slow.searches.searchSymbols(p); } } };
  await assert.rejects(highlight.handler({ ops: stop, ui, signal: ac.signal }, { addresses: ["a", "b", "c", "d", "e"] }), /cancelled|abort/i);
  assert.equal(c.length, 1, "nothing was highlighted after the cancel");
});
test("highlight: clear, nothing, bad ranges, too many, no window, no program", async () => {
  const { c, ui } = rec();
  assert.match(await highlight.handler({ ops, ui }, { clear: true }), /cleared/); assert.deepEqual(c, ["clear"]);
  await assert.rejects(highlight.handler({ ops, ui }, {}), /addresses or lines/);
  await assert.rejects(highlight.handler({ ops, ui }, { lines: [{ function: "main", from: 5, to: 2 }] }), /Lines 5-2/);
  await assert.rejects(highlight.handler({ ops, ui }, { lines: [{ function: "main", from: 1, to: 9999 }] }), /at most 500/);
  await assert.rejects(highlight.handler({ ops, ui }, { addresses: Array(MAX_HL_ADDRESSES + 1).fill("0x1") }), /At most/);
  await assert.rejects(highlight.handler({ ops, ui: undefined }, { clear: true }), /window/);
  await assert.rejects(highlight.handler({ ops: null, ui }, { clear: true }), /No program is open/);
  assert.equal(c.length, 1);
});
test("highlight is an app-only read tool that is not read-only and idempotent", () => {
  assert.equal(highlight.appOnly, true); assert.equal(highlight.access, "read");
  assert.deepEqual([highlight.annotations.readOnlyHint, highlight.annotations.destructiveHint, highlight.annotations.idempotentHint], [false, false, true]);
});

const tok = (line, colStart, colEnd, address) => ({ line, colStart, colEnd, address });
test("agentMarks: tokens at addresses and whole lines of the active tab only, as trail marks", () => {
  const text = "int f() {\n  x = 1;\n\n  return x;\n}", tokens = [tok(1, 2, 7, "0x10"), tok(3, 2, 10, "0x20"), tok(3, 9, 10)];
  const hl = { addresses: ["0x20"], lines: [{ entry: "0x1", from: 1, to: 2 }, { entry: "0x2", from: 4, to: 4 }], label: "" };
  const m = agentMarks(hl, "0x1", text, tokens);
  assert.deepEqual(m.tokens, [{ line: 3, colStart: 2, colEnd: 10, dir: "forward" }, { line: 0, colStart: 0, colEnd: 9, dir: "forward" }, { line: 1, colStart: 0, colEnd: 8, dir: "forward" }]);
  assert.deepEqual([...m.addrs], ["0x20"]);
  assert.deepEqual(agentMarks(hl, "0x3", text, []).tokens, []); // another tab: no lines, no tokens, listing rows still tinted
  assert.deepEqual(agentMarks(null, "0x1", text, tokens), { tokens: [], addrs: new Set() });
  assert.equal(agentMarks({ addresses: [], lines: [{ entry: "0x1", from: 1, to: 99 }] }, "0x1", "a\nb", []).tokens.length, 2); // clamped to the text
});
test("the highlight is dropped with the program (views reset) but survives a plain set", () => {
  const hl = { addresses: ["0x1"], lines: [] };
  const v = viewsReducer(initialViews, { type: "set", patch: { agentHl: hl } });
  assert.equal(v.agentHl, hl);
  assert.equal(viewsReducer(v, { type: "reset" }).agentHl, null);
});

test("follow table: read tools by their argument, edits and unknown tools never", () => {
  assert.equal(followTarget("decompile", { function: " main " }), "main");
  assert.equal(followTarget("disassemble", { at: "0x401000", count: 4 }), "0x401000");
  assert.equal(followTarget("xrefs", { target: "0x10" }), "0x10");
  assert.equal(followTarget("xrefs", { target: "param_1", function: "main" }), "main"); // a variable: follow its function
  for (const t of ["calls", "call_graph", "stack_frame", "function_graph", "pcode", "value_trail"]) assert.equal(followTarget(t, { function: "f" }), "f");
  assert.equal(followTarget("rename_function", { function: "f", newName: "g" }), null);
  assert.equal(followTarget("decompile", {}), null); assert.equal(followTarget("decompile", { function: 5 }), null);
  assert.equal(followTarget("goto", { address: "0x1" }), null); // goto navigates itself
});
test("followAgent debounces a burst to the last target and stays out of the user's way", async () => {
  const gone = []; const views = { v: {} };
  const prog = { api: ops }, s = { program: () => prog, blocked: () => false, views: { getState: () => views.v } };
  const f = followAgent(s, async (a) => { gone.push(a); }, 10);
  f("decompile", { function: "0x20" }); f("decompile", { function: "main" });
  await new Promise((r) => setTimeout(r, 60)); assert.deepEqual(gone, ["0x401000"]);
  views.v = { dlg: {} }; f("decompile", { function: "main" });
  await new Promise((r) => setTimeout(r, 60)); assert.equal(gone.length, 1);
  views.v = {}; f("rename_variable", { function: "main" });
  await new Promise((r) => setTimeout(r, 60)); assert.equal(gone.length, 1); // an edit is not followed
  views.v = {}; f("decompile", { function: "main" }); f("get_view", {}); f("status", {}); // a call that names no place must not cancel the pending move
  await new Promise((r) => setTimeout(r, 60)); assert.equal(gone.length, 2);
  const d = debounced(() => gone.push("x"), 10); d(); d.cancel();
  await new Promise((r) => setTimeout(r, 40)); assert.equal(gone.length, 2);
});

test("Agent > Follow Agent: an unchecked checkbox that survives rebuilds and sends agent-follow to the renderer", async () => {
  const m = await build({ entryPoints: [new URL("../src/main/menu.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node", alias: { electron: new URL("./stub-electron.mjs", import.meta.url).pathname } });
  const { createMenu } = await import("data:text/javascript," + encodeURIComponent(m.outputFiles[0].text));
  const sent = [], win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (ch, c) => sent.push([ch, c]) } };
  const menu = createMenu({ getWin: () => win, pick: async () => null, agent: { mode: () => "read", setMode() {}, clients: () => [], setupText: () => "" } });
  const item = () => { const flat = (xs) => xs.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]); return flat(globalThis.__builtMenu).find((i) => i.id === "agent-follow"); };
  assert.equal(item().type, "checkbox"); assert.equal(item().checked, false);
  item().click({ checked: true });
  assert.deepEqual(sent, [["menu", { type: "agent-follow", on: true }]]);
  menu.refresh(); assert.equal(item().checked, true);
  item().click({ checked: false });
  assert.deepEqual(sent.at(-1), ["menu", { type: "agent-follow", on: false }]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// One copy of the gating, three surfaces: the command bar (ACTIONS filtered by allowsCommand), the dock, and the native menu (src/main/menu.ts, built here against a stub of electron).
const bundle = async (entry, extra = {}) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node", ...extra })).outputFiles[0].text));
const { allowsCommand, dockCapability, centreViews } = await bundle("../src/capabilities.ts");
const { ACTIONS } = await bundle("../src/renderer/commandActions.ts");
const { buildOptions, choiceError } = await bundle("../src/renderer/openOptions.ts");

const caps = (...c) => new Set(c);
const palette = (c) => ACTIONS.filter(({ cmd }) => allowsCommand(c, cmd)).map((a) => a.label).sort();
const NO_CAPS = ["Go to Address…", "Go Back", "Go Forward", "Copy Address", "Close Program"]; // what needs no capability

test("command bar: no capabilities offers only what needs none", () => {
  assert.deepEqual(palette(caps()), [...NO_CAPS].sort());
});

test("call graph without decompilation: the graph works, nothing that needs the decompiler is offered", () => {
  const c = caps("callGraph");
  assert.deepEqual(palette(c), [...NO_CAPS, "Toggle Call Graph"].sort());
  for (const cmd of [{ type: "graph" }, { type: "close-tab" }, { type: "copy", what: "decompiled" }, { type: "edit", action: "retype" }, { type: "edit", action: "autoStruct" },
    { type: "toggle-pane", pane: "decompiler", visible: true }]) assert.equal(allowsCommand(c, cmd), false, JSON.stringify(cmd));
  assert.equal(allowsCommand(c, { type: "toggle-pane", pane: "listing", visible: true }), true);
  // and the decompiler-dependent ones need the decompiler even when their other capability is there
  const g = caps("controlFlowGraph", "variableEditing", "bytes");
  assert.equal(allowsCommand(g, { type: "graph" }), false);
  assert.equal(allowsCommand(g, { type: "edit", action: "retype" }), false);
  assert.equal(allowsCommand(g, { type: "copy", what: "bytes" }), true);
});

test("the centre pane shows the call graph without a decompiler (it used to live inside the decompiler's pane and never appeared)", () => {
  assert.deepEqual(centreViews(caps("callGraph"), true), { decompiler: false, callGraph: true });
  assert.deepEqual(centreViews(caps("callGraph"), false), { decompiler: false, callGraph: false });
  assert.deepEqual(centreViews(caps("decompile"), true), { decompiler: true, callGraph: false });
});

test("export: each kind needs its own capability", () => {
  assert.deepEqual(palette(caps("export")), [...NO_CAPS, "Export Symbol Map (JSON)", "Export C Header"].sort());
  assert.deepEqual(palette(caps("exportGzf")), [...NO_CAPS, "Export Ghidra Archive (.gzf)"].sort());
});

test("dock panels and edit commands follow their own capability only", () => {
  assert.deepEqual(Object.entries(dockCapability).filter(([panel]) => allowsCommand(caps("bookmarks"), { type: "dock", panel })).map(([p]) => p), ["bookmarks"]);
  assert.equal(allowsCommand(caps("save"), { type: "edit", action: "save" }), true);
  assert.equal(allowsCommand(caps("save"), { type: "edit", action: "rename" }), false);
  assert.equal(allowsCommand(caps("undo"), { type: "edit", action: "redo" }), true);
  assert.equal(allowsCommand(caps("bookmarks"), { type: "edit", action: "bookmark" }), true);
  assert.equal(allowsCommand(caps("editing"), { type: "edit", action: "bookmark" }), false);
});

// the native menu, rebuilt for a capability set: id/label -> enabled
const electron = new URL("./stub-electron.mjs", import.meta.url).pathname;
const { createMenu } = await bundle("../src/main/menu.ts", { alias: { electron } });
const menuFor = (capabilities) => {
  const m = createMenu({ getWin: () => undefined, pick: async () => null });
  m.setState({ capabilities, hasProgram: true, canBack: false, canForward: false, canOpen: true, canEdit: true, undoLabel: null, redoLabel: null, dirty: false, canClose: true });
  const flat = (items) => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]);
  const items = flat(globalThis.__builtMenu).filter((i) => i.label);
  return { get: (label) => items.find((i) => i.label === label || i.label.startsWith(label + "   ("))?.enabled !== false };
};

test("native menu: only the advertised export is enabled", () => {
  const sym = menuFor(["export"]), gz = menuFor(["exportGzf"]);
  assert.deepEqual([sym.get("Symbol Map (JSON)…"), sym.get("C Header…"), sym.get("Ghidra Archive (.gzf)…")], [true, true, false]);
  assert.deepEqual([gz.get("Symbol Map (JSON)…"), gz.get("C Header…"), gz.get("Ghidra Archive (.gzf)…")], [false, false, true]);
});

test("native menu: call graph alone enables the call graph and nothing of the decompiler", () => {
  const m = menuFor(["callGraph"]);
  assert.equal(m.get("Call Graph"), true);
  for (const label of ["Control-Flow Graph", "Close Tab", "Decompiler", "Copy Decompiled Function", "Retype Variable…", "Auto Create Structure (variable)…", "Rename…", "Save", "Show References To"])
    assert.equal(m.get(label), false, label);
});

test("a loader that needs no language: the import needs no language choice and sends no language", () => {
  const cand = { loader: "L", language: null, compilerSpec: null, preferred: true, acceptsBaseAddress: false, requiresLanguage: false };
  const choice = { cand, language: null, compilerSpec: null, base: "" };
  assert.equal(choiceError(choice), null);
  assert.equal(buildOptions(choice), undefined); // the default import: no options at all
  assert.deepEqual(buildOptions({ ...choice, cand: { ...cand, preferred: false } }), { loader: "L" });
  assert.equal(choiceError({ ...choice, cand: { ...cand, requiresLanguage: undefined } }), "Choose a language");
});

// Agent tools: one table (each ToolDef names the capabilities it needs), gated like the menu.
const { visibleTools } = await bundle("../src/agent/access.ts");
const { TOOLS } = await bundle("../src/agent/tools/index.ts");
const toolNames = (mode, c) => visibleTools(mode, { capabilities: c }).map((t) => t.name);

test("agent tools: a tool whose capability is missing isn't listed, in any mode", () => {
  assert.deepEqual(toolNames("edit", caps()).filter((n) => TOOLS.find((t) => t.name === n).capability), []);
  for (const t of TOOLS.filter((t) => t.capability)) {
    const need = [t.capability].flat();
    assert.ok(toolNames("full", new Set(need)).includes(t.name), `${t.name} listed with ${need}`);
    for (const c of need) assert.ok(!toolNames("full", new Set(need.filter((x) => x !== c))).includes(t.name), `${t.name} hidden without ${c}`);
  }
});
test("agent tools: modes nest, status is always there, no gating until the capabilities are known", () => {
  assert.deepEqual(toolNames("off", undefined), ["status"]);
  const all = new Set(TOOLS.flatMap((t) => [t.capability ?? []].flat()));
  const read = toolNames("read", all), edit = toolNames("edit", all);
  assert.ok(read.length > 5 && edit.length > read.length && read.every((n) => edit.includes(n)));
  assert.ok(TOOLS.filter((t) => t.access === "read").every((t) => t.annotations.readOnlyHint), "read tools are read-only");
  assert.ok(TOOLS.filter((t) => t.access !== "read" && t.access !== "off").every((t) => !t.annotations.readOnlyHint), "edit tools are not");
  assert.equal(toolNames("edit", undefined).length, TOOLS.filter((t) => t.access !== "full").length);
});
test("agent tools: a read-only provider (no editing capabilities) offers no edit tools", () => {
  const names = toolNames("edit", caps("decompile", "references", "bytes"));
  for (const n of ["rename_symbol", "rename_variable", "set_comment", "undo_agent_edit", "set_bookmark"]) assert.ok(!names.includes(n), n);
  assert.ok(names.includes("decompile") && names.includes("status"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const load = async (file) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(file, import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
const { KEYS, keyId, keyOf, isHint, showKey, hintLine, matchesKey } = await load("../src/keys.ts");
const { dotOf, covStyle, COLORS } = await load("../src/renderer/palette.ts");
const { isBackEdge } = await load("../src/renderer/graphLayout.ts");
const { ACTIONS } = await load("../src/renderer/commandActions.ts");
const { readFileSync } = await import("node:fs");

const caps = (...c) => new Set(c);
const ALL = caps("editing", "decompile", "variableEditing", "typeEditing", "references", "controlFlowGraph", "callGraph");

test("key table: Ghidra defaults, shown the same on both platforms' syntax", () => {
  assert.equal(showKey("CmdOrCtrl+Shift+G", true), "⌘⇧G");
  assert.equal(showKey("CmdOrCtrl+Shift+G", false), "Ctrl+Shift+G");
  assert.equal(showKey("CmdOrCtrl+Alt+C", true), "⌘⌥C");
  assert.equal(keyOf({ type: "edit", action: "rename" }), "L");
  assert.equal(keyOf({ type: "edit", action: "save" }), KEYS.save);
  assert.equal(keyOf({ type: "dock", panel: "strings" }), undefined); // Ghidra uses Ctrl+Shift+E for Edit Field
  assert.equal(keyOf({ type: "dock", panel: "symbols" }), "CmdOrCtrl+T");
  assert.equal(keyOf({ type: "xrefs" }), "CmdOrCtrl+Shift+F");
  assert.equal(keyOf({ type: "dock", panel: "memsearch" }), "S");
  assert.equal(keyOf({ type: "goto" }), "G");
  assert.equal(showKey("Alt+Left", true), "⌥←");
  assert.ok(isHint("edit:retype") && isHint("edit:rename") && isHint("goto") && isHint("nav-back") && isHint("dock:memsearch") && !isHint("graph") && !isHint("xrefs"));
  const ev = (key, m = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
  assert.ok(matchesKey("G", ev("g")) && matchesKey("G", ev("G")) && !matchesKey("G", ev("g", { metaKey: true })) && !matchesKey("G", ev("g", { shiftKey: true })));
  assert.ok(matchesKey("Alt+Left", ev("ArrowLeft", { altKey: true })) && !matchesKey("Alt+Left", ev("ArrowLeft")));
});

test("key table: every key is used once, and every command-bar action with a key resolves to a table entry", () => {
  const keys = Object.values(KEYS);
  assert.equal(new Set(keys).size, keys.length, "two commands share a key");
  const ids = ACTIONS.map((a) => keyId(a.cmd));
  for (const id of ids) if (KEYS[id]) assert.equal(ids.filter((x) => x === id).length, 1, id + " listed twice");
  const menu = readFileSync(new URL("../src/main/menu.ts", import.meta.url), "utf8");
  assert.doesNotMatch(menu, /accelerator: "/, "menu.ts hard-codes an accelerator; read it from keys.ts");
  for (const id of Object.keys(KEYS)) assert.ok(menu.includes(`"${id}"`) || id.startsWith("copy:") || id.startsWith("edit:") || id.startsWith("dock:") || id === "datatypes", `menu.ts never reads ${id}`);
});

test("hint bar lists the keys of the focused view and only what the capabilities allow", () => {
  assert.equal(hintLine("listing", ALL, true), "L rename · ⌘⇧F refs · ⌘Space graph · ; comment · F function · T data · [ array · P pointer · C clear");
  assert.equal(hintLine("decompiler", ALL, true), "L rename · ⌘⇧F refs · ⌘Space graph · ⌘L retype · ; comment");
  assert.equal(hintLine("decompiler", ALL, false), "L rename · Ctrl+Shift+F refs · Ctrl+Space graph · Ctrl+L retype · ; comment");
  assert.equal(hintLine("graph", ALL, true), "⌘Space back · wheel zoom · drag pan · Fit · 1:1");
  assert.equal(hintLine("other", ALL, true), "⌘K commands · G go to");
  assert.equal(hintLine("listing", caps("decompile", "references"), true), "⌘⇧F refs");
  assert.equal(hintLine("decompiler", caps("decompile", "editing", "references"), true), "L rename · ⌘⇧F refs · ; comment");
  assert.equal(hintLine("listing", caps(), true), "");
});

test("symbol source -> dot: colour and shape", () => {
  assert.deepEqual(dotOf("user"), { kind: "confirmed", color: "#F4F1EA", shape: "solid", label: "named by you" });
  assert.deepEqual([dotOf("analysis").shape, dotOf("analysis").color, dotOf("analysis").label], ["ring", "#F2B84B", "named by analysis"]);
  assert.deepEqual([dotOf("imported").shape, dotOf("imported").color, dotOf("imported").label], ["solid", "#5EC8E5", "from the file"]);
  assert.deepEqual([dotOf("default").shape, dotOf("default").color, dotOf("default").label], ["dashed", "#7D8794", "unnamed"]);
  assert.equal(dotOf(undefined).kind, "unknown");
});

test("coverage mark -> style: only-A solid with A, only-B hatched with B, both runs green", () => {
  assert.deepEqual(covStyle(" cov"), { color: "#4ec36b", letter: "", hatched: false });
  assert.deepEqual(covStyle(" cov-a"), { color: COLORS.attention, letter: "A", hatched: false });
  assert.deepEqual(covStyle(" cov-b"), { color: COLORS.attention, letter: "B", hatched: true });
  assert.equal(covStyle(""), null);
});

test("graph: a back edge targets a block that starts at or before its source", () => {
  assert.ok(isBackEdge("0x1000", "0x0ff0"));
  assert.ok(isBackEdge("0x1000", "0x1000"));
  assert.ok(!isBackEdge("0x1000", "0x1010"));
  assert.ok(isBackEdge("0x10000254b", "0x100002000"));
  assert.ok(!isBackEdge("code:0ff0", "code:1000"));
});

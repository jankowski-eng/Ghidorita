import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const L = await import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL("../src/renderer/layouts.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
const memory = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), m }; };
const mine = { order: ["listing", "decompiler", "functions"], visible: { functions: false, listing: true, decompiler: true }, sizes: { functions: 300, listing: 700 }, center: "pcode", dock: "hex" };

test("save and restore: the arrangement comes back as saved, the Default stays", () => {
  const st = memory();
  assert.deepEqual(L.saveLayout("Reversing", mine, st), { ok: true });
  const s = L.readLayouts(st);
  assert.deepEqual(s.layouts.Reversing, mine);
  assert.deepEqual(L.layoutNames(s), ["Default", "Reversing"]);
  assert.deepEqual(s.layouts.Default, L.BUILTIN);
  L.saveLayout("  Reversing ", { ...mine, dock: null }, st); // the same name (trimmed) replaces it
  assert.equal(L.readLayouts(st).layouts.Reversing.dock, null);
  assert.equal(Object.keys(L.readLayouts(st).layouts).length, 2);
});

test("the Default cannot be deleted, another layout can; names are checked", () => {
  const st = memory();
  L.saveLayout("A", mine, st);
  assert.equal(L.deleteLayout("Default", st).ok, false);
  assert.ok(L.readLayouts(st).layouts.Default);
  assert.equal(L.deleteLayout("A", st).ok, true);
  assert.equal(L.deleteLayout("A", st).ok, false);
  assert.equal(L.saveLayout("   ", mine, st).ok, false);
  assert.equal(L.saveLayout("x".repeat(41), mine, st).ok, false);
});

test("migration: the sizes saved under the old key become the Default's, the old key goes away", () => {
  const st = memory({ "ghidra.layout.v1": JSON.stringify({ functions: 333, listing: 444 }) });
  const s = L.readLayouts(st);
  assert.deepEqual(s.layouts.Default.sizes, { functions: 333, listing: 444 });
  assert.deepEqual(s.layouts.Default.order, ["functions", "listing", "decompiler"]);
  assert.equal(st.getItem("ghidra.layout.v1"), null);
  assert.deepEqual(L.readLayouts(st).layouts.Default.sizes, { functions: 333, listing: 444 }); // and it stays after the next read
  assert.deepEqual(L.startupLayout(st).sizes, { functions: 333, listing: 444 });
  const clamped = memory({ "ghidra.layout.v1": JSON.stringify({ functions: 5, listing: 99999 }) });
  assert.deepEqual(L.readLayouts(clamped).layouts.Default.sizes, { functions: 120, listing: 2000 });
});

test("live sizes win over the Default's at startup, and a saved layout applies its own", () => {
  const st = memory();
  L.saveSizes({ functions: 250, listing: 480 }, st);
  assert.deepEqual(L.startupLayout(st).sizes, { functions: 250, listing: 480 });
  assert.deepEqual(L.readLayouts(st).layouts.Default.sizes, L.BUILTIN.sizes);
});

test("missing, corrupt or unavailable storage gives the built-in Default; bad entries are dropped one by one", () => {
  assert.deepEqual(L.readLayouts(memory()).layouts, { Default: L.BUILTIN });
  for (const bad of ["{", "null", "[]", "\"x\"", JSON.stringify({ layouts: 5 })]) assert.deepEqual(L.readLayouts(memory({ [L.KEY]: bad })).layouts, { Default: L.BUILTIN }, bad);
  assert.deepEqual(L.readLayouts(memory({ "ghidra.layout.v1": "garbage" })).layouts, { Default: L.BUILTIN });
  assert.deepEqual(L.readLayouts(undefined).layouts, { Default: L.BUILTIN });
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(L.startupLayout(throwing), L.BUILTIN);
  assert.equal(L.saveLayout("A", mine, throwing).ok, false);
  const st = memory({ [L.KEY]: JSON.stringify({ layouts: { good: mine, dup: { ...mine, order: ["listing", "listing", "functions"] }, nodock: { ...mine, dock: "nope" }, center: { ...mine, center: "x" }, nan: { ...mine, sizes: { functions: "a", listing: 1 } } } }) });
  assert.deepEqual(Object.keys(L.readLayouts(st).layouts).sort(), ["Default", "good"]);
});

test("applying a layout the provider cannot show falls back to C and no dock", () => {
  const caps = new Set(["decompile", "bytes"]);
  const dockCap = { hex: "bytes", symbols: "symbolTable" };
  assert.deepEqual(L.fitLayout(mine, caps, dockCap), { ...mine, center: "c", dock: "hex" });
  assert.equal(L.fitLayout({ ...mine, dock: "symbols" }, caps, dockCap).dock, null);
  assert.equal(L.fitLayout({ ...mine, center: "pcode" }, new Set(["decompile", "pcode"]), dockCap).center, "pcode");
});

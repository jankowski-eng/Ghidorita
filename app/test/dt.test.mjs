import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const r = await build({ entryPoints: [new URL("../src/renderer/dtTree.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const { flatten, catKey, normAddress, parentPath, fmtSize } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));

const T = (name, path, kind = "struct", size = 4) => ({ name, path, kind, size });
const levels = {
  [catKey("program", "/")]: { categories: [{ name: "Mine", path: "/Mine" }], types: [T("S1", "/S1")] },
  [catKey("program", "/Mine")]: { categories: [], types: [T("In", "/Mine/In")] },
};
const lookup = (s, p) => levels[catKey(s, p)];
const srcs = [{ id: "program", name: "prog" }, { id: "builtin", name: "BuiltInTypes" }];

test("flatten: lazy levels, categories before types, closed = one row", () => {
  let rows = flatten(srcs, new Set(), lookup);
  assert.deepEqual(rows.map((x) => x.label), ["prog", "BuiltInTypes"]);
  rows = flatten(srcs, new Set([catKey("program", "/")]), lookup);
  assert.deepEqual(rows.map((x) => [x.label, x.depth, x.kind]), [["prog", 0, "category"], ["Mine", 1, "category"], ["S1", 1, "type"], ["BuiltInTypes", 0, "category"]]);
  rows = flatten(srcs, new Set([catKey("program", "/"), catKey("program", "/Mine")]), lookup);
  assert.deepEqual(rows.map((x) => x.label), ["prog", "Mine", "In", "S1", "BuiltInTypes"]);
  assert.ok(rows[1].open && !rows[4].open);
  // an open category whose level has not arrived yet shows just its row
  assert.deepEqual(flatten(srcs, new Set([catKey("builtin", "/")]), lookup).map((x) => x.label), ["prog", "BuiltInTypes"]);
  assert.equal(new Set(rows.map((x) => x.key)).size, rows.length); // keys unique across sources
});
test("address text and paths", () => {
  assert.equal(normAddress("0x1000"), "0x1000"); assert.equal(normAddress(" 1A0 "), "0x1a0"); assert.equal(normAddress("0x0010"), "0x10"); assert.equal(normAddress("0"), "0x0");
  assert.equal(normAddress("main"), null); assert.equal(normAddress("0x"), null); assert.equal(normAddress(""), null);
  assert.equal(parentPath("/Mine/In"), "/Mine"); assert.equal(parentPath("/S1"), "/"); assert.equal(fmtSize(-1), "dyn"); assert.equal(fmtSize(8), "8");
});

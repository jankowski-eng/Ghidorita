import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const r = await build({ entryPoints: [new URL("../src/renderer/editActions.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const { listingKey, undoRoute, renameTarget, retypeTarget, isOwnName, tokenAt, mapPos } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));

test("listing keys", () => {
  assert.equal(listingKey({ key: "l" }), "rename"); assert.equal(listingKey({ key: "L" }), "rename");
  assert.equal(listingKey({ key: "l", meta: true }), "retype"); assert.equal(listingKey({ key: "l", ctrl: true }), "retype");
  assert.equal(listingKey({ key: ";" }), "comment"); assert.equal(listingKey({ key: "f" }), "createFunction");
  assert.equal(listingKey({ key: "t" }), "defineData"); assert.equal(listingKey({ key: "c" }), "clear");
  assert.equal(listingKey({ key: "c", meta: true }), null); // copy must not clear
  assert.equal(listingKey({ key: "f", alt: true }), null); assert.equal(listingKey({ key: "x" }), null);
});
test("undo routing", () => { assert.equal(undoRoute("input"), "text"); for (const f of ["listing", "decompiler", "other"]) assert.equal(undoRoute(f), "program"); });
const fn = { entry: "0x1000", name: "main" };
test("token -> edit", () => {
  assert.deepEqual(renameTarget({ kind: "variable", varName: "x" }, "x", fn), { kind: "variable", name: "x" });
  assert.deepEqual(renameTarget({ kind: "param", varName: "p" }, "p", fn), { kind: "variable", name: "p" });
  assert.deepEqual(renameTarget({ kind: "function", targetFunction: "0x2000" }, "foo", fn), { kind: "symbol", address: "0x2000", current: "foo" });
  assert.deepEqual(renameTarget({ kind: "function" }, "main", fn), { kind: "symbol", address: "0x1000", current: "main" });
  assert.equal(renameTarget({ kind: "function" }, "other", fn), null);
  assert.deepEqual(renameTarget({ kind: "label", address: "0x1010" }, "LAB", fn), { kind: "symbol", address: "0x1010", current: "LAB" });
  assert.equal(renameTarget({ kind: "keyword" }, "if", fn), null); assert.equal(renameTarget(undefined, "", fn), null);
  assert.equal(retypeTarget({ kind: "variable", varName: "x" }), "x"); assert.equal(retypeTarget({ kind: "function" }), null);
  assert.ok(isOwnName({ kind: "function" }, "main", fn)); assert.ok(!isOwnName({ kind: "function", targetFunction: "0x2" }, "main", fn));
});
test("tokenAt", () => {
  const t = [{ line: 1, colStart: 4, colEnd: 7, kind: "variable", varName: "abc" }];
  assert.equal(tokenAt(t, 2, 5), t[0]); assert.equal(tokenAt(t, 2, 8), t[0]); assert.equal(tokenAt(t, 2, 9), undefined); assert.equal(tokenAt(t, 1, 5), undefined);
});
test("mapPos", () => {
  const a = "a\nb\nc\nd\ne", pos = (line, col) => ({ line, col });
  assert.deepEqual(mapPos(a, a, pos(3, 1)), pos(3, 1));
  assert.deepEqual(mapPos(a, "a\nB\nc\nd\ne", pos(4, 1)), pos(4, 1)); // rename on another line
  assert.deepEqual(mapPos(a, "a\nB\nc\nd\ne", pos(2, 1)), pos(2, 1)); // on the changed line
  assert.deepEqual(mapPos(a, "a\nb\nX\nY\nc\nd\ne", pos(4, 1)), pos(6, 1)); // lines inserted above
  assert.deepEqual(mapPos("abc\nlonger line", "abc\nx", pos(2, 10)), pos(2, 2)); // clamped
  assert.deepEqual(mapPos("a\nb\nc", "a", pos(3, 1)), pos(1, 1));
});

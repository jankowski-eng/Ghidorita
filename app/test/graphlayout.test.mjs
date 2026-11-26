import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/graphLayout.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { layout, blockAt } = await import("data:text/javascript," + encodeURIComponent(js));
const N = (...ids) => ids.map((id) => ({ id, w: 100, h: 40 }));
const E = (...p) => p.map((s) => { const [from, to] = s.split(">"); return { from, to }; });

test("diamond: entry on top, branches side by side, join below, centred", () => {
  const { pos, width, height } = layout(N("a", "b", "c", "d"), E("a>b", "a>c", "b>d", "c>d"), "a");
  assert.equal(pos.get("a").y, 0); assert.equal(pos.get("b").y, pos.get("c").y); assert.ok(pos.get("b").y > 0);
  assert.ok(pos.get("d").y > pos.get("b").y); assert.notEqual(pos.get("b").x, pos.get("c").x);
  assert.equal(pos.get("a").x, (width - 100) / 2); assert.equal(height, pos.get("d").y + 40);
});

test("loop: the back edge does not push the header down; nodes in a row never overlap", () => {
  const { pos } = layout(N("a", "h", "x", "y", "e"), E("a>h", "h>x", "h>y", "x>h", "y>e", "h>e"), "a");
  assert.equal(pos.get("h").y > pos.get("a").y, true); assert.ok(pos.get("x").y > pos.get("h").y);
  const row = [...pos.values()].filter((p) => p.y === pos.get("x").y).map((p) => p.x).sort((p, q) => p - q);
  for (let i = 1; i < row.length; i++) assert.ok(row[i] - row[i - 1] >= 100);
});

test("unreachable nodes and self loops are placed; unknown edge ends ignored", () => {
  const { pos } = layout(N("a", "z"), E("a>a", "a>nope"), "a");
  assert.equal(pos.size, 2);
});

test("blockAt: containing block, else none", () => {
  const bs = [{ start: "0x10", end: "0x1f" }, { start: "0x20", end: "0x2b" }];
  assert.equal(blockAt(bs, "0x1f"), bs[0]); assert.equal(blockAt(bs, "0x20"), bs[1]); assert.equal(blockAt(bs, "0x2c"), undefined); assert.equal(blockAt(bs, null), undefined);
});

test("dedent: shared indentation goes, relative indentation and blank lines stay", async () => {
  const { dedent } = await import("data:text/javascript," + encodeURIComponent(js));
  assert.deepEqual(dedent(["    a;", "      b;", "", "    }"]), ["a;", "  b;", "", "}"]);
  assert.deepEqual(dedent(["x", "  y"]), ["x", "  y"]);
});

test("initialView: fits a graph that stays readable, else opens 1:1 on the focus block", async () => {
  const { initialView, READABLE } = await import("data:text/javascript," + encodeURIComponent(js));
  const size = { w: 824, h: 640 };
  const small = initialView(size, 28, { width: 400, height: 300 }, { x: 0, y: 0, w: 100 });
  assert.equal(small.k, 1); assert.equal(small.y, 28);
  const big = initialView(size, 28, { width: 4000, height: 9000 }, { x: 1950, y: 500, w: 100 });
  assert.equal(big.k, 1); assert.equal(big.x, 412 - 2000); assert.equal(big.y, 28 + 12 - 500);
  const fit = initialView(size, 28, { width: 4000, height: 9000 });
  assert.ok(fit.k < READABLE && fit.k > 0);
});

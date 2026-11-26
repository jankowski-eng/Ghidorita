import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/coverage.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { Coverage } = await import("data:text/javascript," + encodeURIComponent(js));

test("merges ranges and answers overlap by code unit", () => {
  const c = new Coverage([{ start: "0x20", end: "0x2f" }, { start: "0x10", end: "0x1f" }, { start: "0x100", end: "0x100" }]);
  assert.equal(c.size, 2); // 0x10-0x1f and 0x20-0x2f touch: merged
  assert.equal(c.has("0x10", 1), true);
  assert.equal(c.has("0x2f", 1), true);
  assert.equal(c.has("0x30", 4), false);
  assert.equal(c.has("0xe", 4), true); // a unit that starts before the range but overlaps it
  assert.equal(c.has("0x100", 1), true);
  assert.equal(c.has("0x101", 1), false);
  assert.equal(new Coverage([]).has("0x1", 1), false);
});

const { CoverageRuns, sharedBytes } = await import("data:text/javascript," + encodeURIComponent(js));
const cov = (...r) => new Coverage(r.map(([start, end]) => ({ start, end })));

test("runs: one run tints green, two runs show only-A, only-B and both", () => {
  const r = new CoverageRuns();
  assert.equal(r.mark("0x10", 1), "");
  const a = r.add("run a", cov(["0x10", "0x1f"], ["0x40", "0x4f"]));
  assert.equal(r.a, a.id);
  assert.equal(r.mark("0x10", 1), " cov");
  const b = r.add("run b", cov(["0x18", "0x27"]));
  r.select("b", b.id); r.select("a", a.id);
  assert.equal(r.mark("0x10", 1), " cov-a");
  assert.equal(r.mark("0x1c", 1), " cov");
  assert.equal(r.mark("0x24", 1), " cov-b");
  assert.equal(r.mark("0x40", 1), " cov-a");
  assert.equal(r.mark("0x60", 1), "");
  assert.deepEqual(r.diff(), { onlyA: 8n + 16n, onlyB: 8n, both: 8n }); // a = 0x10-0x1f + 0x40-0x4f, b = 0x18-0x27
  r.select("a", b.id); // the same run is never both
  assert.equal(r.b, null);
  r.remove(b.id);
  assert.equal(r.a, null);
  r.clear();
  assert.equal(r.runs.length, 0);
});

test("sharedBytes sweeps merged ranges", () => {
  assert.equal(sharedBytes(cov(["0x0", "0x9"], ["0x20", "0x2f"]), cov(["0x5", "0x24"])), 5n + 5n);
  assert.equal(sharedBytes(cov(), cov(["0x0", "0x1"])), 0n);
});

test("funcDiff: functions reached only in A or only in B, any overlap counts; markAny: any address of a line", () => {
  const r = new CoverageRuns();
  const fs = [{ entry: "0x10", size: 8 }, { entry: "0x20", size: 8 }, { entry: "0x30", size: 8 }, { entry: "0x40", size: 8 }];
  r.add("a", cov(["0x14", "0x14"], ["0x20", "0x27"])); // a touches f1 (partly) and f2
  assert.equal(r.funcDiff(fs), null);
  const b = r.add("b", cov(["0x20", "0x20"], ["0x3f", "0x3f"])); // b touches f2 and f3
  r.select("b", b.id); r.select("a", 1);
  const d = r.funcDiff(fs);
  assert.deepEqual(d.onlyA.map((f) => f.entry), ["0x10"]);
  assert.deepEqual(d.onlyB.map((f) => f.entry), ["0x30"]);
  assert.equal(r.markAny(["0x99", "0x14"]), " cov-a");
  assert.equal(r.markAny(["0x99"]), "");
});

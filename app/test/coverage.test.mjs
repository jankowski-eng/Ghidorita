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

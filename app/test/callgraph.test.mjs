import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/callGraph.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { nodeInfo } = await import("data:text/javascript," + encodeURIComponent(js));
const fn = (entry, source = "default", size = 16) => ({ name: "f", entry, size, source });
const runs = (marks) => ({ shown: true, mark: (a) => marks[a] ?? "" });

test("nodeInfo: naming, imports, and what the runs reached", () => {
  const off = { shown: false, mark: () => { throw new Error("not asked"); } };
  assert.deepEqual(nodeInfo({ entry: "0x10", name: "f", kind: "function" }, fn("0x10"), off), { named: false, sub: "", cov: "", ran: undefined });
  assert.equal(nodeInfo({ entry: "0x10", name: "f", kind: "function" }, fn("0x10", "user"), off).sub, "named by you");
  assert.equal(nodeInfo({ entry: "0x20", name: "_free", kind: "import" }, undefined, runs({})).sub, "import");
  const r = runs({ "0x10": " cov", "0x30": " cov-a", "0x40": " cov-b" });
  assert.equal(nodeInfo({ entry: "0x10", name: "f", kind: "function" }, fn("0x10", "user"), r).sub, "named by you · ran");
  assert.deepEqual(nodeInfo({ entry: "0x50", name: "g", kind: "function" }, fn("0x50"), r), { named: false, sub: "never ran", cov: "", ran: false });
  assert.equal(nodeInfo({ entry: "0x30", name: "a", kind: "function" }, fn("0x30"), r).sub, "ran in A only");
  assert.equal(nodeInfo({ entry: "0x40", name: "b", kind: "function" }, fn("0x40"), r).sub, "ran in B only");
});

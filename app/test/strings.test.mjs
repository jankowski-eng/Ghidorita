import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (f) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false, jsx: "automatic" })).outputFiles[0].text));
const { groupRefs } = await bundle("StringsPanel.tsx");

test("groupRefs: one entry per function, counted, pointing at its first reference", () => {
  const g = groupRefs([{ from: "0x10", function: "entry" }, { from: "0x20", function: "main" }, { from: "0x14", function: "entry" }, { from: "0x18" }]);
  assert.deepEqual(g, [{ name: "entry", from: "0x10", n: 2 }, { name: "main", from: "0x20", n: 1 }, { name: "0x18", from: "0x18", n: 1 }]);
});

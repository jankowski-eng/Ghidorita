import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (f) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
const { fill, funcSpans } = await bundle("binmap.ts");
const { AddrMap } = await bundle("addrmap.ts");

test("fill: a span covers the slices it touches, partially at the edges", () => {
  const f = fill(100, [{ pos: 5, len: 20 }], 10); // slices of 10 bytes: 5..25
  assert.deepEqual([...f].map((x) => +x.toFixed(2)), [0.5, 1, 0.5, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(fill(100, [{ pos: 0, len: 100 }, { pos: 0, len: 100 }], 4)[0], 1); // overlaps cap at 1
  assert.equal(fill(0, [{ pos: 0, len: 1 }], 4)[0], 0);
});

test("funcSpans: positions skip the gap between ranges", () => {
  const m = new AddrMap([{ start: "0x1000", size: 0x100 }, { start: "0x5000", size: 0x20 }]);
  const s = funcSpans(m, [{ name: "a", entry: "0x1010", size: 4 }, { name: "b", entry: "0x5000", size: 8 }, { name: "c", entry: "0x9000", size: 8 }]);
  assert.deepEqual(s.slice(0, 2), [{ pos: 0x10, len: 4 }, { pos: 0x100, len: 8 }]);
  assert.equal(s[2].pos, 0x11f); // shortcut: outside every range posOf clamps to the last byte; functions always lie inside a range
});

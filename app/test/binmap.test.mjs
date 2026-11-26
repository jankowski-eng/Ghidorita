import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (f) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
const binmod = await bundle("binmap.ts"), { fill, funcSpans } = binmod;
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

test("describeAt: address and containing function, else the range", () => {
  const { describeAt } = binmod;
  const m = new AddrMap([{ start: "0x1000", size: 0x100 }, { start: "0x5000", size: 0x20 }]);
  const fs = [{ name: "a", entry: "0x1010", size: 4 }, { name: "b", entry: "0x5000", size: 8 }];
  assert.equal(describeAt(m, fs, 0x12), "0x1012 · a");
  assert.equal(describeAt(m, fs, 0x100 + 4), "0x5004 · b");
  assert.equal(describeAt(m, fs, 0x50), "0x1050 · no function (range 0x1000, 256 B)");
  assert.match(describeAt(m, fs, 0x110), /range 0x5000/);
});

test("mapLayers: renamed functions, coverage in both/only A/only B, switches", async () => {
  const { mapLayers } = binmod, { intersectSpans, subtractSpans } = await bundle("coverage.ts");
  const m = new AddrMap([{ start: "0x1000", size: 0x100 }]);
  const fs = [{ name: "a", entry: "0x1000", size: 0x10, source: "user" }, { name: "b", entry: "0x1020", size: 0x10, source: "analysis" }];
  const A = [[0x1000n, 0x103fn]], B = [[0x1020n, 0x105fn]];
  assert.deepEqual(intersectSpans(A, B), [[0x1020n, 0x103fn]]);
  assert.deepEqual(subtractSpans(A, B), [[0x1000n, 0x101fn]]);
  assert.deepEqual(subtractSpans([[0n, 9n]], [[2n, 3n], [5n, 5n]]), [[0n, 1n], [4n, 4n], [6n, 9n]]);
  const on = { renamed: true, coverage: true };
  const L = mapLayers(m, fs, on, { a: { name: "A", spans: A }, b: { name: "B", spans: B } });
  assert.deepEqual(L.map((l) => l.name), ["Functions", "Renamed functions (named by you)", "Coverage in both runs", "Coverage only in A (A)", "Coverage only in B (B)"]);
  assert.deepEqual(L[1].spans, [{ pos: 0, len: 0x10 }]); // only the function named by the user
  assert.deepEqual(L[2].spans, [{ pos: 0x20, len: 0x20 }]);
  assert.deepEqual(L[3].spans, [{ pos: 0, len: 0x20 }]); assert.deepEqual(L[4].spans, [{ pos: 0x40, len: 0x20 }]);
  assert.notDeepEqual(L[3].color, L[4].color);
  const one = mapLayers(m, fs, on, { a: { name: "A", spans: A } });
  assert.deepEqual(one.map((l) => l.name).slice(2), ["Coverage (A)"]); assert.deepEqual(one[2].color, L[2].color); // one run: all green
  assert.deepEqual(mapLayers(m, fs, { renamed: false, coverage: false }, { a: { name: "A", spans: A } }).map((l) => l.name), ["Functions"]);
  // pixel mapping: 0x100 bytes into 8 rows of 0x20: the "only A" layer fills row 0 only
  assert.deepEqual([...binmod.fill(m.total, L[3].spans, 8)], [1, 0, 0, 0, 0, 0, 0, 0]);
});

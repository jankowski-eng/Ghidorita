import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (f) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
const { hexLayout, segAt, rowOf, formatRow, parseHex, stepByte } = await bundle("hex.ts");

const L = hexLayout([{ start: "0x1008", size: 0x20 }, { start: "0x1040", size: 0x10 }, { start: "code:10", size: 4 }]);

test("layout: aligned rows, one gap row between ranges of a space, none between spaces", () => {
  assert.deepEqual(L.segs.map((s) => [s.kind, s.space, s.rows, s.row]), [["data", "", 3, 0], ["gap", "", 1, 3], ["data", "", 1, 4], ["data", "code:", 1, 5]]);
  assert.equal(L.rows, 6);
  assert.equal(segAt(L, 3).kind, "gap");
  assert.equal(segAt(L, 6), null);
  assert.equal(rowOf(L, "", 0x1008n), 0);
  assert.equal(rowOf(L, "", 0x1010n), 1);
  assert.equal(rowOf(L, "", 0x1030n), 3);   // unmapped: the gap row
  assert.equal(rowOf(L, "", 0x1044n), 4);
  assert.equal(rowOf(L, "", 0x9999n), null);
  assert.equal(rowOf(L, "code:", 0x11n), 5);
});

test("a partly mapped first row shows blanks before the range, printable bytes in ASCII", () => {
  const bytes = (o) => Number(o - 0x1008n) + 0x40; // 0x40 '@', 0x41 'A', ...
  const r = formatRow(L.segs[0], 0, bytes);
  assert.equal(r.address, "0x1000");
  assert.equal(r.cells.length, 16);
  assert.deepEqual(r.cells.slice(0, 8), Array(8).fill("  "));
  assert.deepEqual(r.cells.slice(8, 11), ["40", "41", "42"]);
  assert.equal(r.ascii, "        @ABCDEFG");
});

test("loading, unreadable and non-printable bytes; the last row stops at the range end", () => {
  const last = formatRow(L.segs[2], 0, (o) => (o === 0x1040n ? undefined : o === 0x1041n ? null : o === 0x1042n ? 0x0a : 0x7f));
  assert.deepEqual(last.cells.slice(0, 4), ["··", "??", "0a", "7f"]);
  assert.equal(last.ascii.slice(0, 4), " ?..");
  assert.equal(last.cells[0x10 - 1], "7f");
  const tail = formatRow(L.segs[0], 2, () => 0x41);
  assert.equal(tail.cells[7], "41");
  assert.equal(tail.cells[8], "  "); // 0x1028 is past the range end
  assert.equal(tail.ascii, "AAAAAAAA        ");
});

test("a gap is one row that says what is missing, never an error", () => {
  const g = formatRow(L.segs[1], 0, () => { throw new Error("must not read a gap"); });
  assert.equal(g.gap, "0x1028 – 0x103f unmapped (24 bytes)");
  assert.deepEqual(g.cells, []);
  assert.equal(formatRow({ ...L.segs[1], hi: L.segs[1].lo + 1n }, 0, () => 0).gap.endsWith("(1 byte)"), true);
});

test("an empty or unusable range list has no rows", () => {
  assert.equal(hexLayout([]).rows, 0);
  assert.equal(hexLayout([{ start: "garbage", size: 4 }]).rows, 0);
});

test("parseHex", () => {
  assert.deepEqual(parseHex("48 8b 05", 3), [0x48, 0x8b, 5]);
  assert.equal(parseHex("48 8b", 3), null);
  assert.equal(parseHex("48 zz", 2), null);
});

test("stepByte moves over mapped bytes only: across a gap it lands on the next mapped byte, at the ends it stops", () => {
  assert.deepEqual(stepByte(L, "", 0x1008n, 1), { space: "", off: 0x1009n });
  assert.deepEqual(stepByte(L, "", 0x1008n, 16), { space: "", off: 0x1018n });
  assert.deepEqual(stepByte(L, "", 0x1027n, 1), { space: "", off: 0x1040n });   // over the gap 0x1028..0x103f
  assert.deepEqual(stepByte(L, "", 0x1040n, -1), { space: "", off: 0x1027n });
  assert.deepEqual(stepByte(L, "", 0x1020n, 16), { space: "", off: 0x1040n });  // a row down into the gap: the next range
  assert.deepEqual(stepByte(L, "", 0x1008n, -1), null);                        // first byte
  assert.deepEqual(stepByte(L, "", 0x104fn, 1), null);                         // last byte of the last range in that space
  assert.equal(stepByte(L, "", 0x1030n, 1), null);                             // not on a mapped byte
});

test("stepByte past the last or before the first mapped byte of the space clamps to it, not to the current range's end", () => {
  assert.deepEqual(stepByte(L, "", 0x1020n, 64), { space: "", off: 0x104fn });
  assert.deepEqual(stepByte(L, "", 0x1048n, -64), { space: "", off: 0x1008n });
  assert.equal(stepByte(L, "", 0x104fn, 1), null);
  assert.equal(stepByte(L, "", 0x1008n, -1), null);
});

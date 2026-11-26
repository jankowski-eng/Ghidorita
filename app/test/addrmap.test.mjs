import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (f) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
const { AddrMap } = await bundle("addrmap.ts");
const { parseAddr, addrAdd, intersects } = await bundle("address.ts");

test("pos/addr round trip over two ranges with a gap", () => {
  const m = new AddrMap([{ start: "0x1000", size: 0x100 }, { start: "0x5000", size: 0x20 }]);
  assert.equal(m.total, 0x120);
  assert.equal(m.addr(0), "0x1000");
  assert.equal(m.addr(0xff), "0x10ff");
  assert.equal(m.addr(0x100), "0x5000");
  assert.equal(m.addr(1e9), "0x501f");
  for (const p of [0, 1, 0xff, 0x100, 0x11f]) assert.equal(m.pos(BigInt(m.addr(p))), p);
  assert.equal(m.pos(0x2000n), 0x100); // gap -> next range
  assert.equal(m.pos(0x9000n), 0x11f); // past end
  assert.equal(m.pos(0x10n), 0);       // before start
});

test("spaces: ranges in sidecar order, qualified addresses, offsets above 2^63", () => {
  const m = new AddrMap([{ start: "0x401000", size: 0x100 }, { start: "0xfffffffffffff000", size: 0x20 }, { start: "OVL1::1000", size: 0x10 }, { start: "code:0", size: 0x8 }]);
  assert.equal(m.total, 0x138);
  assert.equal(m.addr(0x100), "0xfffffffffffff000");
  assert.equal(m.addr(0x120), "OVL1::1000");
  assert.equal(m.addr(0x12f), "OVL1::100f");
  assert.equal(m.addr(0x130), "code:0");
  for (const p of [0, 0xff, 0x100, 0x11f, 0x120, 0x12f, 0x130, 0x137]) assert.equal(m.posOf(m.addr(p)), p, String(p));
  assert.equal(m.posOf("0xffffffffffffffff"), 0x120); // past the end of that range -> start of the next
  assert.equal(m.posOf("OVL1::2000"), 0x130);         // gap inside the overlay space -> next range
  assert.equal(m.posOf("nospace:10"), 0);             // unknown space
  assert.equal(m.posOf("OVL1::10"), 0x120);           // before the first range of its space: start of that space's first range
});

test("address parsing, arithmetic, intersection", () => {
  assert.deepEqual(parseAddr("0xFFFFFFFFFFFFFFFF"), { space: "", off: 2n ** 64n - 1n });
  assert.deepEqual(parseAddr("OVL1::1000"), { space: "OVL1::", off: 0x1000n });
  assert.deepEqual(parseAddr("code:ff"), { space: "code:", off: 0xffn });
  for (const bad of ["", "0x", "0x10000000000000000", "-1", "nohex:zz", "12"]) assert.equal(parseAddr(bad), null, bad);
  assert.equal(addrAdd("OVL1::1000", 4), "OVL1::1004");
  assert.equal(addrAdd("0xfffffffffffffffe", 5), "0xffffffffffffffff"); // clamps, never wraps
  const r = [{ start: "0x10", end: "0x13" }, { start: "OVL1::5", end: "OVL1::5" }];
  assert.ok(intersects(parseAddr("0x12"), 1, r));
  assert.ok(intersects(parseAddr("0xe"), 4, r));    // unit [0xe, 0x11] overlaps
  assert.ok(!intersects(parseAddr("0x14"), 4, r));
  assert.ok(!intersects(parseAddr("0x5"), 1, r));   // same offset, other space
  assert.ok(intersects(parseAddr("OVL1::4"), 2, r));
});

test("offIn: offset in a given space, null otherwise", async () => {
  const { offIn } = await bundle("address.ts");
  assert.equal(offIn("0xffffffffffffffff", ""), 0xffffffffffffffffn);
  assert.equal(offIn("OVL1::1000", "OVL1::"), 0x1000n);
  assert.equal(offIn("OVL1::1000", ""), null);
  assert.equal(offIn("0x1000", "OVL1::"), null);
  assert.equal(offIn("code:10", "code:"), 0x10n);
});

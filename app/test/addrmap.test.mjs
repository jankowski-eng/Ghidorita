import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/addrmap.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { AddrMap } = await import("data:text/javascript," + encodeURIComponent(js));

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

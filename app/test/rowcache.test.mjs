import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (f) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
const { RunCache, spliceRows, indexAt } = await bundle("rowcache.ts");
const { parseAddr } = await bundle("address.ts");

// A fake program: units [{a, len}] in one space; fetch(address, count) walks forward like listing_rows.
const hex = (n) => "0x" + n.toString(16);
const prog = (lens, base = 0x1000) => { let a = base; return lens.map((l, k) => { const u = { address: hex(a), length: l, bytes: "", mnemonic: "m" + k, operands: "" }; a += l; return u; }); };
const fetcher = (units, log = []) => async (address, count) => { log.push([address, count]); const i = units.findIndex((u) => parseInt(u.address, 16) + u.length > parseInt(address, 16)); return i < 0 ? [] : units.slice(i, i + count); };
const rng = (a, b = a) => [{ start: hex(a), end: hex(b) }];

test("no intersecting row: nothing to do, no fetch", async () => {
  const units = prog([4, 4, 4, 4]), log = [];
  assert.equal(await spliceRows(units, rng(0x5000), fetcher(units, log)), null);
  assert.equal(await spliceRows(units, [{ start: "OVL1::1000", end: "OVL1::1003" }], fetcher(units, log)), null); // other space
  assert.deepEqual(log, []);
});

test("an edit inside one row refetches just that span, rest is kept", async () => {
  const old = prog([4, 4, 4, 4, 4]);
  const now = old.map((u, k) => (k === 2 ? { ...u, comment: "new" } : u));
  const log = [];
  const r = await spliceRows(old, rng(0x1009), fetcher(now, log));
  assert.equal(r.rows.length, 5); assert.equal(r.rows[2].comment, "new"); assert.equal(r.rows[1], old[1]); assert.equal(r.rows[3], old[3]);
  assert.equal(log.length, 1); assert.equal(log[0][0], "0x1008");
});

test("a unit split into several (clear code) and several merged into one (define data)", async () => {
  const old = prog([2, 8, 2, 2]);
  const split = prog([2, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
  const r = await spliceRows(old, rng(0x1002, 0x1009), fetcher(split));
  assert.deepEqual(r.rows.map((x) => x.address), split.map((x) => x.address));
  const old2 = prog([2, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
  const merged = prog([2, 8, 2, 2]);
  const r2 = await spliceRows(old2, rng(0x1002, 0x1009), fetcher(merged));
  assert.deepEqual(r2.rows.map((x) => x.address), merged.map((x) => x.address));
});

test("new units not lining up with the old rows behind: the tail is dropped, atEnd cleared", async () => {
  const old = prog([4, 4, 4]);
  const now = prog([4, 6, 2, 4]); // second unit grew into the third; its boundary no longer matches
  const r = await spliceRows(old, rng(0x1004), fetcher(now), true);
  assert.deepEqual(r.rows.map((x) => x.address), ["0x1000", "0x1004"]);
  assert.equal(r.atEnd, false);
});

test("the end of the listing inside the span sets atEnd", async () => {
  const old = prog([4, 4]);
  const r = await spliceRows(old, rng(0x1004, 0x1007), fetcher(prog([4, 2, 2])), false);
  assert.equal(r.atEnd, true); assert.equal(r.rows.length, 3);
});

test("RunCache: take by address, LRU cap, overlap drops the older run, invalidate by ranges", () => {
  const c = new RunCache(2);
  const run = (rows) => ({ rows, atStart: false, atEnd: false });
  const A = prog([4, 4, 4], 0x1000), B = prog([4, 4, 4], 0x2000), C = prog([4, 4, 4], 0x3000);
  c.put(run(A)); c.put(run(B)); c.put(run(C));
  assert.equal(c.runs.length, 2);
  assert.equal(c.take(parseAddr("0x1004")), null);          // A was evicted
  assert.equal(c.take(parseAddr("0x2006")).rows, B);        // inside a unit of B
  assert.equal(c.runs.length, 1);                            // taken out
  c.put(run(B)); c.put(run(prog([4, 4], 0x2004)));           // overlaps B: B dropped
  assert.equal(c.runs.length, 2); assert.ok(c.runs.every((r) => r.rows !== B));
  c.invalidate(rng(0x3004));
  assert.equal(c.runs.length, 1);
  c.invalidate(null); assert.equal(c.runs.length, 0);
  assert.equal(indexAt(A, parseAddr("0x1005")), 1);
});

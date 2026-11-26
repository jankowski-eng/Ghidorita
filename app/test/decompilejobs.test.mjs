import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const r = await build({ entryPoints: [new URL("../src/renderer/decompileJobs.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const { decompileJobs } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));

const fake = () => {
  const calls = [];
  return { calls, callCancellable: (m, p) => { const c = { m, p, cancelled: false }; c.result = new Promise((res) => { c.resolve = res; }); c.cancel = () => { c.cancelled = true; }; calls.push(c); return c; } };
};

test("superseding cancels the previous request; its late result is not current", async () => {
  const b = fake(), jobs = decompileJobs(b);
  const a = jobs.start(1, "0x1"), a2 = jobs.start(1, "0x2");
  assert.equal(b.calls[0].cancelled, true);
  assert.equal(b.calls[1].cancelled, false);
  b.calls[0].resolve("late");
  assert.equal(await a.result, "late");
  assert.equal(a.current(), false);
  assert.equal(a2.current(), true);
  a.done(); assert.equal(a2.current(), true); // a stale finish must not clear the newer job
});

test("drop cancels; other tabs untouched", () => {
  const b = fake(), jobs = decompileJobs(b);
  const x = jobs.start(1, "0x1"), y = jobs.start(2, "0x2");
  jobs.drop(1);
  assert.deepEqual(b.calls.map((c) => c.cancelled), [true, false]);
  assert.equal(x.current(), false); assert.equal(y.current(), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { patchPreview } = await import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL("../src/renderer/patch.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
const A = { address: "0x1000", bytes: "90", length: 1, oldBytes: "48 89 e5", oldLength: 3, overwrites: 0 };

test("a patch that fits is allowed and says how many old bytes stay", () => {
  assert.deepEqual(patchPreview(A, false), { message: "90 (1 byte) replaces 48 89 e5; 2 bytes of the old instruction stay", ok: true });
  assert.equal(patchPreview({ ...A, bytes: "ff d0 90", length: 3 }, false).message, "ff d0 90 (3 bytes) replaces 48 89 e5");
});

test("a longer patch needs the overwrite choice and names how many instructions it eats", () => {
  const long = { ...A, bytes: "b8 78 56 34 12", length: 5, overwrites: 1 };
  const no = patchPreview(long, false);
  assert.equal(no.ok, false);
  assert.match(no.message, /longer than the 3-byte instruction.*1 following instruction\./);
  assert.deepEqual(patchPreview(long, true), { message: "b8 78 56 34 12 (5 bytes) replaces 48 89 e5; also overwrites 1 following instruction", ok: true });
});

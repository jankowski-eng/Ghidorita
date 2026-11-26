import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const load = async (f) => {
  const r = await build({ entryPoints: [new URL(`../src/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node", external: ["electron"] });
  return import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
};
const { checkDrop } = await load("main/drop.ts");
const { dropBlock } = await load("renderer/dropAllowed.ts");
const kind = (p) => (p.endsWith("/dir") ? "dir" : p.endsWith("/gone") ? "none" : "file");

test("checkDrop: one file is fine, everything else is refused with a message", () => {
  assert.deepEqual(checkDrop(["/tmp/a.bin"], kind), { path: "/tmp/a.bin" });
  for (const bad of [[], undefined, "x", ["/tmp/a", "/tmp/b"], ["/tmp/dir"], ["/tmp/gone"], [""], ["rel/a"], [42], ["/tmp/a\0b"]]) assert.ok("error" in checkDrop(bad, kind), JSON.stringify(bad));
  assert.match(checkDrop(["/tmp/dir"], kind).error, /folder/);
  assert.match(checkDrop(["/a", "/b"], kind).error, /one file/);
});

test("dropBlock: only an idle window accepts a drop; a program may be open", () => {
  const ok = { opening: false, closing: false, unavailable: false, modal: false };
  assert.equal(dropBlock(ok), null);
  assert.match(dropBlock({ ...ok, opening: true }), /being opened/);
  assert.match(dropBlock({ ...ok, modal: true }), /dialog/);
  assert.ok(dropBlock({ ...ok, closing: true }));
  assert.ok(dropBlock({ ...ok, unavailable: true }));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/names.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { notRenamed } = await import("data:text/javascript," + encodeURIComponent(js));

test("only a name set by a person counts as renamed", () => {
  assert.equal(notRenamed("user"), false);
  for (const s of ["default", "analysis", "imported", "other", undefined]) assert.equal(notRenamed(s), true);
});

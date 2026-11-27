import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/warnings.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { plainWarning, prefixNotes } = await import("data:text/javascript," + encodeURIComponent(js));

test("known warnings are put in plain words, unknown ones lose only the prefix", () => {
  assert.match(plainWarning("WARNING: Subroutine does not return"), /never returns/);
  assert.match(plainWarning("WARNING (jumptable): Could not recover jumptable at 0x1. Too many branches"), /switch table/);
  assert.equal(plainWarning("WARNING: Something new happened"), "Something new happened");
});

test("in_ / unaff_ / extraout_ are explained only when a warning mentions them", () => {
  assert.deepEqual(prefixNotes(["WARNING: Subroutine does not return"]), []);
  const n = prefixNotes(["WARNING: uses in_RDI and unaff_RBX", "extraout_RAX too"]);
  assert.equal(n.length, 3);
  assert.deepEqual(prefixNotes(["only extraout_x"]).length, 1);
});

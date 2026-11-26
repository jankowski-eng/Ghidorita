import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/commandActions.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { ACTIONS, matchActions } = await import("data:text/javascript," + encodeURIComponent(js));

test("empty query lists everything, words match in any order", () => {
  assert.equal(matchActions("").length, ACTIONS.length);
  assert.deepEqual(matchActions("TABLE symbol").map((a) => a.label), ["Symbol Table"]);
  assert.deepEqual(matchActions("nope"), []);
});

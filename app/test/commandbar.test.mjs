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

const { addressOf } = await import("data:text/javascript," + encodeURIComponent((await (await import("esbuild")).build({ entryPoints: [new URL("../src/renderer/parseGoto.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));

test("addressOf: 0x and qualified addresses go to the bar's Go-to row, bare words and bare hex stay names", () => {
  assert.equal(addressOf("0x00401000"), "0x401000");
  assert.equal(addressOf(" 0X1F "), "0x1f");
  assert.equal(addressOf("code:1000"), "code:1000");
  assert.equal(addressOf("main"), null);
  assert.equal(addressOf("add"), null);
  assert.equal(addressOf("0xzz"), null);
});

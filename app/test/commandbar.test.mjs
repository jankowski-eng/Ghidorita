import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/commandActions.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { ACTIONS, matchActions, layoutActions } = await import("data:text/javascript," + encodeURIComponent(js));

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

test("the copy actions are in the command bar", () => {
  assert.deepEqual(matchActions("copy").map((a) => a.label), ["Copy Address", "Copy Bytes (Hex)", "Copy Bytes (C Array)", "Copy Decompiled Function"]);
  assert.equal(matchActions("c array")[0].cmd.what, "carray");
});

test("saved layouts are command bar actions: Layout: <name>, save, delete (not the Default), move panes", () => {
  const extra = layoutActions(["Default", "Reversing"]);
  assert.deepEqual(matchActions("layout", extra).map((a) => a.label), ["Layout: Default", "Layout: Reversing", "Layout: Save Current As…", "Layout: Delete Reversing"]);
  assert.deepEqual(matchActions("layout revers", extra)[0].cmd, { type: "layout", op: "apply", name: "Reversing" });
  assert.equal(matchActions("move listing left", extra)[0].cmd.dir, -1);
  assert.equal(matchActions("layout", []).length, 0);
});

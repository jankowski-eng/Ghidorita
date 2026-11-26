import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/copy.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { cArray, addressAtCursor, BYTES_MAX } = await import("data:text/javascript," + encodeURIComponent(js));

test("a short unit is one line of C", () => {
  assert.equal(cArray("48 8b 05"), "unsigned char bytes[] = { 0x48, 0x8b, 0x05 };");
  assert.equal(cArray("90"), "unsigned char bytes[] = { 0x90 };");
  assert.equal(cArray("DE AD", "buf"), "unsigned char buf[] = { 0xde, 0xad };", "upper case input is normalised, the name is a parameter");
});

test("nothing copies as an empty initializer", () => assert.equal(cArray(""), "unsigned char bytes[] = {  };"));

test("12 bytes stay on one line, 13 wrap at 12 per line without a trailing comma", () => {
  const hex = (n) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(2, "0")).join(" ");
  assert.ok(!cArray(hex(12)).includes("\n"));
  assert.equal(cArray(hex(13)), "unsigned char bytes[] = {\n  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,\n  0x0c\n};");
  assert.equal(cArray(hex(24)).split("\n").length, 4);
});

test("the cap is 64 KiB, like get_bytes", () => assert.equal(BYTES_MAX, 65536));

test("the address of a decompiler cursor: call target, global, instruction, line, function", () => {
  const t = (line, extra) => ({ line, colStart: 0, colEnd: 1, kind: "default", ...extra });
  const tokens = [t(0), t(1, { address: "0x10" }), t(2, { address: "0x20", kind: "variable", varAddress: "0x9000" })];
  assert.equal(addressAtCursor({ ...t(1), targetFunction: "0x500", address: "0x10" }, tokens, 1, "0x1"), "0x500");
  assert.equal(addressAtCursor(tokens[2], tokens, 2, "0x1"), "0x9000");
  assert.equal(addressAtCursor(tokens[1], tokens, 1, "0x1"), "0x10");
  assert.equal(addressAtCursor(undefined, tokens, 1, "0x1"), "0x10", "no token: the first address on the line");
  assert.equal(addressAtCursor(undefined, tokens, 0, "0x1"), "0x1", "nothing on the line: the function's entry");
});

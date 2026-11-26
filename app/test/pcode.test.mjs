import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { pcodeLines, linesAt } = await import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL("../src/renderer/pcode.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text));
const R = {
  raw: [{ address: "0x1000", asm: "LEA RCX,[RCX + 0x5]", ops: ["u = INT_ADD RCX, 0x5", "RCX = COPY u"] }, { address: "0x1004", asm: "RET", ops: ["RETURN RAX"] }],
  high: [{ block: 0, address: "0x1000", text: "u = INT_ADD ECX (x), 0x5" }, { block: 1, address: "0x1004", text: "RETURN 0x0" }],
  truncated: false,
};

test("raw lines: a header per instruction, its ops indented; high lines: a header per block, the address before each op", () => {
  assert.deepEqual(pcodeLines(R, "raw").map((l) => l.text), ["0x1000  LEA RCX,[RCX + 0x5]", "    u = INT_ADD RCX, 0x5", "    RCX = COPY u", "0x1004  RET", "    RETURN RAX"]);
  assert.deepEqual(pcodeLines(R, "high").map((l) => [l.text, l.head ?? false]), [["block 0", true], ["0x1000  u = INT_ADD ECX (x), 0x5", false], ["block 1", true], ["0x1004  RETURN 0x0", false]]);
  assert.deepEqual(pcodeLines({ raw: [], high: [], truncated: false }, "raw"), []);
});

test("the cursor marks the lines of its instruction: the greatest instruction address at or below it, only that instruction's lines", () => {
  const instrs = ["0x1000", "0x1004", "0x1008"]; // 0x1008 has no high op: the decompiler dropped it
  const raw = pcodeLines(R, "raw"), high = pcodeLines(R, "high");
  assert.deepEqual(linesAt(raw, "0x1000", instrs), [0, 1, 2]);
  assert.deepEqual(linesAt(raw, "0x1002", instrs), [0, 1, 2]); // inside the first instruction
  assert.deepEqual(linesAt(raw, "0x1004", instrs), [3, 4]);
  assert.deepEqual(linesAt(raw, "0xfff", instrs), []);      // before the function
  assert.deepEqual(linesAt(raw, "code:1004", instrs), []);   // another address space
  assert.deepEqual(linesAt(raw, null, instrs), []);
  assert.deepEqual(linesAt(high, "0x1004", instrs), [3]);
  assert.deepEqual(linesAt(high, "0x1009", instrs), []);     // on the dropped instruction: not the previous instruction's ops
});

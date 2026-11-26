import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const load = async (f) => {
  const r = await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node" });
  return import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
};
const { lineForAddress, firstAddress, bpLines, inFunction, changedRegs, parseTarget, debugLabel } = await load("debug.ts");
const { programReducer, initialProgram } = await load("store/program.ts");

// two statements: line 3 holds 0x1010 and 0x1014, line 4 holds 0x1020; line 5 has no address
const tokens = [{ line: 3, address: "0x1014" }, { line: 3, address: "0x1010" }, { line: 4, address: "0x1020" }, { line: 5 }, { line: 6, address: "ram:30" }];

test("lineForAddress: the exact token's line, else the nearest mapped address before the stop", () => {
  assert.equal(lineForAddress(tokens, "0x1014"), 3);
  assert.equal(lineForAddress(tokens, "0x1020"), 4);
  assert.equal(lineForAddress(tokens, "0x1018"), 3); // an instruction between two mapped ones belongs to the statement before it
  assert.equal(lineForAddress(tokens, "0x1100"), 4);
  assert.equal(lineForAddress(tokens, "0x1000"), 3); // in the prologue, before everything mapped: the first mapped line
  assert.equal(lineForAddress(tokens, "ram:1000"), null);
});

test("firstAddress and bpLines: a line's breakpoint address is its lowest mapped address", () => {
  assert.equal(firstAddress(tokens, 3), "0x1010");
  assert.equal(firstAddress(tokens, 5), null);
  assert.deepEqual(bpLines(tokens, ["0x1010", "0x1020", "0x1014", "0x9999"]), [3, 4]); // 0x1014 is not a line's first address
  assert.deepEqual(bpLines(tokens, []), []);
});

test("inFunction, parseTarget, debugLabel", () => {
  assert.ok(inFunction({ entry: "0x1000", size: 0x20 }, "0x101f")); assert.ok(!inFunction({ entry: "0x1000", size: 0x20 }, "0x1020"));
  assert.deepEqual(parseTarget("localhost:1234"), { host: "localhost", port: 1234 });
  assert.deepEqual(parseTarget(" 10.0.0.2 "), { host: "10.0.0.2", port: 1234 });
  assert.deepEqual(parseTarget(":4321"), { host: "localhost", port: 4321 });
  assert.equal(debugLabel(null), ""); assert.equal(debugLabel({ state: "stopped", address: "0x28" }), "stopped at 0x28");
  assert.equal(debugLabel({ state: "detached", error: "The target exited with status 0" }), "detached (The target exited with status 0)");
});

test("changedRegs: the registers that differ from the last stop, with their earlier value", () => {
  assert.deepEqual(changedRegs({}, [{ name: "r0", value: "0x1" }]), {}); // the first stop has nothing to compare with
  assert.deepEqual(changedRegs({ r0: "0x1", r1: "0x2" }, [{ name: "r0", value: "0x1" }, { name: "r1", value: "0x3" }, { name: "r2", value: "0x4" }]), { r1: "0x2" });
});

test("program: registers changed since the last stop; a repeated state is not a new stop; detaching forgets", () => {
  const st = (stop, r0, extra = {}) => ({ type: "debug", state: { state: "stopped", target: "h:1", stop, offset: "0x0", breakpoints: [], address: "0x28", registers: [{ name: "r0", value: r0 }, { name: "pc", value: "0x28" }], ...extra } });
  let s = programReducer(initialProgram, st(1, "0x1"));
  assert.deepEqual(s.debug.changed, {});
  s = programReducer(s, { type: "debug", state: { state: "running", target: "h:1", stop: 1, offset: "0x0", breakpoints: [] } });
  assert.equal(s.debug.state, "running");
  s = programReducer(s, st(2, "0x5"));
  assert.deepEqual(s.debug.changed, { r0: "0x1" });
  s = programReducer(s, st(2, "0x5", { breakpoints: ["0x8"] })); // a breakpoint toggled while stopped
  assert.deepEqual(s.debug.changed, { r0: "0x1" }); assert.deepEqual(s.debug.breakpoints, ["0x8"]);
  s = programReducer(s, { type: "debug", state: { state: "detached", target: "", stop: 2, offset: "0x0", breakpoints: ["0x8"], error: "Lost the connection to the target" } });
  assert.deepEqual(s.debugLast, {});
  assert.deepEqual(programReducer(s, { type: "program", program: null }).debug, null);
});

const { lineStarts, statementRange } = await load("debug.ts");
test("lineStarts and statementRange: statement starts, and the instructions behind a line", () => {
  assert.deepEqual(lineStarts(tokens), ["0x1010", "0x1020"]); // the lowest address of each line with one; "ram:30" is another space
  assert.deepEqual(statementRange(tokens, 3, "0x1014"), { start: "0x1010", end: "0x101f" }); // up to the next statement start
  assert.deepEqual(statementRange(tokens, 4, "0x1020"), { start: "0x1020", end: "0x1020" }); // the last statement: its first address only
  assert.deepEqual(statementRange(tokens, 3, "0x1000"), { start: "0x1000", end: "0x101f" }); // the prologue before the first statement belongs to it
  assert.equal(statementRange(tokens, 5, "0x1000"), null);
});

const { lineValues, hexRows } = await load("debug.ts");
const { shownDebug } = await load("store/program.ts");

test("lineValues: the variables of a line with their values, and what they were", () => {
  const text = "  a = f(b);\n  return a;", toks = [{ line: 0, colStart: 2, colEnd: 3, kind: "variable" }, { line: 0, colStart: 8, colEnd: 9, kind: "param" }, { line: 0, colStart: 4, colEnd: 5, kind: "default" }, { line: 1, colStart: 9, colEnd: 10, kind: "variable" }];
  const items = [{ name: "a", value: "5" }, { name: "b", value: "2" }];
  assert.deepEqual(lineValues(toks, text, items, { a: "3", b: "2" }), [{ line: 0, text: "   ← a = 5 (was 3), b = 2" }, { line: 1, text: "   ← a = 5 (was 3)" }]);
  assert.deepEqual(lineValues(toks, text, [], {}), []);
});

test("hexRows: rows of 16, ASCII, bytes that changed since the earlier read", () => {
  const rows = hexRows(0x1000n, "41424300" + "ff".repeat(12), "41424300" + "00".repeat(12));
  assert.equal(rows.length, 1); assert.equal(rows[0].address, "0x1000"); assert.equal(rows[0].ascii, "ABC" + ".".repeat(13));
  assert.deepEqual(rows[0].bytes.map((b) => b.changed).slice(2, 5), [false, false, true]);
  assert.equal(hexRows(0x10n, "00".repeat(20)).length, 2);
});

test("program: stepping back through the recorded stops, values with what they were, a new stop is live again", () => {
  const stop = (n, r0) => ({ type: "debug", state: { state: "stopped", target: "h:1", stop: n, offset: "0x0", breakpoints: [], address: "0x" + n, registers: [{ name: "r0", value: r0 }] } });
  let s = [stop(1, "0x1"), stop(2, "0x2"), stop(3, "0x3")].reduce(programReducer, initialProgram);
  assert.equal(s.debugHistory.length, 3); assert.equal(shownDebug(s).stop, 3);
  s = programReducer(s, { type: "debugView", to: "back" }); assert.equal(shownDebug(s).stop, 2);
  s = programReducer(s, { type: "debugView", to: "back" }); s = programReducer(s, { type: "debugView", to: "back" }); assert.equal(shownDebug(s).stop, 1); // the oldest: no further back
  s = programReducer(s, { type: "debugView", to: "forward" }); s = programReducer(s, { type: "debugView", to: "forward" }); assert.equal(s.debugAt, null); assert.equal(shownDebug(s).stop, 3); // forward from the newest recorded one is the live stop
  s = programReducer(s, { type: "debugView", to: "back" }); assert.equal(s.debugAt, 1);
  s = programReducer(s, stop(4, "0x4")); assert.equal(s.debugAt, null); assert.equal(shownDebug(s).stop, 4); // a new stop returns to live
  s = programReducer(s, { type: "debugValues", stop: 3, entry: "0x10", items: [{ name: "a", value: "1" }] });
  s = programReducer(s, { type: "debugValues", stop: 4, entry: "0x10", items: [{ name: "a", value: "2" }] });
  assert.deepEqual(s.debug.values.was, { a: "1" }); assert.deepEqual(s.debugHistory[3].values.items[0].value, "2");
  s = programReducer(s, { type: "debugValues", stop: 99, entry: "0x10", items: [] }); assert.equal(s.debugHistory.length, 4);
  assert.deepEqual(programReducer(s, { type: "debug", state: { state: "detached", target: "", stop: 4, offset: "0x0", breakpoints: [] } }).debugHistory, []);
});

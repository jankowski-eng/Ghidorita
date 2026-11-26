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

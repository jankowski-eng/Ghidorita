import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const r = await build({
  stdin: { contents: `export { debugTools, afterSend } from "./src/agent/tools/debug.ts"; export { TOOLS } from "./src/agent/tools/index.ts"; export { visibleTools } from "./src/agent/access.ts"; export { ToolError } from "./src/agent/types.ts"; export { BackendError } from "./src/renderer/backend.ts";`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
  bundle: true, format: "esm", write: false, platform: "node",
});
const { debugTools, afterSend, TOOLS, visibleTools, ToolError, BackendError } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
const t = (n) => debugTools.find((x) => x.name === n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKENS = [{ line: 2, colStart: 2, colEnd: 8, kind: "keyword", address: "0x401010" }, { line: 3, colStart: 2, colEnd: 8, kind: "keyword", address: "0x401020" }, { line: 4, colStart: 0, colEnd: 1, kind: "keyword", address: "0x401030" }];
const regs = (n) => [{ name: "r0", value: "0x" + n.toString(16) }, { name: "pc", value: "0x4010" }];
/** a scripted debugger: `emit` publishes a debug_state of any session; a command calls `onCmd` so the test decides what the target does */
function fake(over = {}) {
  const log = [], listeners = new Set(), dec = { n: 0 };
  let st = { state: "stopped", target: "h:1", stop: 1, offset: "0x0", breakpoints: [], address: "0x401010", registers: regs(1) };
  const emit = (s, sid = "s1") => { st = s; listeners.forEach((l) => l(sid, s)); };
  const stopAt = (address, extra = {}) => emit({ ...st, state: "stopped", stop: st.stop + 1, address, registers: regs(st.stop + 1), ...extra });
  const dbg = {
    status: async () => st,
    attach: async (p) => { log.push(["attach", p]); dbg.onCmd?.("attach"); },
    detach: async () => { log.push(["detach"]); st = { ...st, state: "detached" }; },
    breakpoint: async (p) => { log.push(["bp", p]); st = { ...st, breakpoints: st.breakpoints.includes(p.address) ? [] : [p.address] }; },
    continue: async () => { log.push(["continue"]); st = { ...st, state: "running" }; dbg.onCmd?.("continue"); },
    step: async (p) => { log.push(["step", p]); dbg.onCmd?.("step"); },
    pause: async () => { log.push(["pause"]); dbg.onCmd?.("pause"); },
    memory: async ({ address, length }) => { log.push(["memory", address, length]); return { address, bytes: "41424344" + "00".repeat(length - 4), items: [{ offset: 0, length: 4, type: "int", name: "", value: "1" }] }; },
    values: () => ({ cancel() {}, result: Promise.resolve({ pc: st.address, items: [{ name: "x\nEVIL", kind: "local", type: "int", size: 4, where: "stack-8", value: "5", raw: "0x5" }] }) }),
    ...over.dbg,
  };
  const FN = { name: "main", entry: "0x401000", size: 64, signature: "int main(void)" };
  const ops = {
    debug: dbg,
    functions: { containing: async () => FN, list: async () => [FN] },
    decompiler: { decompile: () => { dec.n++; return { cancel() {}, result: Promise.resolve({ text: "int main(void)\n{\n  a = 1;\n  b = 2;\n}", tokens: over.tokens ?? TOKENS }) }; } },
    searches: { searchSymbols: () => ({ cancel() {}, result: Promise.resolve([{ name: "main", address: "0x401000", kind: "function" }]) }) },
  };
  const backend = { capabilities: new Set(over.caps ?? ["debugger", "decompile"]), events: { onDebug: (l) => { listeners.add(l); return () => listeners.delete(l); } } };
  const ctl = new AbortController();
  const ctx = { ops, session: { sessionId: "s1", programId: "p", name: "prog" }, backend, signal: ctl.signal, client: "t", mode: "full", changes: { newest: () => null }, functions: async () => [FN], tag: (p) => p };
  return { ctx, ops, dbg, log, listeners, emit, stopAt, ctl, dec, get st() { return st; } };
}
const fails = async (p, re) => { try { await p; } catch (e) { assert.ok(e instanceof ToolError, `ToolError expected, got ${e}`); if (re) assert.match(e.message, re); return e.message; } assert.fail("expected a ToolError"); };

test("all tools are Full-only, gated on the debugger capability, strict schemas, registered", () => {
  assert.deepEqual(debugTools.map((x) => x.name), ["debug_attach", "debug_state", "debug_step", "debug_continue", "debug_pause", "debug_breakpoint", "debug_values", "debug_memory", "debug_detach"]);
  for (const x of debugTools) {
    assert.equal(x.access, "full"); assert.equal(x.capability, "debugger"); assert.equal(x.inputSchema.additionalProperties, false);
    for (const h of ["readOnlyHint", "destructiveHint", "idempotentHint"]) assert.equal(typeof x.annotations[h], "boolean");
    assert.ok(TOOLS.includes(x));
    for (const q of x.inputSchema.required ?? []) assert.ok(q in x.inputSchema.properties);
  }
  for (const m of ["off", "read", "edit"]) assert.deepEqual(visibleTools(m, {}, debugTools), []);
  assert.deepEqual(visibleTools("full", { capabilities: new Set(["decompile"]) }, debugTools), []);
  assert.equal(visibleTools("full", { capabilities: new Set(["debugger"]) }, debugTools).length, 9);
});

test("step waits for the matching stop; the listener is registered before the command and removed after", async () => {
  const f = fake();
  await t("debug_state").handler(f.ctx, {}); // the first print has nothing to compare with
  f.dbg.onCmd = () => { assert.equal(f.listeners.size, 1, "listener registered before the command is sent"); f.stopAt("0x401020"); }; // a stop that comes at once
  const out = await t("debug_step").handler(f.ctx, { mode: "instruction" });
  assert.match(out, /^Stopped at 0x401020  main\+0x20  \| b = 2;\nStop 2; target h:1\nRegisters: r0=0x2\* pc=0x4010 {2}\(\* changed/);
  assert.deepEqual(f.log[0], ["step", { mode: "instruction" }]);
  assert.equal(f.listeners.size, 0);
});

test("stale-session stops and repeats of the same stop do not resolve the wait", async () => {
  const f = fake();
  f.dbg.onCmd = () => setTimeout(() => { f.emit({ ...f.st, stop: 9, address: "0x999" }, "other"); f.emit({ ...f.st, stop: 1 }); setTimeout(() => f.stopAt("0x401030"), 20); }, 5);
  const out = await t("debug_step").handler(f.ctx, { mode: "instruction" });
  assert.match(out, /^Stopped at 0x401030/);
  assert.equal(f.listeners.size, 0);
});

test("a wait times out with the next step spelled out, and the listener is gone", async () => {
  const f = fake();
  const out = await t("debug_continue").handler(f.ctx, { waitSecs: 0 });
  assert.match(out, /Still running after 0 s.*debug_state with waitSecs.*debug_pause/);
  assert.equal(f.listeners.size, 0);
});

test("cancellation interrupts the wait, says the target may still run, removes the listener", async () => {
  const f = fake();
  const p = t("debug_continue").handler(f.ctx, { waitSecs: 60 });
  await sleep(10); assert.equal(f.listeners.size, 1);
  f.ctl.abort();
  await fails(p, /may still be running.*debug_pause/);
  assert.equal(f.listeners.size, 0);
  await fails(t("debug_step").handler(f.ctx, {}), /Cancelled/); // already aborted: refuses before touching the backend
});

test("a failing command (and an already-aborted signal inside afterSend) leaves no listener", async () => {
  const f = fake({ dbg: { continue: async () => { throw new BackendError("target", "connection lost"); } } });
  await fails(t("debug_continue").handler(f.ctx, {}), /Debug target error: connection lost/);
  assert.equal(f.listeners.size, 0);
  f.ctl.abort();
  await assert.rejects(afterSend(f.ctx, 5, () => true, async () => {}), /Cancelled/);
  assert.equal(f.listeners.size, 0);
});

test("the target exiting during a wait resolves it with the reason", async () => {
  const f = fake();
  f.dbg.onCmd = () => f.emit({ ...f.st, state: "detached", error: "target exited" });
  assert.match(await t("debug_continue").handler(f.ctx, {}), /^Detached: target exited\. Call debug_attach/);
});

test("statement stepping sends the decompiler's statement starts; without lines it steps one instruction and says so", async () => {
  const f = fake();
  f.dbg.onCmd = () => f.stopAt("0x401020");
  await t("debug_step").handler(f.ctx, {});
  assert.deepEqual(f.log[0], ["step", { mode: "statement", boundaries: ["0x401010", "0x401020", "0x401030"] }]);
  const g = fake({ tokens: [] }); g.dbg.onCmd = () => g.stopAt("0x401014");
  const out = await t("debug_step").handler(g.ctx, { mode: "into" });
  assert.deepEqual(g.log[0], ["step", { mode: "instruction" }]);
  assert.match(out, /^No decompiler statements here: stepped one instruction\.\nStopped at 0x401014/);
  const h = fake(); h.dbg.onCmd = () => h.stopAt("0x500000");
  await t("debug_step").handler(h.ctx, { mode: "out" });
  assert.deepEqual(h.log[0], ["step", { mode: "out" }]);
  const n = fake({ caps: ["debugger"] }); n.dbg.onCmd = () => n.stopAt("0x401014");
  await t("debug_step").handler(n.ctx, {});
  assert.deepEqual(n.log[0], ["step", { mode: "instruction" }]);
  assert.equal(n.dec.n, 0);
});

test("refusals are instructions: detached, running, no program", async () => {
  const f = fake(); f.emit({ ...f.st, state: "detached" });
  for (const n of ["debug_step", "debug_continue"]) await fails(t(n).handler(f.ctx, {}), /Not attached.*debug_attach/);
  f.emit({ ...f.st, state: "running" });
  await fails(t("debug_step").handler(f.ctx, {}), /running.*debug_pause/);
  await fails(t("debug_memory").handler(f.ctx, { address: "0x1" }), /running/);
  await fails(t("debug_state").handler({ ...f.ctx, ops: null }, {}), /No program is open/);
});

test("attach validates, waits for the first stop, refuses when already attached", async () => {
  const f = fake(); f.emit({ ...f.st, state: "detached" });
  f.dbg.onCmd = () => f.stopAt("0x401010", { stop: 1 });
  const out = await t("debug_attach").handler(f.ctx, { host: "10.0.0.2", port: 5555, offset: "0x8000000" });
  assert.deepEqual(f.log[0], ["attach", { host: "10.0.0.2", port: 5555, offset: "0x8000000" }]);
  assert.match(out, /^Attached; stopped at 0x401010  main\+0x10/);
  await fails(t("debug_attach").handler(f.ctx, {}), /Already attached/);
  const g = fake(); g.emit({ ...g.st, state: "detached" });
  await fails(t("debug_attach").handler(g.ctx, { host: "a b" }), /Not a host/);
  await fails(t("debug_attach").handler(g.ctx, { offset: "8" }), /offset must be hex/);
  assert.equal(g.log.length, 0);
});

test("attach refused by the target is an instruction, and leaves no listener", async () => {
  const f = fake({ dbg: { attach: async () => { throw new BackendError("target", "Connection refused by h:1"); } } }); f.emit({ ...f.st, state: "detached" });
  await fails(t("debug_attach").handler(f.ctx, {}), /Debug target error: Connection refused/);
  assert.equal(f.listeners.size, 0);
});

test("debug_state: running waits; stopped answers at once; a stop between the status read and the listener cannot be missed", async () => {
  const f = fake(); f.emit({ ...f.st, state: "running" });
  assert.equal(await t("debug_state").handler(f.ctx, {}), "Running.");
  const p = t("debug_state").handler(f.ctx, { waitSecs: 5 });
  await sleep(10); f.stopAt("0x401030");
  assert.match(await p, /^Stopped at 0x401030/);
  assert.equal(f.listeners.size, 0);
  const g = fake({ dbg: { status: async () => ({ state: "stopped", target: "h:1", stop: 4, offset: "0x0", breakpoints: [], address: "0x401020", registers: regs(4) }) } });
  assert.match(await t("debug_state").handler(g.ctx, { waitSecs: 5 }), /^Stopped at 0x401020/);
  assert.equal(g.listeners.size, 0);
});

test("pause, breakpoint toggle, detach", async () => {
  const f = fake(); f.emit({ ...f.st, state: "running" });
  f.dbg.onCmd = () => f.stopAt("0x401014");
  assert.match(await t("debug_pause").handler(f.ctx, {}), /^Stopped at 0x401014/);
  assert.match(await t("debug_pause").handler(f.ctx, {}), /^Already stopped/);
  assert.match(await t("debug_breakpoint").handler(f.ctx, { address: "main" }), /^Breakpoint set at 0x401000/);
  assert.match(await t("debug_breakpoint").handler(f.ctx, { address: "0x401000" }), /^Breakpoint cleared/);
  const n = f.log.filter((x) => x[0] === "bp").length;
  assert.match(await t("debug_breakpoint").handler(f.ctx, { address: "0x401000", set: false }), /already clear/); assert.equal(f.log.filter((x) => x[0] === "bp").length, n, "nothing sent");
  assert.match(await t("debug_breakpoint").handler(f.ctx, { address: "0x401000", set: true }), /^Breakpoint set/);
  assert.match(await t("debug_breakpoint").handler(f.ctx, { address: "0x401000", set: true }), /already set/); assert.equal(f.log.filter((x) => x[0] === "bp").length, n + 1);
  assert.match(await t("debug_breakpoint").handler(f.ctx, { address: "0x401000", set: false }), /^Breakpoint cleared/);
  assert.equal(await t("debug_detach").handler(f.ctx, {}), "Detached.");
});

test("values and memory: formatted, escaped, bounded", async () => {
  const f = fake();
  const v = await t("debug_values").handler(f.ctx, {});
  assert.match(v, /^main @0x401000, pc 0x401010\nlocal  x\\nEVIL  int  stack-8  5$/);
  const m = await t("debug_memory").handler(f.ctx, { address: "0x20000000", length: 20, dataType: "int" });
  assert.match(m, /^20 bytes at 0x20000000\n0x20000000  41 42 43 44 00 00 00 00 00 00 00 00 00 00 00 00  \|ABCD\.{12}\|\n0x20000010  00 00 00 00 +\|\.{4}\|\n\n0x20000000  int  +1$/);
  await t("debug_memory").handler(f.ctx, { address: "0x1", length: 1e9 });
  assert.equal(f.log.at(-1)[2], 4096);
  await fails(t("debug_memory").handler(f.ctx, {}), /address is required/);
});

test("afterSend never sends a command when the call was cancelled before it", async () => {
  const ac = new AbortController(); ac.abort(); let sent = 0;
  const ctx = { session: { sessionId: "s" }, backend: { events: { onDebug: () => () => {} } }, signal: ac.signal };
  await assert.rejects(afterSend(ctx, 1, () => true, async () => { sent++; }), /Cancelled/);
  assert.equal(sent, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (entry) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node" })).outputFiles[0].text));
const { resolveAddress, resolveFunction } = await bundle("../src/agent/resolve.ts");
const { modeAllows, ToolError } = await bundle("../src/agent/types.ts");
const { tagParams, agentOf } = await bundle("../src/agent/attribution.ts");
const { agentSocketPlace } = await bundle("../src/agent/socketPath.ts");
const { TOOLS } = await bundle("../src/agent/tools/index.ts");

const sym = (name, address, kind = "function") => ({ name, address, kind });
/** symbols searched by substring, like the sidecar */
const ops = (symbols, funcs = {}) => ({
  searches: { searchSymbols: ({ query }) => ({ result: Promise.resolve(symbols.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))), cancel() { this.cancelled = true; } }) },
  functions: { containing: async ({ address }) => funcs[address] ?? null },
});
const SYMS = [sym("main", "0x401000"), sym("main_loop", "0x401200"), sym("FUN_00401500", "0x401500"), sym("add", "0x402000"), sym("Init", "0x403000"), sym("init", "0x404000", "label"), sym("helper", "0x405000"), sym("helper", "0x406000", "label")];
const msg = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof ToolError || e.constructor.name === "ToolError"); return e.message; } assert.fail("expected an error"); };

test("addresses: 0x-hex, bare hex, qualified spaces", async () => {
  const o = ops(SYMS);
  assert.equal(await resolveAddress("0x401000", o), "0x401000");
  assert.equal(await resolveAddress("0X0000401000", o), "0x401000");
  assert.equal(await resolveAddress("401000", o), "0x401000");
  assert.equal(await resolveAddress("code:1000", o), "code:1000");
  assert.equal(await resolveAddress("OVL1::1000", o), "OVL1::1000");
  assert.match(await msg(resolveAddress("0xZZ", o)), /Not an address/);
  assert.match(await msg(resolveAddress("  ", o)), /address or a symbol/);
});

test("a symbol named like hex stays a name: 'add' is the function, not 0xadd", async () => {
  assert.equal(await resolveAddress("add", ops(SYMS)), "0x402000");
});

test("names: exact wins over prefix, then case-insensitive; default names resolve", async () => {
  const o = ops(SYMS);
  assert.equal(await resolveAddress("main", o), "0x401000");
  assert.equal(await resolveAddress("MAIN", o), "0x401000");
  assert.equal(await resolveAddress("FUN_00401500", o), "0x401500");
});

test("ambiguity is an error that lists the candidates, never a guess", async () => {
  const o = ops(SYMS);
  const m = await msg(resolveAddress("helper", o));
  assert.match(m, /ambiguous/); assert.match(m, /0x405000/); assert.match(m, /0x406000/);
  assert.match(await msg(resolveAddress("INIT", o)), /ambiguous/); // Init (function) and init (label) differ only by case
  assert.equal(await resolveAddress("Init", o), "0x403000"); // exact case disambiguates
});

test("a near miss suggests candidates instead of picking one", async () => {
  const m = await msg(resolveAddress("mai", ops(SYMS)));
  assert.match(m, /Did you mean/); assert.match(m, /main @0x401000/); assert.match(m, /main_loop/);
  assert.match(await msg(resolveAddress("zzz_nope", ops(SYMS))), /No symbol named/);
});

test("the same address listed twice (function + label) is one candidate", async () => {
  assert.equal(await resolveAddress("x", ops([sym("x", "0x10"), sym("x", "0x10", "label")])), "0x10");
});

test("functionsOnly prefers function symbols over a same-named label", async () => {
  const o = ops(SYMS);
  assert.equal(await resolveAddress("helper", o, undefined, true), "0x405000");
});

test("resolveFunction: a name gives its function, an address the one containing it, none is an error", async () => {
  const f = { name: "main", entry: "0x401000", size: 64, signature: "int main(void)" };
  const o = ops(SYMS, { "0x401000": f, "0x401010": f });
  assert.deepEqual(await resolveFunction("main", o), f);
  assert.deepEqual(await resolveFunction("0x401010", o), f);
  assert.match(await msg(resolveFunction("0x999999", o)), /No function contains 0x999999/);
});

test("the signal cancels the symbol search job", async () => {
  let job;
  const o = { searches: { searchSymbols: () => (job = { cancelled: false, result: new Promise((r) => setTimeout(() => r([]), 20)), cancel() { this.cancelled = true; } }) }, functions: {} };
  const ac = new AbortController();
  const p = resolveAddress("x", o, ac.signal).catch(() => {});
  ac.abort();
  await p;
  assert.equal(job.cancelled, true);
});

test("modeAllows: each mode includes the ones before it", () => {
  assert.equal(modeAllows("off", "off"), true);
  assert.equal(modeAllows("off", "read"), false);
  assert.equal(modeAllows("read", "edit"), false);
  assert.equal(modeAllows("edit", "read"), true);
  assert.equal(modeAllows("edit", "full"), false);
  assert.equal(modeAllows("full", "edit"), true);
});

test("attribution is by object identity", () => {
  const p = { address: "0x1" };
  assert.equal(agentOf(tagParams(p, "Claude Code")), "Claude Code");
  assert.equal(agentOf({ address: "0x1" }), undefined);
  assert.equal(agentOf(null), undefined);
  assert.equal(agentOf("x"), undefined);
});

const at = (o) => ({ env: {}, platform: "darwin", home: "/Users/me", tmpdir: "/var/folders/x/T", user: "me", uid: 501, ...o });
test("socket path per platform, the override and the long-path fallback", () => {
  assert.deepEqual(agentSocketPlace(at()), { path: "/Users/me/Library/Application Support/Ghidorita/agent.sock", ownDir: "/Users/me/Library/Application Support/Ghidorita" });
  assert.deepEqual(agentSocketPlace(at({ platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/1000" } })), { path: "/run/user/1000/ghidorita-agent.sock", ownDir: null });
  assert.equal(agentSocketPlace(at({ platform: "win32", user: "A b" })).path, "\\\\.\\pipe\\ghidorita-agent-A_b");
  assert.deepEqual(agentSocketPlace(at({ env: { GHIDORITA_AGENT_SOCKET: "/tmp/t.sock" } })), { path: "/tmp/t.sock", ownDir: null });
  const long = agentSocketPlace(at({ home: "/Users/" + "x".repeat(90) }));
  assert.equal(long.path, "/var/folders/x/T/ghidorita-501/agent.sock");
  assert.equal(long.ownDir, "/var/folders/x/T/ghidorita-501");
});

test("the tool table: unique snake_case names, annotations, a schema, status is offered in every mode", () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/); assert.ok(!names.has(t.name)); names.add(t.name);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(typeof t.annotations.readOnlyHint, "boolean");
    assert.ok(t.timeoutSecs > 0 && t.description.length > 10);
  }
  assert.equal(TOOLS.find((t) => t.name === "status").access, "off");
});

test("status: off says how to enable and touches nothing; with a program it reports name, analysis and edits", async () => {
  const status = TOOLS.find((t) => t.name === "status");
  assert.match(await status.handler({ mode: "off", ops: null }, {}), /Agent access is off/);
  const ctx = { mode: "edit", client: "Claude Code", session: { sessionId: "s", programId: "p1", name: "foo.elf" }, backend: { capabilities: new Set(["analysis", "decompile"]) },
    ops: { history: { state: async () => ({ canUndo: true, canRedo: false, undoName: "Rename", dirty: true }) }, analysis: { status: async () => ({ state: "running", pct: 42, analyzer: "Decompiler Switch", analysis: "partial", profile: "full" }) } } };
  const text = await status.handler(ctx, {});
  for (const part of ["edit (client Claude Code)", "foo.elf", "42% (Decompiler Switch)", "unsaved, last: Rename", "analysis, decompile"]) assert.ok(text.includes(part), part);
  assert.match(await status.handler({ ...ctx, ops: null, session: null }, {}), /none open/);
});

test("toToolError: each failure kind becomes an instruction; ToolError and aborts pass through", async () => {
  // one bundle: instanceof needs a single BackendError class
  const root = new URL("../src/", import.meta.url).pathname;
  const out = await build({ stdin: { contents: `export * from "./agent/errors"; export { BackendError } from "./renderer/backend";`, resolveDir: root, loader: "ts" }, bundle: true, format: "esm", write: false, platform: "node" });
  const { toToolError, isKind, BackendError } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
  const m = (kind) => toToolError(new BackendError(kind, "boom")).message;
  assert.match(m("busy"), /wait_for_analysis/);
  assert.match(m("stale"), /Call status/); assert.match(m("noProgram"), /Call status/);
  assert.match(m("timeout"), /timeoutSecs/);
  assert.match(m("cancelled"), /retry/);
  assert.match(m("notFound"), /boom/);
  assert.equal(toToolError(new BackendError("busy", "b")).constructor.name, "ToolError");
  const own = toToolError(new BackendError("notFound", "z")); assert.equal(toToolError(own), own); // a ToolError passes through
  assert.equal(toToolError(Object.assign(new Error("a"), { name: "AbortError" })).message, "Cancelled.");
  assert.equal(toToolError("str").message, "str");
  assert.ok(isKind(new BackendError("cancelled", ""), "cancelled")); assert.ok(!isKind(new Error(), "cancelled"));
});

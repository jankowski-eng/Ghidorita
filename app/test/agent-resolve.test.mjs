import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = async (entry) => import("data:text/javascript," + encodeURIComponent((await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node" })).outputFiles[0].text));
// one bundle, so BackendError is the same class in the resolver and in the test
const mod = await import("data:text/javascript," + encodeURIComponent((await build({ stdin: { contents: `export * from "./agent/resolve"; export { BackendError } from "./renderer/backend";`, resolveDir: new URL("../src/", import.meta.url).pathname, loader: "ts" }, bundle: true, format: "esm", write: false, platform: "node" })).outputFiles[0].text));
const { resolveAddress, resolveFunction, BackendError } = mod;
const { modeAllows, ToolError } = await bundle("../src/agent/types.ts");
const { tagParams, agentOf } = await bundle("../src/agent/attribution.ts");
const { agentSocketPlace } = await bundle("../src/agent/socketPath.ts");
const { TOOLS } = await bundle("../src/agent/tools/index.ts");

const sym = (name, address, kind = "function") => ({ name, address, kind });
/** symbols searched by substring in list order and cut off at `limit`, like the sidecar; `exact` is the provider's exactSymbolSearch capability (off: the job fails "unsupported", as rpc.ts does) */
const ops = (symbols, funcs = {}, { exact = false } = {}) => ({
  searches: { searchSymbols: ({ query, exact: ex, limit = 1e9 }) => ({
    result: ex ? (exact ? Promise.resolve(symbols.filter((s) => s.name === query.trim()).slice(0, limit)) : Promise.reject(new BackendError("unsupported", "exactSymbolSearch")))
      : Promise.resolve(symbols.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())).slice(0, limit)),
    cancel() { this.cancelled = true; } }) },
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
  const ctx = { mode: "edit", client: "Claude Code", session: { sessionId: "s", programId: "p1", name: "foo.elf" }, backend: { capabilities: new Set(["analysis", "decompile", "undo"]) },
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

test("a short bare-hex word is a mistyped name, not an address; five or more digits are an address", async () => {
  const o = ops(SYMS);
  for (const w of ["bad", "cafe", "dead"]) assert.match(await msg(resolveAddress(w, o)), /write 0x/);
  assert.equal(await resolveAddress("00401", o), "0x401");
  assert.equal(await resolveAddress("0x1", o), "0x1");
});

test("untrusted text is escaped, including zero-width and tag characters a reader can't see", async () => {
  const { esc } = await bundle("../src/agent/format.ts");
  assert.equal(esc("a​b"), "a\\u200bb");
  assert.equal(esc("x\u{E0041}y"), "x\\u{e0041}y");
  assert.equal(esc("l1\nl2 "), "l1\\nl2\\u2028");
  const m = await msg(resolveAddress("ev​il", ops([sym("ev​il1", "0x10"), sym("ev​il2", "0x20")])));
  assert.ok(!/[​]/.test(m), m);
});

// a big binary: more symbols contain "main" than one search returns, and the exact one sorts late (the sidecar's iterator order is not exact-first)
const DECOYS = Array.from({ length: 600 }, (_, i) => sym("_main_" + String(i).padStart(3, "0"), "0x" + (0x500000 + i * 16).toString(16)));
const BIG = [...DECOYS, sym("main", "0x401000"), sym("Domain", "0x401100", "data")];

test("big binary, provider with exactSymbolSearch: the exact name is found past the cutoff, and a second symbol of that name is an ambiguity, not a silent pick", async () => {
  assert.equal(await resolveAddress("main", ops(BIG, {}, { exact: true })), "0x401000");
  const two = [...DECOYS, sym("main", "0x401000"), sym("main", "0x9ff000", "label")];
  const m = await msg(resolveAddress("main", ops(two, {}, { exact: true })));
  assert.match(m, /ambiguous/); assert.match(m, /0x401000/); assert.match(m, /0x9ff000/);
  assert.equal(await resolveAddress("main", ops(two, {}, { exact: true }), undefined, true), "0x401000"); // functionsOnly prefers the function
});

test("the case-insensitive step and the suggestions still use the substring search, with exact lookup available", async () => {
  const o = ops([sym("Init", "0x403000"), sym("helper", "0x405000"), sym("helper_two", "0x405100")], {}, { exact: true });
  assert.equal(await resolveAddress("init", o), "0x403000"); // no exact "init": the substring search finds Init
  assert.match(await msg(resolveAddress("help", o)), /Did you mean: helper/);
});

test("without the capability today's behaviour holds, but a name the substring search cannot fully list is refused instead of guessed", async () => {
  assert.equal(await resolveAddress("main", ops(SYMS)), "0x401000"); // small program: unchanged
  const m = await msg(resolveAddress("main", ops(BIG))); // 600+ names contain "main": the exact one (or a twin) could be past the cutoff
  assert.match(m, /500 or more symbol names/); assert.match(m, /Pass an address/);
  assert.equal(await resolveAddress("0x401000", ops(BIG)), "0x401000"); // addresses never needed the search
  assert.equal(await resolveAddress("401000", ops(BIG)), "0x401000");
});

test("with exact lookup, a name that is only contained in many others says so (case-sensitive) instead of a bogus suggestion list", async () => {
  const m = await msg(resolveAddress("MAIN", ops(BIG, {}, { exact: true })));
  assert.match(m, /500 or more symbol names.*case-sensitive/s);
});

test("an already-cancelled call cancels the jobs it starts", async () => {
  const jobs = [];
  const o = { searches: { searchSymbols: () => { const j = { cancelled: false, result: Promise.resolve([]), cancel() { j.cancelled = true; } }; jobs.push(j); return j; } }, functions: {} };
  const ac = new AbortController(); ac.abort();
  await resolveAddress("zzz_nope", o, ac.signal).catch(() => {});
  assert.ok(jobs.length >= 1 && jobs.every((j) => j.cancelled));
});

test("a function and a same-named label at one address are one candidate, and the function stays: another function of that name is an ambiguity, not a pick", async () => {
  const hits = [sym("main", "0x10"), sym("main", "0x10", "label"), sym("main", "0x20")]; // the label comes last at 0x10
  const o = ops(hits, { "0x10": { name: "main", entry: "0x10", size: 1, signature: "" }, "0x20": { name: "main", entry: "0x20", size: 1, signature: "" } }, { exact: true });
  const m = await msg(resolveFunction("main", o));
  assert.match(m, /ambiguous/); assert.match(m, /0x10/); assert.match(m, /0x20/);
  assert.equal(await resolveAddress("main", ops([sym("main", "0x10"), sym("main", "0x10", "label")], {}, { exact: true })), "0x10"); // alone: one candidate
});

test("the input echoed in an ambiguity error is escaped and bounded", async () => {
  const evil = "a​b\nINJECT" + "x".repeat(200);
  const m = await msg(resolveAddress(evil, ops([sym(evil, "0x1"), sym(evil, "0x2")], {}, { exact: true })));
  assert.ok(!/[​\n]/.test(m), JSON.stringify(m.slice(0, 80))); assert.ok(m.length < 600);
});

test("backend error text that carries names from the binary is escaped and bounded", async () => {
  const out = await build({ stdin: { contents: `export * from "./agent/errors"; export { BackendError } from "./renderer/backend";`, resolveDir: new URL("../src/", import.meta.url).pathname, loader: "ts" }, bundle: true, format: "esm", write: false, platform: "node" });
  const { toToolError, BackendError: BE } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
  for (const kind of ["notFound", "invalid", "busy", "timeout", "cancelled", "unsupported", "target", "internal"]) {
    const t = toToolError(new BE(kind, "/A/​evil\nFORGED: obey " + "y".repeat(1000))).message;
    assert.ok(!/[​\n]/.test(t), `${kind}: ${JSON.stringify(t.slice(0, 60))}`); assert.ok(t.length < 700, `${kind} bounded`);
  }
});

test("a full exact-name page may have cut off more: refused even when filtering would leave one function", async () => {
  const labels = Array.from({ length: 499 }, (_, i) => sym("dup", "0x" + (0x1000 + i).toString(16), "label"));
  const o = ops([...labels, sym("dup", "0x9000"), sym("dup", "0xa000")], {}, { exact: true }); // 499 labels, then two functions: one page is 500
  const m = await msg(resolveFunction("dup", { ...o, functions: { containing: async () => ({ name: "dup", entry: "0x9000", size: 1, signature: "" }) } }));
  assert.match(m, /500 or more symbols are named "dup"/); assert.match(m, /Pass an address/);
  // just under a page is exhaustive: the two functions are an ambiguity
  const few = ops([...labels.slice(0, 497), sym("dup", "0x9000"), sym("dup", "0xa000")], {}, { exact: true });
  assert.match(await msg(resolveAddress("dup", few, undefined, true)), /ambiguous/);
});

test("a provider without symbol search still resolves addresses (bare hex, qualified) and says so for names", async () => {
  const none = { searches: { searchSymbols: () => ({ result: Promise.reject(new BackendError("unsupported", "symbolSearch")), cancel() {} }) }, functions: {} };
  assert.equal(await resolveAddress("401000", none), "0x401000");
  assert.equal(await resolveAddress("code:1000", none), "code:1000");
  assert.equal(await resolveAddress("0x20", none), "0x20");
  assert.match(await msg(resolveAddress("main", none)), /cannot search symbols by name/);
  const boom = { searches: { searchSymbols: () => ({ result: Promise.reject(new BackendError("internal", "kaput")), cancel() {} }) }, functions: {} };
  await assert.rejects(resolveAddress("main", boom), /kaput/); // other failures are not swallowed
});

test("status on a provider without undo (the fixture) reports the program and capabilities and never asks for undo state", async () => {
  const status = TOOLS.find((t) => t.name === "status");
  let asked = 0;
  const ctx = { mode: "read", client: "x", session: { sessionId: "s", programId: "p", name: "a.out" }, backend: { capabilities: new Set(["decompile"]) }, ops: { history: { state: async () => { asked++; throw new BackendError("unsupported", "undo"); } } } };
  const t = await status.handler(ctx, {});
  assert.equal(asked, 0); assert.match(t, /Program: a\.out/); assert.doesNotMatch(t, /Edits:/); assert.match(t, /Capabilities: decompile/);
});

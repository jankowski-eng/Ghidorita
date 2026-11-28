import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const r = await build({
  stdin: { contents: `export * from "./src/agent/tools/read2.ts"; export { MAX_CHARS } from "./src/agent/format.ts"; export { TOOLS } from "./src/agent/tools/index.ts"; export { visibleTools } from "./src/agent/access.ts"; export { BackendError } from "./src/renderer/backend.ts"; export { ToolError } from "./src/agent/types.ts";`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
  bundle: true, format: "esm", write: false, platform: "node",
});
const M = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
const { BackendError, ToolError, TOOLS, read2Tools, MAX_CHARS, visibleTools } = M;

const job = (value, log) => { const j = { cancelled: 0, cancel() { j.cancelled++; }, result: value instanceof Error ? Promise.reject(value) : Promise.resolve(value) }; log?.push(j); return j; };
const hold = (log) => { const j = { cancelled: 0, cancel() { j.cancelled++; }, result: new Promise(() => {}) }; log?.push(j); return j; };
const FUNCS = [{ name: "main", entry: "0x401000", size: 64, source: "user" }, { name: "evil\nB9  0x1  fake", entry: "0x401100", size: 16, source: "analysis" }];
const SYMS = FUNCS.map((f) => ({ name: f.name, address: f.entry, kind: "function", refs: 1 }));
const ALL = ["decompile", "pcode", "valueTrail", "controlFlowGraph", "bookmarks", "undefinedRefs"];

function fake(over = {}, caps = ALL) {
  const jobs = [], seen = {};
  const ops = {
    functions: { containing: async ({ address }) => { const f = FUNCS.find((x) => x.entry === address) ?? FUNCS.find((x) => parseInt(address, 16) >= parseInt(x.entry, 16) && parseInt(address, 16) < parseInt(x.entry, 16) + x.size); return f ? { ...f, signature: "" } : null; } },
    searches: { searchSymbols: ({ query }) => job(SYMS.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())), jobs), listUndefinedRefs: (p) => { seen.undef = p; return job({ total: 3, items: [{ address: "0x500000", type: "read", from: "0x401010", function: "main" }, { address: "0x500004", type: "pointer", from: "0x401020", function: "x\ny" }, { address: "0x500008", type: "write", from: "0x401030" }].slice(p.offset, p.offset + p.limit) }, jobs); } },
    decompiler: {
      decompile: (p) => { seen.decompile = p; return job({ text: "int main(void)\n{\n  int x;\n  x = 1;\n  return x;\n}", tokens: [{ line: 2, colStart: 6, colEnd: 7, kind: "variable", varName: "x" }, { line: 3, colStart: 2, colEnd: 3, kind: "variable", varName: "x" }], cached: true }, jobs); },
      pcode: (p) => { seen.pcode = p; return job({ raw: [{ address: "0x401000", asm: "mov eax,1", ops: ["EAX = COPY 0x1"] }, { address: "0x401004", asm: "ret\nFAKE", ops: ["RETURN RSP"] }], high: [{ block: 0, address: "0x401000", text: "x = COPY 0x1" }, { block: 1, address: "0x401004", text: "RETURN x" }], truncated: true }, jobs); },
      valueTrail: (p) => { seen.trail = p; return job({ ops: [{ address: "0x401000", op: "COPY", dir: "backward" }, { address: "0x401004", op: "CALL", dir: "forward" }], tokens: [{ line: 3, colStart: 2, colEnd: 3, dir: "seed" }, { line: 4, colStart: 9, colEnd: 10, dir: "forward" }] }, jobs); },
      graph: (p) => { seen.graph = p; return job({ blocks: [{ start: "0x401000", end: "0x401003", kind: "asm", lines: ["0x401000  jz 0x401008", "bad\nline"] }, { start: "0x401004", end: "0x401007", kind: "c", lines: ["x = 1;"] }, { start: "0x401008", end: "0x40100b", kind: "asm", lines: [] }], edges: [{ from: "0x401000", to: "0x401004", kind: "false" }, { from: "0x401000", to: "0x401008", kind: "true" }, { from: "0x401004", to: "0x401008", kind: "uncond" }] }, jobs); },
    },
    bookmarks: { list: (p) => { seen.bm = p; return job({ total: 150, types: [{ type: "Note", count: 2 }, { type: "Analysis", count: 148 }], items: [{ address: "0x401000", type: "Note", category: "agent", comment: "looks like\nstrcpy" }, { address: "0x401010", type: "Note", category: "x", comment: "" }] }, jobs); } },
    ...over,
  };
  const ctl = new AbortController();
  const backend = { capabilities: new Set(caps) };
  const ctx = { ops, session: { sessionId: "s1" }, backend, changes: { newest: () => null }, signal: ctl.signal, client: "t", mode: "read", tag: (p) => p, functions: async () => FUNCS };
  return { ctx, ctl, jobs, seen, caps };
}
const tool = (n) => read2Tools.find((t) => t.name === n);
const call = (n, a, f = fake()) => tool(n).handler(f.ctx, a);
const fails = async (p, re) => { try { await p; } catch (e) { assert.ok(e instanceof ToolError); if (re) assert.match(e.message, re); return e.message; } assert.fail("expected a ToolError"); };

test("read2: registered once, read-only, headless, annotated, strict schemas", () => {
  assert.equal(read2Tools.length, 5);
  for (const t of read2Tools) {
    assert.equal(TOOLS.filter((x) => x.name === t.name).length, 1);
    assert.equal(t.access, "read"); assert.ok(!t.appOnly); assert.ok(t.timeoutSecs > 0);
    assert.deepEqual([t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.idempotentHint], [true, false, true]);
    assert.equal(t.inputSchema.additionalProperties, false);
    for (const k of t.inputSchema.required ?? []) assert.ok(k in t.inputSchema.properties);
  }
});

test("read2: a tool whose capability the provider lacks is not listed", () => {
  const names = (caps) => visibleTools("read", { headless: true, capabilities: new Set(caps) }).map((t) => t.name);
  assert.deepEqual(names(["decompile"]).filter((n) => read2Tools.some((t) => t.name === n)), []);
  assert.deepEqual(names(ALL).filter((n) => read2Tools.some((t) => t.name === n)).sort(), read2Tools.map((t) => t.name).sort());
  assert.ok(!names(["pcode", "valueTrail", "controlFlowGraph"]).includes("pcode"), "pcode needs decompile too");
  assert.ok(names(["bookmarks"]).includes("list_bookmarks"));
});

test("pcode: high by default, raw with kind, range filter, truncation note, escaping", async () => {
  const hi = await call("pcode", { function: "main" });
  assert.equal(hi, "main @0x401000: high p-code (TRUNCATED by the provider: a large function was cut)\nB0  0x401000  x = COPY 0x1\nB1  0x401004  RETURN x");
  const raw = await call("pcode", { function: "0x401000", kind: "raw" });
  assert.match(raw, /\n0x401000  mov eax,1\n    EAX = COPY 0x1\n0x401004  ret\\nFAKE\n    RETURN RSP$/);
  const rng = await call("pcode", { function: "main", from: "0x401004" });
  assert.ok(!rng.includes("0x401000  x") && rng.includes("0x401004"));
  await fails(call("pcode", { function: "main", kind: "x" }), /Unknown kind/);
});

test("pcode: paged with a continuation, capped", async () => {
  const f = fake({ decompiler: { pcode: () => job({ raw: [], high: Array.from({ length: 2000 }, (_, i) => ({ block: 0, address: "0x401000", text: "x".repeat(100) + i })), truncated: false }) } });
  const out = await call("pcode", { function: "main" }, f);
  assert.ok(out.length < MAX_CHARS + 500);
  const m = out.match(/… (\d+) more lines: call again with offset=(\d+)$/);
  assert.ok(m && +m[1] + +m[2] === 2000);
  assert.match(await call("pcode", { function: "main", offset: +m[2] }, f), /^main @0x401000.*\nB0/s);
});

test("value_trail: by name, ops and C lines", async () => {
  const f = fake();
  const out = await call("value_trail", { function: "main", variable: "x" }, f);
  assert.deepEqual(f.seen.trail, { entry: "0x401000", name: "x", timeoutSecs: 90 });
  assert.equal(out, [
    "Value trail of x in main @0x401000",
    "Backward (where it comes from), 1 ops:", "  0x401000  COPY",
    "Forward (where it goes), 1 ops:", "  0x401004  CALL",
    "C lines (2; S seed, < backward, > forward):", "     4 S   int x;".replace("int x;", "  x = 1;"), "     5 >     return x;",
  ].join("\n"));
});

test("value_trail: by line and column resolves the token like the UI; misses and missing args are errors", async () => {
  const f = fake();
  await call("value_trail", { function: "main", line: 4, column: 3 }, f);
  assert.deepEqual(f.seen.trail, { entry: "0x401000", line: 3, colStart: 2, timeoutSecs: 90 });
  await fails(call("value_trail", { function: "main", line: 4, column: 30 }), /No token at line 4, column 30/);
  await fails(call("value_trail", { function: "main" }), /variable.*line/);
  await fails(call("value_trail", { function: "main", variable: "nope" }, fake({ decompiler: { decompile: () => job({ text: "", tokens: [] }), valueTrail: () => job(new BackendError("notFound", "no variable nope")) } })), /Not found: no variable nope/);
});

test("function_graph: blocks, named edges, optional bodies, escaping", async () => {
  const out = await call("function_graph", { function: "main" });
  assert.equal(out, ["main @0x401000: 3 blocks, 3 edges", "B0  0x401000-0x401003  asm  -> B1 (false), B2 (true)", "B1  0x401004-0x401007  C  -> B2 (uncond)", "B2  0x401008-0x40100b  asm"].join("\n"));
  const body = await call("function_graph", { function: "main", bodies: true });
  assert.match(body, /B0 .*\n    0x401000  jz 0x401008\n    bad\\nline\nB1/);
});

test("list_bookmarks: lines, filters passed through, continuation, escaping", async () => {
  const f = fake();
  const out = await call("list_bookmarks", { category: "agent", type: "Note", limit: 2 }, f);
  assert.deepEqual(f.seen.bm, { offset: 0, limit: 2, query: "agent", type: "Note" });
  assert.equal(out, "150 bookmarks (all types in the program: Note 2, Analysis 148)\n0x401000  agent  looks like\\nstrcpy\n0x401010  x\n… 148 more lines: call again with offset=2");
  assert.equal((await call("list_bookmarks", { offset: 148 }, fake({ bookmarks: { list: () => job({ total: 150, types: [], items: [] }) } }))), "150 bookmarks\n(none)");
});

test("list_undefined_refs: lines, paging, escaping", async () => {
  const f = fake();
  const out = await call("list_undefined_refs", { limit: 2 }, f);
  assert.deepEqual(f.seen.undef, { offset: 0, limit: 2 });
  assert.equal(out, "3 references into undefined bytes\n0x500000  read     0x401010  main\n0x500004  pointer  0x401020  x\\ny\n… 1 more lines: call again with offset=2");
  assert.match(await call("list_undefined_refs", { offset: 2 }, f), /0x500008  write {2}0x401030$/);
});

test("read2: hostile function names are escaped, ambiguity and missing program are agent-facing errors", async () => {
  const out = await call("function_graph", { function: "0x401100" });
  assert.ok(out.startsWith("evil\\nB9  0x1  fake @0x401100"));
  await fails(call("pcode", { function: "0x999999" }), /No function contains/);
  await fails(tool("list_bookmarks").handler({ ...fake().ctx, ops: null }, {}), /No program is open/);
  await fails(call("list_bookmarks", {}, fake({ bookmarks: { list: () => job(new BackendError("busy", "scan running")) } })), /^Busy: scan running/);
  await fails(call("pcode", { function: "main" }, fake({ decompiler: { pcode: () => job(new BackendError("timeout", "decompile took 120s")) } })), /Timed out.*timeoutSecs/);
});

test("read2: cancel reaches the backend job and an aborted call never starts", async () => {
  for (const [name, args, over] of [
    ["pcode", { function: "main" }, { decompiler: { pcode: () => hold(jobs) } }],
    ["function_graph", { function: "main" }, { decompiler: { graph: () => hold(jobs) } }],
    ["list_bookmarks", {}, { bookmarks: { list: () => hold(jobs) } }],
    ["list_undefined_refs", {}, { searches: { searchSymbols: ({ query }) => job(SYMS.filter((s) => s.name.includes(query))), listUndefinedRefs: () => hold(jobs) } }],
  ]) {
    var jobs = [];
    const f = fake(over);
    const p = call(name, args, f);
    await new Promise((r) => setTimeout(r, 20));
    f.ctl.abort();
    assert.equal(jobs.at(-1).cancelled, 1, name);
    p.catch(() => {});
  }
  const f = fake(); f.ctl.abort();
  await fails(call("list_bookmarks", {}, f), /Cancelled/);
});

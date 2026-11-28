import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// one bundle, so BackendError / ToolError are the same classes in the tools and in the tests
const r = await build({
  stdin: { contents: `export * from "./src/agent/tools/read.ts"; export * from "./src/agent/format.ts"; export { TOOLS } from "./src/agent/tools/index.ts"; export { BackendError } from "./src/renderer/backend.ts"; export { ToolError } from "./src/agent/types.ts";`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
  bundle: true, format: "esm", write: false, platform: "node",
});
const M = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
const { BackendError, ToolError, TOOLS, readTools, capText, capPage, esc, hexdump, MAX_CHARS } = M;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const job = (value, log) => { const j = { cancelled: 0, cancel() { j.cancelled++; }, result: value instanceof Error ? Promise.reject(value) : Promise.resolve(value) }; log?.push(j); return j; };
const hold = (log) => { let resolve; const j = { cancelled: 0, cancel() { j.cancelled++; }, result: new Promise((r) => (resolve = r)), resolve }; log?.push(j); return j; };

const FUNCS = [
  { name: "main", entry: "0x401000", size: 64, source: "user" },
  { name: "helper", entry: "0x401100", size: 16, source: "analysis" },
  { name: "FUN_00401200", entry: "0x401200", size: 8, source: "default" },
  { name: "dup", entry: "0x402000", size: 4, source: "analysis" },
  { name: "dup", entry: "0x403000", size: 4, source: "analysis" },
];
const SYMS = FUNCS.map((f) => ({ name: f.name, address: f.entry, kind: "function", refs: 2 }));

/** an in-memory backend: every operation is a plain function the test can replace; `calls` records the backend calls */
function fake(over = {}) {
  const calls = [], jobs = [];
  const rec = (name, fn) => (...a) => { calls.push(name); return fn(...a); };
  const analysisListeners = new Set();
  const state = { state: "running", analysis: "partial", profile: "full", analyzer: "Decompiler", done: 3, pct: 40 };
  const ops = {
    listing: {
      rows: rec("rows", async ({ address, count }) => Array.from({ length: Math.min(count, 100) }, (_, i) => ({ address: "0x" + (parseInt(address, 16) + i * 4).toString(16), length: 4, bytes: "90 90 90 90", mnemonic: "nop", operands: "" }))),
      bytes: rec("bytes", async ({ address, length }) => ({ address, length, bytes: Array.from({ length }, (_, i) => (0x41 + (i % 26)).toString(16)).join(" ") })),
      info: async () => ({ ranges: [], totalBytes: 0 }),
    },
    functions: {
      list: rec("list", async () => FUNCS),
      containing: rec("containing", async ({ address }) => { const f = FUNCS.find((x) => x.entry === address) ?? FUNCS.find((x) => parseInt(address, 16) >= parseInt(x.entry, 16) && parseInt(address, 16) < parseInt(x.entry, 16) + x.size); return f ? { ...f, signature: `int ${f.name}(void)` } : null; }),
      stackFrame: rec("stackFrame", async ({ entry }) => ({ entry, name: "main", localSize: 16, parameterSize: 8, slots: [{ offset: 8, size: 4, name: "argc", dataType: "int", parameter: true, source: "analysis" }, { offset: -16, size: 8, name: "buf", dataType: "char[8]", parameter: false, source: "user" }] })),
    },
    decompiler: { decompile: rec("decompile", ({ entry }) => job({ text: "int main(void)\n{\n  return 0;\n}", tokens: [{ line: 2, colStart: 2, colEnd: 8, kind: "keyword", address: "0x401010" }], cached: false, warnings: ["WARNING: bad\nINJECTED"] }, jobs)) },
    references: {
      xrefsTo: rec("xrefsTo", async () => [{ from: "0x401020", type: "UNCONDITIONAL_CALL", kind: "call", function: "main" }]),
      xrefsFrom: rec("xrefsFrom", async () => [{ to: "0x401100", type: "UNCONDITIONAL_CALL", kind: "call", target: "memory" }, { to: null, type: "READ", kind: "read", target: "stack", label: "Stack[-0x10]" }]),
      xrefsToVariable: rec("xrefsToVariable", async () => []),
      variableUses: rec("variableUses", () => job([{ from: "0x401014", type: "INT_ADD", kind: "write", function: "main" }], jobs)),
      callGraph: rec("callGraph", () => job({ nodes: [{ entry: "0x401000", name: "main", kind: "function" }, { entry: "0x401100", name: "printf", kind: "import" }], edges: [{ from: "0x401000", to: "0x401100", sites: 2 }], truncated: true }, jobs)),
      calls: rec("calls", () => job({ callers: [{ name: "start", entry: "0x400000", external: false, thunk: false }], callees: [{ name: "_printf", entry: "0x401500", external: false, thunk: true, target: { name: "printf", entry: null, external: true } }, { name: "ext", entry: null, external: true, thunk: false }] }, jobs)),
    },
    searches: {
      searchSymbols: rec("searchSymbols", ({ query }) => job(SYMS.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())), jobs)),
      listStrings: rec("listStrings", ({ offset = 0, limit = 100 }) => job({ total: 3, items: [{ address: "0x500000", value: "hello\nworld", length: 12, refs: 1, refFrom: [{ from: "0x401010", function: "main" }] }, { address: "0x500010", value: "\x1b[31mred", length: 8, refs: 0 }, { address: "0x500020", value: "x", length: 2, refs: 0 }].slice(offset, offset + limit) }, jobs)),
      searchMemory: rec("searchMemory", () => job({ items: [{ address: "0x401000", length: 2, bytes: "48 8b", function: "main" }], next: "0x402000" }, jobs)),
      listSymbols: () => job({ total: 0, items: [] }), topSymbols: () => job([]), listUndefinedRefs: () => job({ total: 0, items: [] }),
    },
    types: {
      listDataTypes: rec("listDataTypes", () => job([{ name: "S", path: "/S", size: 8, kind: "struct", source: "program" }], jobs)),
      getDataType: rec("getDataType", async ({ path }) => {
        if (path === "/E") return { name: "E", path, size: 4, kind: "enum", source: "program", writable: true, description: "", archive: null, values: [{ name: "A", value: "1" }, { name: "B", value: "2" }] };
        if (path !== "/S") throw new BackendError("notFound", `no data type ${path}`);
        const u = (o) => ({ ordinal: o, offset: o, length: 1, type: "undefined", typePath: "/undefined", name: null, defaultName: `field${o}`, comment: null, undefined: true, bitfield: false });
        return { name: "S", path, size: 8, kind: "struct", source: "program", writable: true, description: "", archive: null, alignment: 4, components: [{ ordinal: 0, offset: 0, length: 4, type: "int", typePath: "/int", name: "id", defaultName: "field0", comment: "the id", undefined: false, bitfield: false }, u(4), u(5), u(6), u(7)] };
      }),
    },
    analysis: { status: rec("analysisStatus", async () => ({ ...state })) },
    history: { state: async () => ({ canUndo: false, canRedo: false, dirty: false }) },
    ...over,
  };
  const session = { sessionId: "s1", programId: "p1", name: "prog" };
  const backend = { capabilities: new Set(over.caps ?? ["decompile", "references", "variableReferences", "calls", "callGraph", "symbolSearch", "strings", "memorySearch", "bytes", "stackFrame", "dataTypes", "analysis"]), events: { onAnalysis: (l) => { analysisListeners.add(l); return () => analysisListeners.delete(l); } } };
  const ctl = new AbortController();
  const ctx = { ops, session, backend, changes: { newest: () => null }, signal: ctl.signal, client: "test", mode: "read", tag: (p) => p };
  return { ctx, ops, calls, jobs, ctl, state, listeners: analysisListeners, emit: (s) => analysisListeners.forEach((l) => l("s1", s)), backend };
}
const tool = (name) => readTools.find((t) => t.name === name);
const call = (name, args, f = fake()) => tool(name).handler(f.ctx, args);
const fails = async (p, re) => { try { await p; } catch (e) { assert.ok(e instanceof ToolError, `ToolError expected, got ${e}`); if (re) assert.match(e.message, re); return e.message; } assert.fail("expected a ToolError"); };

test("schema sanity: unique names, read access, annotations, strict schemas, timeouts", () => {
  const names = new Set();
  for (const t of readTools) {
    assert.ok(!names.has(t.name)); names.add(t.name);
    assert.match(t.name, /^[a-z][a-z_]*$/);
    assert.equal(t.access, "read");
    assert.deepEqual([t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.idempotentHint], [true, false, true]);
    assert.equal(t.inputSchema.type, "object"); assert.equal(t.inputSchema.additionalProperties, false);
    for (const q of t.inputSchema.required ?? []) assert.ok(q in t.inputSchema.properties);
    assert.ok(t.description.length > 20 && t.timeoutSecs > 0);
  }
  assert.deepEqual([...names].sort(), ["call_graph", "calls", "data_type", "decompile", "disassemble", "list_functions", "read_bytes", "search", "search_types", "stack_frame", "strings", "wait_for_analysis", "xrefs"].sort());
  assert.equal(tool("decompile").timeoutSecs >= 120, true);
  assert.deepEqual(TOOLS.map((t) => t.name).filter((n) => names.has(n)).sort(), [...names].sort()); // registered in the table
});

test("format: capText cuts at the cap and the offset continues exactly", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
  const seen = []; let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const out = capText(lines, offset).split("\n");
    assert.ok(out.join("\n").length <= MAX_CHARS + 100);
    const m = /^… (\d+) more lines: call again with offset=(\d+)$/.exec(out[out.length - 1]);
    seen.push(...(m ? out.slice(0, -1) : out));
    if (!m) break;
    assert.equal(Number(m[2]), seen.length); assert.equal(Number(m[1]), lines.length - seen.length);
    offset = Number(m[2]);
  }
  assert.deepEqual(seen, lines);
  assert.match(capText(lines, 0, 3), /… 4997 more lines: call again with offset=3$/);
  assert.equal(capText(lines.slice(0, 2)), "line 0 " + "x".repeat(40) + "\nline 1 " + "x".repeat(40));
  assert.equal(capText([]), "(none)"); assert.match(capText(["a"], 5), /past the end/);
  assert.match(capPage(["a", "b"], 10, 5), /7 more lines.*offset=10$|… 5 more lines: call again with offset=12$/);
});

test("list_functions: format, filter, sort, paging, continuation", async () => {
  const out = await call("list_functions", {});
  const lines = out.split("\n");
  assert.equal(lines[0], "5 functions");
  assert.equal(lines[1], "0x401000  64  user      main");
  assert.match(await call("list_functions", { query: "DUP" }), /^2 of 5 functions matching "DUP"\n0x402000/);
  assert.match((await call("list_functions", { sort: "size", limit: 1 })).split("\n")[1], /main$/);
  assert.match(await call("list_functions", { limit: 2 }), /… 3 more lines: call again with offset=2$/);
  assert.match(await call("list_functions", { limit: 2, offset: 2 }), /^5 functions\n0x401200.*\n0x402000.*\n… 1 more lines: call again with offset=4$/);
  assert.match(await call("list_functions", { limit: "x", offset: -5 }), /^5 functions/); // nonsense numbers are clamped
});

test("a huge listing is cut at the cap and the continuation resumes exactly", async () => {
  const big = Array.from({ length: 3000 }, (_, i) => ({ name: `fn_${i}_${"n".repeat(50)}`, entry: "0x" + (0x1000 + i * 16).toString(16), size: 16, source: "analysis" }));
  const f = fake({ functions: { list: async () => big, containing: async () => null } });
  const got = []; let offset = 0;
  for (let i = 0; i < 50; i++) {
    const out = await call("list_functions", { offset, limit: 2000 }, f);
    assert.ok(out.length <= MAX_CHARS + 200);
    const ls = out.split("\n").slice(1), m = /offset=(\d+)$/.exec(ls[ls.length - 1]);
    got.push(...(m ? ls.slice(0, -1) : ls));
    if (!m) break;
    assert.equal(Number(m[1]), offset + (ls.length - 1)); offset = Number(m[1]);
  }
  assert.equal(got.length, 3000);
  assert.equal(new Set(got.map((l) => l.split(/\s+/)[0])).size, 3000);
});

test("decompile: resolves a name, text then warnings, addresses, backend called with the entry", async () => {
  const f = fake();
  const out = await call("decompile", { function: "main", addresses: true }, f);
  assert.match(out, /^\/\/ main @0x401000\nint main\(void\)\n\{\n  return 0;  \/\/ @0x401010\n\}/);
  assert.match(out, /Decompiler warnings:\n  WARNING: bad\\nINJECTED$/); // the newline in a warning cannot start a line of its own
  assert.doesNotMatch(await call("decompile", { function: "0x401000" }), /@0x401010/);
  assert.ok(f.calls.includes("decompile"));
});

test("name resolution: hex address, name, ambiguous name lists candidates, missing arg", async () => {
  assert.match(await call("decompile", { function: "0x401004" }), /^\/\/ main @0x401000/); // an address inside the function
  assert.match(await call("decompile", { function: "401100" }), /^\/\/ helper/);
  const m = await fails(call("decompile", { function: "dup" }), /ambiguous/);
  assert.match(m, /0x402000/); assert.match(m, /0x403000/);
  await fails(call("decompile", {}), /function is required/);
  await fails(call("decompile", { function: "0x500000" }), /No function contains/);
  await fails(call("calls", { function: "zzz" }), /No symbol named/);
});

test("Failure kinds become instructions", async () => {
  const mk = (kind) => fake({ decompiler: { decompile: () => job(new BackendError(kind, "boom")) } });
  const msg = (kind) => fails(call("decompile", { function: "main" }, mk(kind)));
  assert.match(await msg("busy"), /wait_for_analysis/);
  assert.match(await msg("stale"), /status/);
  assert.match(await msg("noProgram"), /status/);
  assert.match(await msg("timeout"), /timeoutSecs/);
  assert.match(await msg("cancelled"), /Cancelled/);
  assert.match(await msg("notFound"), /Not found: boom/);
  assert.match(await msg("invalid"), /Invalid argument/);
  assert.match(await msg("unsupported"), /capabilities/);
  assert.match(await msg("internal"), /backend failed/);
  const f = fake(); f.ctx.ops = null;
  await fails(call("list_functions", {}, f), /No program is open/);
});

test("cancellation: abort cancels the running Job; an already aborted signal never reaches the backend", async () => {
  const jobs = [], f = fake({ decompiler: { decompile: () => hold(jobs) } });
  const p = call("decompile", { function: "main" }, f);
  await sleep(10);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].cancelled, 0);
  f.ctl.abort();
  assert.equal(jobs[0].cancelled, 1);
  jobs[0].resolve({ text: "", tokens: [], cached: false });
  await p.catch(() => {});

  const g = fake(); g.ctl.abort();
  for (const t of readTools) await fails(t.handler(g.ctx, { function: "main", at: "main", target: "main", from: "main", query: "x", address: "0x1", path: "/S" }), /Cancelled/);
  assert.deepEqual(g.calls, []);

  // a job that finishes normally leaves no abort listener behind: aborting later cancels nothing
  const h = fake(); await call("calls", { function: "main" }, h); h.ctl.abort();
  assert.ok(h.jobs.every((j) => j.cancelled === 0));
});

test("disassemble: row format, labels, comments, count continuation, function body", async () => {
  const rows = [
    { address: "0x401000", length: 1, bytes: "55", mnemonic: "push", operands: "rbp", label: "main", header: { signature: "int main(void)", params: 0, paramBytes: 0, localBytes: 0 }, xrefs: { count: 3, items: [] }, plate: "entry\nof program" },
    { address: "0x401001", length: 3, bytes: "48 89 e5", mnemonic: "mov", operands: "rbp,rsp", comment: "set\nframe" },
    { address: "0x401004", length: 1, bytes: "c3", mnemonic: "ret", operands: "", labels: ["a", "b"], label: "a" },
    { address: "0x401040", length: 1, bytes: "90", mnemonic: "nop", operands: "" }, // outside main (size 0x40 ends at 0x401040)
  ];
  const f = fake({ listing: { rows: async ({ count }) => rows.slice(0, count), bytes: async () => ({}) } });
  const out = await call("disassemble", { at: "main", count: 3 }, f);
  assert.equal(out.split("\n").slice(0, 8).join("\n"), [
    "; entry", "; of program", "; function int main(void)", "main:",
    "0x401000  55        push rbp  ; xrefs 3",
    "0x401001  48 89 e5  mov rbp,rsp  ; set\\nframe",
    "a, b:", "0x401004  c3        ret",
  ].join("\n"));
  assert.match(out, /… more rows: call again with at=0x401005$/);
  const body = await call("disassemble", { at: "0x401002", function: true }, f);
  assert.doesNotMatch(body, /0x401040/); assert.doesNotMatch(body, /more rows/);
  assert.match(await call("disassemble", { at: "main", count: 100 }, fake()), /^0x401000/);
});

test("disassemble: a huge function is cut at the cap and resumes at the first dropped row", async () => {
  const rows = Array.from({ length: 3000 }, (_, i) => ({ address: "0x" + (0x10000 + i).toString(16), length: 1, bytes: "90", mnemonic: "nop", operands: "", comment: "c".repeat(60) }));
  const f = fake({ listing: { rows: async ({ address, count }) => { const s = rows.findIndex((r) => r.address === address); return rows.slice(s, s + count); }, bytes: async () => ({}) }, functions: { list: async () => FUNCS, containing: async () => ({ name: "big", entry: "0x10000", size: 3000, signature: "" }) } });
  const seen = []; let at = "0x10000"; let fn = true;
  for (let i = 0; i < 40; i++) {
    const out = (await call("disassemble", { at, function: fn, count: 1000 }, f));
    assert.ok(out.length <= MAX_CHARS + 200);
    const ls = out.split("\n"), m = /at=(0x[0-9a-f]+)/.exec(ls[ls.length - 1]);
    seen.push(...(m ? ls.slice(0, -1) : ls));
    if (!m) break;
    assert.equal(seen[seen.length - 1].split("  ")[0] < m[1], true);
    at = m[1]; fn = false;
  }
  assert.equal(seen.length, 3000);
  assert.deepEqual(seen.map((l) => l.split("  ")[0]), rows.map((r) => r.address));
});

test("xrefs: to / from formats, variable path tries xrefsToVariable first, then variableUses", async () => {
  const f = fake();
  assert.equal(await call("xrefs", { target: "0x401100" }, f), "1 references to 0x401100\n0x401020  call  main");
  assert.deepEqual(f.calls.filter((c) => c.startsWith("xrefs")), ["xrefsTo"]);
  assert.equal(await call("xrefs", { target: "helper", direction: "from" }, fake()), "2 references from 0x401100\n0x401100  call\nstack     read  Stack[-0x10]");

  const g = fake(), out = await call("xrefs", { target: "iVar1", function: "main" }, g);
  assert.deepEqual(g.calls.filter((c) => /^(xrefs|variable)/.test(c)), ["xrefsToVariable", "variableUses"]);
  assert.match(out, /^1 decompiler uses of iVar1 in main\n0x401014  write \(decompiler use\)  main$/);
  assert.ok(g.jobs.every((j) => j.cancelled === 0));

  const h = fake({ references: { xrefsToVariable: async () => [{ from: "0x401030", type: "READ", kind: "read" }], variableUses: () => assert.fail("not reached"), xrefsTo: async () => [] } });
  assert.match(await call("xrefs", { target: "param_1", function: "main" }, h), /^1 references of param_1 in main\n0x401030  read/);
  const nocap = fake({ caps: ["references"] });
  await fails(call("xrefs", { target: "x", function: "main" }, nocap), /no variable references/);
});

test("xrefs variable fallback: aborting cancels variableUses", async () => {
  const jobs = [], f = fake({ references: { xrefsToVariable: async () => [], variableUses: () => hold(jobs) } });
  const p = call("xrefs", { target: "iVar1", function: "main" }, f);
  await sleep(10); f.ctl.abort(); assert.equal(jobs[0].cancelled, 1);
  jobs[0].resolve([]); await p.catch(() => {});
});

test("calls: callers, callees, thunks as stub → target, externals", async () => {
  assert.equal(await call("calls", { function: "main" }), [
    "main @0x401000", "Callers (1):", "  0x400000  start", "Callees (2):", "  0x401500  _printf → printf", "  external  ext",
  ].join("\n"));
});

test("call_graph: edges with names, import marker, truncated note; to= takes maxDepth", async () => {
  const seen = [], f = fake(); const orig = f.ops.references.callGraph; f.ops.references.callGraph = (p) => { seen.push(p); return orig(p); };
  const out = await call("call_graph", { from: "main", depth: 99 }, f);
  assert.match(out, /^2 nodes, 1 edges around main; TRUNCATED/);
  assert.match(out, /\nmain@0x401000 -> printf \[import\]@0x401100  x2$/);
  assert.deepEqual(seen[0], { entry: "0x401000", depth: 6 });
  await call("call_graph", { from: "main", to: "helper", depth: 99 }, f);
  assert.deepEqual(seen[1], { entry: "0x401000", to: "0x401100", maxDepth: 30 });
});

test("strings: quoted and escaped values cannot forge lines; paging by the backend total", async () => {
  const out = await call("strings", { limit: 2 });
  const ls = out.split("\n");
  assert.equal(ls[0], "3 strings");
  assert.equal(ls[1], '0x500000  1  "hello\\nworld"  <- main@0x401010');
  assert.equal(ls[2], '0x500010  0  "\\x1b[31mred"');
  assert.equal(ls[3], "… 1 more lines: call again with offset=2");
  assert.equal(ls.length, 4); assert.ok(!out.includes("\x1b"));
  assert.match(await call("strings", { offset: 2 }), /^3 strings\n0x500020  0  "x"$/);
});

test("search: symbols, strings, bytes with the next continuation, unsupported kinds", async () => {
  assert.match(await call("search", { query: "dup" }), /^2 symbols matching "dup"\n0x402000  function  2  dup\n0x403000/);
  assert.match(await call("search", { query: "o", kind: "strings" }), /^3 strings containing "o"\n0x500000/);
  const f = fake(), out = await call("search", { query: "48 8b ??", kind: "bytes" }, f);
  assert.equal(out, "1 matches in this page\n0x401000  48 8b  main\n… more matches: call again with start=0x402000");
  assert.match(await call("search", { query: "hi", kind: "text", start: "main" }), /matches/);
  await fails(call("search", { query: "x", kind: "nope" }), /Unknown kind/);
  await fails(call("search", { query: "x", kind: "bytes" }, fake({ caps: [] })), /cannot search memory/);
});

test("search symbols with a hostile name: control characters are escaped", async () => {
  const f = fake({ searches: { searchSymbols: () => job([{ name: "evil\n0xdead  function  9  forged", address: "0x1", kind: "function" }]) } });
  const out = await call("search", { query: "evil" }, f);
  assert.equal(out.split("\n").length, 2); assert.match(out, /evil\\n0xdead/);
  assert.equal(esc("a b\u0085c\x00"), "a\\u2028b\\x85c\\x00");
  assert.equal(esc("x".repeat(10), 4), "xxxx…(+6 chars)");
  assert.equal(esc('a"b\\', 10, true), '"a\\"b\\\\"');
});

test("read_bytes: hexdump with ascii, clamps the length, resolves names", async () => {
  const f = fake(), out = await call("read_bytes", { address: "main", length: 20 }, f);
  const ls = out.split("\n");
  assert.equal(ls.length, 2);
  assert.equal(ls[0], "0x401000  41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50  |ABCDEFGHIJKLMNOP|");
  assert.match(ls[1], /^0x401010  51 52 53 54 {38}\|QRST\|$/);
  assert.equal((await call("read_bytes", { address: "0x10", length: 99999 })).split("\n").length, 256);
  assert.equal(hexdump("0xff8", "00 7f 80").join("|"), "0xff8  00 7f 80" + " ".repeat(47 - 8) + "  |...|");
});

test("stack_frame: signed offsets, kind, source", async () => {
  assert.equal(await call("stack_frame", { function: "main" }), [
    "main @0x401000: locals 16 bytes, parameters 8 bytes, 2 slots",
    "+0x8   4  param  int      argc  analysis",
    "-0x10  8  local  char[8]  buf   user",
  ].join("\n"));
});

test("data_type: struct with filler runs, enum, missing path hint; search_types", async () => {
  assert.equal(await call("data_type", { path: "/S" }), [
    "/S  (struct, size 8, program)", "struct S {  // alignment 4", "  /* 0x0 */ int id;  // the id", "  /* 0x4 */ undefined padding[4];", "};",
  ].join("\n"));
  assert.equal(await call("data_type", { path: "/E" }), "/E  (enum, size 4, program)\nenum E {\n  A = 1,\n  B = 2,\n};");
  await fails(call("data_type", { path: "/Nope" }), /Not found.*search_types/);
  assert.equal(await call("search_types", { query: "S" }), "1 types\n/S  struct  8  program");
});

test("wait_for_analysis: already finished returns at once", async () => {
  for (const [state, re] of [["done", /finished/], ["idle", /No analysis is running/], ["cancelled", /cancelled/], ["failed", /failed: oops/]]) {
    const f = fake(); Object.assign(f.state, { state, error: "oops" });
    assert.match(await call("wait_for_analysis", {}, f), re);
    assert.equal(f.listeners.size, 0);
  }
});

test("wait_for_analysis: finishes through the event, then the listener is gone", async () => {
  const f = fake(), p = call("wait_for_analysis", { timeoutSecs: 30 }, f);
  await sleep(10); assert.equal(f.listeners.size, 1);
  f.emit({ state: "running", analysis: "partial", profile: "full", analyzer: "x", done: 1, pct: 50 }); // not final: keeps waiting
  f.listeners.forEach((l) => l("other-session", { state: "done" })); // another session's event is ignored
  await sleep(10); assert.equal(f.listeners.size, 1);
  f.emit({ state: "done", analysis: "done", profile: "full", analyzer: "", done: 9, pct: 100 });
  assert.match(await p, /finished/);
  assert.equal(f.listeners.size, 0);
});

test("wait_for_analysis: timeout reports progress; abort rejects; both unsubscribe and leave no abort listener", async () => {
  const f = fake(), t0 = Date.now();
  assert.match(await call("wait_for_analysis", { timeoutSecs: 0.05 }, f), /still running: 40% \(Decompiler\)/);
  assert.ok(Date.now() - t0 < 1000); assert.equal(f.listeners.size, 0);

  const g = fake(), p = call("wait_for_analysis", { timeoutSecs: 30 }, g);
  await sleep(10); assert.equal(g.listeners.size, 1);
  g.ctl.abort();
  await fails(p, /Cancelled/); assert.equal(g.listeners.size, 0);

  // the poll catches a finish whose event was missed
  const h = fake(), q = call("wait_for_analysis", { timeoutSecs: 30 }, h);
  await sleep(10); h.state.state = "done";
  assert.match(await q, /finished/); assert.equal(h.listeners.size, 0);
});

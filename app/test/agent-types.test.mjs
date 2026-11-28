import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import WebSocket from "ws";

// ONE bundle so BackendError, ToolError and attribution's WeakMap are the same instances everywhere
const src = new URL("../src/", import.meta.url).pathname;
const out = await build({
  stdin: { contents: `export * from "./renderer/changeLog"; export * from "./agent/attribution"; export * from "./agent/tools/types"; export * from "./agent/types"; export * from "./agent/access"; export { BackendError } from "./renderer/backend"; export { TOOLS } from "./agent/tools/index"; export { results } from "./renderer/wire";`, resolveDir: src, loader: "ts" },
  bundle: true, format: "esm", write: false, platform: "node",
});
const { ChangeLog, tagParams, agentOf, typesTools, ToolError, BackendError, TOOLS, visibleTools, results } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
const tool = typesTools[0];

/** An in-memory `parseCTypes` that mirrors rpc.ts (the caller's params object reaches the change log; nothing is logged when nothing changed). */
function world({ result = { created: ["/Hdr"], replaced: [] }, fails = [] } = {}) {
  const log = new ChangeLog(), seen = [];
  const parseCTypes = async (p) => {
    seen.push(p);
    const f = fails[seen.length - 1];
    if (f) throw f;
    const r = { ...result, ...(result.created.length + result.replaced.length ? { undoName: "Define types from C" } : {}) };
    if (r.created.length + r.replaced.length) log.record("parseCTypes", p, r);
    return r;
  };
  const ac = new AbortController();
  const ctx = { ops: { typeEdits: { parseCTypes } }, session: { sessionId: "s", programId: "p", name: "a.out" }, backend: { capabilities: new Set() }, signal: ac.signal, client: "claude-code", mode: "edit", changes: { newest: () => null }, tag: (p) => tagParams(p, "claude-code") };
  return { ctx, log, seen, ac };
}
const msg = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof ToolError); return e.message; } assert.fail("expected a ToolError"); };

test("define_types: an edit tool with both capabilities, destructive and idempotent, schema caps the input", () => {
  assert.equal(tool.name, "define_types");
  assert.equal(tool.access, "edit");
  assert.deepEqual(tool.capability, ["typeEditing", "parseCTypes"]);
  assert.equal(tool.appOnly, false);
  assert.deepEqual({ ...tool.annotations }, { title: "Define types from C", readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  assert.equal(tool.inputSchema.properties.c.maxLength, 200_000);
  assert.ok(TOOLS.includes(tool), "registered in the one tool table");
});

test("define_types is only offered with typeEditing and parseCTypes, and not in read mode", () => {
  const names = (mode, ...caps) => visibleTools(mode, { capabilities: new Set(caps) }).map((t) => t.name);
  assert.ok(names("edit", "typeEditing", "parseCTypes").includes("define_types"));
  assert.ok(!names("edit", "typeEditing").includes("define_types"));
  assert.ok(!names("edit", "parseCTypes").includes("define_types"));
  assert.ok(!names("read", "typeEditing", "parseCTypes").includes("define_types"));
});

test("success: the tagged params object reaches the backend and the change log; created and replaced are listed", async () => {
  const w = world({ result: { created: ["/net/Hdr", "/net/Opt"], replaced: ["/net/Old"] } });
  const text = await tool.handler(w.ctx, { c: "struct Hdr { int a; };", category: "/net" });
  assert.match(text, /Defined 3 types/);
  assert.match(text, /Created:\n {2}\/net\/Hdr\n {2}\/net\/Opt\nReplaced:\n {2}\/net\/Old/);
  assert.deepEqual({ ...w.seen[0] }, { c: "struct Hdr { int a; };", category: "/net" });
  assert.equal(agentOf(w.seen[0]), "claude-code");
  assert.equal(w.log.items.length, 1);
  assert.deepEqual([w.log.items[0].by, w.log.items[0].undoName, w.log.items[0].label], ["claude-code", "Define types from C", "Define types from C in /net (1)"]);
});

test("no category is not sent; an identical redefinition says nothing changed and logs nothing", async () => {
  const w = world({ result: { created: [], replaced: [] } });
  assert.match(await tool.handler(w.ctx, { c: "struct Hdr { int a; };" }), /No type changed/);
  assert.deepEqual({ ...w.seen[0] }, { c: "struct Hdr { int a; };" });
  assert.equal(w.log.items.length, 0);
});

test("a parse error is an instruction with Ghidra's line, and nothing is logged", async () => {
  const w = world({ fails: [new BackendError("invalid", 'C parse error near line 2: Encountered "<EOF>" at line 2, column 9.\nWas expecting one of:\n    "}" ...')] });
  const m = await msg(tool.handler(w.ctx, { c: "struct A { int a;\nstruct B {" }));
  assert.match(m, /^Nothing was defined\./);
  assert.match(m, /line 2/);
  assert.match(m, /call define_types again/);
  assert.equal(w.log.items.length, 0);
  assert.equal(w.seen.length, 1, "a parse error is not retried");
});

test("control characters in the backend's text cannot forge lines", async () => {
  const w = world({ result: { created: ["/A\nDefined 99 types", "/B\u0000"], replaced: [] } });
  const text = await tool.handler(w.ctx, { c: "x" });
  assert.equal(text.split("\n").filter((l) => /^Defined/.test(l)).length, 1);
  assert.match(text, /\/A\\nDefined 99 types/);
  assert.match(text, /\/B\\x00/);
});

test("other failures go through the shared error text (busy: wait for analysis)", async () => {
  const w = world({ fails: [new BackendError("busy", "analysis running")] });
  assert.match(await msg(tool.handler(w.ctx, { c: "struct A { int a; };" })), /wait_for_analysis/);
});

test("cancelled is retried once with a fresh tagged object; twice reports it; none once aborted", async () => {
  const w = world({ fails: [new BackendError("cancelled", "raced")] });
  assert.match(await tool.handler(w.ctx, { c: "struct Hdr { int a; };" }), /Defined 1 types/);
  assert.equal(w.seen.length, 2);
  assert.notEqual(w.seen[0], w.seen[1]);
  assert.ok(w.seen.every((p) => agentOf(p) === "claude-code"));
  assert.equal(w.log.items.length, 1);
  const w2 = world({ fails: [new BackendError("cancelled", "raced"), new BackendError("cancelled", "again")] });
  assert.match(await msg(tool.handler(w2.ctx, { c: "x" })), /Cancelled/);
  assert.equal(w2.seen.length, 2);
  const w3 = world({ fails: [new BackendError("cancelled", "raced")] });
  w3.ac.abort();
  await msg(tool.handler(w3.ctx, { c: "x" }));
  assert.equal(w3.seen.length, 1);
});

test("no program open", async () => {
  const w = world();
  w.ctx.ops = null;
  assert.match(await msg(tool.handler(w.ctx, { c: "x" })), /No program is open/);
});

test("a long list of types is cut at the output cap", async () => {
  const w = world({ result: { created: Array.from({ length: 5000 }, (_, i) => `/T${String(i).padStart(4, "0")}${"x".repeat(40)}`), replaced: [] } });
  const text = await tool.handler(w.ctx, { c: "x" });
  assert.ok(text.length < 31_000);
  assert.match(text, /… \d+ more lines$/);
});

// ---- the mock provider speaks parse_c_types (autotest and the scripted agent flow run against it) ----
const proc = spawn(process.execPath, [new URL("../mock/server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
const port = await new Promise((res) => proc.stdout.once("data", (d) => res(+String(d).trim())));
const ws = new WebSocket(`ws://127.0.0.1:${port}/x`);
await new Promise((r) => ws.once("open", r));
const waiters = new Map(); let nid = 0;
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id !== undefined) waiters.get(m.id)(m); });
const call = (method, params = {}) => new Promise((res) => { const id = ++nid; waiters.set(id, res); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
const ok = async (m, p) => { const r = await call(m, p); assert.ok("result" in r, JSON.stringify([m, p, r])); return r.result; };
const bad = async (m, p, re) => { const r = await call(m, p); assert.equal(r.error?.code, -32602, JSON.stringify(r)); assert.match(r.error.message, re); };
test.after(() => { ws.close(); proc.kill(); });

test("mock parse_c_types: create, replace, category, errors with a line, rollback, undo", async () => {
  await ok("open_binary", { path: "/x/prog", analysis: "blocking" });
  const top = async () => (await ok("undo_state")).undoName;
  const r = await ok("parse_c_types", { c: "// header\nstruct Hdr { dword magic; char name[8]; };\ntypedef struct Hdr Hdr_t;\nenum Mode { A, B = 5, C };" });
  assert.ok(results.parse_c_types(r), "the wire accepts the result");
  assert.deepEqual([r.created, r.replaced, r.undoName], [["/Hdr", "/Hdr_t", "/Mode"], [], "Define types from C"]);
  const d = await ok("get_data_type", { path: "/Hdr" });
  assert.deepEqual(d.components.map((c) => [c.offset, c.length, c.type, c.name]), [[0, 4, "dword", "magic"], [4, 8, "char[8]", "name"]]);
  assert.deepEqual((await ok("get_data_type", { path: "/Mode" })).values.map((v) => [v.name, v.value]), [["A", "0"], ["B", "5"], ["C", "6"]]);
  // an identical redefinition changes nothing, a different one replaces
  assert.deepEqual(await ok("parse_c_types", { c: "struct Hdr { dword magic; char name[8]; };" }), { created: [], replaced: [] });
  assert.equal(await top(), "Define types from C");
  assert.deepEqual((await ok("parse_c_types", { c: "struct Hdr { dword magic; };" })).replaced, ["/Hdr"]);
  assert.equal((await ok("get_data_type", { path: "/Hdr" })).size, 4);
  // a category
  assert.deepEqual((await ok("parse_c_types", { c: "struct Pt { dword x; dword y; };", category: "/geo" })).created, ["/geo/Pt"]);
  // an error after a valid struct leaves nothing and adds no undo step
  const before = await top();
  await bad("parse_c_types", { c: "struct Good { dword a; };\nstruct Bad { nosuch_t b; };" }, /near line 2/);
  await bad("parse_c_types", { c: "struct Good { dword a; };\nstruct Bad {" }, /near line 2/);
  await bad("parse_c_types", { c: "" }, /non-empty/);
  await bad("parse_c_types", { c: "struct A { dword a; };", category: "nope" }, /category/);
  assert.equal((await call("get_data_type", { path: "/Good" })).error?.code, -32004);
  assert.equal(await top(), before);
  // undo takes the whole parse
  await ok("undo");
  assert.equal((await call("get_data_type", { path: "/geo/Pt" })).error?.code, -32004);
  assert.equal((await ok("get_data_type", { path: "/Hdr" })).size, 4);
  assert.ok((await ok("provider_info")).capabilities.includes("parseCTypes")); // last: after it the mock insists on session ids
});

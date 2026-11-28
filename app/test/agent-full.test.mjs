import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const src = new URL("../src/", import.meta.url).pathname;
const out = await build({
  stdin: { contents: `export * from "./agent/tools/full"; export * from "./agent/types"; export * from "./agent/attribution"; export { visibleTools } from "./agent/access"; export { TOOLS } from "./agent/tools/index";`, resolveDir: src, loader: "ts" },
  bundle: true, format: "esm", write: false, platform: "node",
});
const { fullTools, checkPath, ToolError, tagParams, agentOf, visibleTools, TOOLS } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
const tool = (n) => fullTools.find((t) => t.name === n);
const msg = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof ToolError, String(e)); return e.message; } assert.fail("expected a ToolError"); };
const job = (v) => ({ result: Promise.resolve(v), cancel() {} });

function world({ mode = "full", ui = "app", confirm = true, session = true, rowLength = 3, assembled } = {}) {
  const calls = [], prompts = [];
  const entries = [{ programId: "abc", name: "a.out", options: {} }, { programId: "def", name: "b.out", options: {} }];
  const ops = {
    searches: { searchSymbols: () => job([]) },
    listing: { rows: async () => [{ address: "0x401000", length: rowLength }] },
    patch: {
      assemble: ({ address, text }) => (calls.push(["assemble", address, text]), job(assembled ?? { address, bytes: "90", length: 1, oldBytes: "48 89 e5", oldLength: 3, overwrites: 0 })),
      apply: async (p) => (calls.push(["apply", p]), { address: p.address, length: p.bytes.split(" ").length, replaced: 1, overwritten: p.overwriteFollowing ? 1 : 0 }),
      list: async () => [{ address: "0x401000", length: 1, original: "48", current: "90" }],
    },
    history: { save: async () => ({ saved: true, undoHistoryCleared: true }) },
    exports: { symbols: async (p) => ({ path: p.path, functions: 2, labels: 1, data: 0, comments: 3 }), header: async (p) => ({ path: p.path, types: 1, functions: 2, skipped: 0 }), gzf: async (p) => ({ path: p.path, bytes: 99 }) },
    coverage: { load: async () => ({ ranges: [{ start: "0x401000", end: "0x401007" }, { start: "0x401004", end: "0x40100f" }, { start: "0x403000", end: "0x403000" }] }) },
  };
  let active = session ? { sessionId: "s", programId: "abc", name: "a.out" } : null;
  const backend = {
    capabilities: new Set(["patch", "export", "exportGzf"]),
    projects: { list: async () => entries, reopen: (e) => (calls.push(["reopen", e.programId]), job((active = { sessionId: "s2", programId: e.programId, name: e.name }))) },
    lifecycle: { active: async () => active, close: async (s) => { calls.push(["close", s.sessionId]); active = null; }, open: (p) => (calls.push(["open", p]), job((active = { sessionId: "s3", programId: "new", name: "new" }))) },
  };
  const appUi = { confirm: async (m) => (prompts.push(m), confirm), openProgram: async (t) => { calls.push(["uiOpen", t]); active = { sessionId: "s4", programId: "abc", name: "a.out" }; }, closeProgram: async () => { calls.push(["uiClose"]); active = null; } };
  const ctx = {
    ops: session ? ops : null, session: active, backend, mode, client: "claude-code", signal: new AbortController().signal, changes: { newest: () => null },
    ui: ui === "app" ? appUi : undefined,
    functions: async () => [{ name: "f", entry: "0x401000", size: 16 }, { name: "g", entry: "0x402000", size: 8 }, { name: "h", entry: "0x403000", size: 4 }],
    tag: (p) => tagParams(p, "claude-code"),
  };
  return { ctx, calls, prompts };
}

test("patch with asm: reports overwrites and refuses without overwriteFollowing, writes with it (tagged)", async () => {
  const w = world({ assembled: { address: "0x401000", bytes: "b8 01 00 00 00", length: 5, oldBytes: "48 89 e5", oldLength: 3, overwrites: 2 } });
  const m = await msg(tool("patch").handler(w.ctx, { address: "0x401000", asm: "mov eax, 1" }));
  assert.match(m, /overwrite 2 following/); assert.match(m, /overwriteFollowing=true/);
  assert.ok(!w.calls.some((c) => c[0] === "apply"));
  const ok = await tool("patch").handler(w.ctx, { address: "0x401000", asm: "mov eax, 1", overwriteFollowing: true });
  const apply = w.calls.find((c) => c[0] === "apply")[1];
  assert.deepEqual({ ...apply }, { address: "0x401000", bytes: "b8 01 00 00 00", overwriteFollowing: true });
  assert.equal(agentOf(apply), "claude-code"); assert.match(ok, /Patched 0x401000/);
});

test("patch that fits is applied without the flag; bytes mode checks the unit length", async () => {
  const w = world();
  await tool("patch").handler(w.ctx, { address: "0x401000", asm: "nop" });
  assert.equal(w.calls.find((c) => c[0] === "apply")[1].overwriteFollowing, undefined);
  assert.match(await msg(tool("patch").handler(w.ctx, { address: "0x401000", bytes: "90 90 90 90" })), /spill over the 3-byte unit/);
  await tool("patch").handler(w.ctx, { address: "0x401000", bytes: "90  90" });
  assert.equal(w.calls.filter((c) => c[0] === "apply").at(-1)[1].bytes, "90 90");
  assert.match(await msg(tool("patch").handler(w.ctx, { address: "0x401000", bytes: "zz" })), /hex pairs/);
  assert.match(await msg(tool("patch").handler(w.ctx, { address: "0x401000" })), /exactly one/);
});

test("save and list_patches", async () => {
  const w = world();
  assert.match(await tool("save").handler(w.ctx, {}), /undo history is gone/);
  assert.match(tool("save").description, /ENDS THE USER'S UNDO HISTORY/);
  assert.match(await tool("list_patches").handler(w.ctx, {}), /0x401000\s+1\s+48\s+90/);
});

test("export refuses relative and non-normalised paths, writes absolute ones", async () => {
  const w = world();
  for (const p of ["out.json", "./out.json", "~/out.json", "/tmp/../etc/x", "/tmp//x", "/tmp/x/."]) assert.match(await msg(tool("export").handler(w.ctx, { kind: "symbols", path: p })), /absolute|normalised/, p);
  assert.match(await msg(tool("export").handler(w.ctx, { kind: "symbols", path: "/tmp/x\ny" })), /control/);
  assert.match(await tool("export").handler(w.ctx, { kind: "header", path: "/tmp/h.h" }), /1 types, 2 functions/);
  assert.match(await tool("export").handler(w.ctx, { kind: "gzf", path: "C:\\out\\p.gzf" }), /99 bytes/);
  assert.equal(checkPath("/a/b"), "/a/b");
});

test("open/close: confirmed below Full, declined, no prompt in Full or headless", async () => {
  let w = world({ mode: "edit" });
  const r = await tool("open_program").handler(w.ctx, { program: "b.out" });
  assert.equal(w.prompts.length, 1); assert.match(w.prompts[0], /"b\.out".*saves and closes "a\.out"/);
  assert.deepEqual(w.calls.find((c) => c[0] === "uiOpen")[1], { programId: "def" }); assert.match(r, /Opened/);
  w = world({ mode: "edit", confirm: false });
  assert.match(await msg(tool("open_program").handler(w.ctx, { program: "def" })), /declined/);
  assert.match(await msg(tool("close_program").handler(w.ctx, {})), /declined/);
  assert.equal(w.calls.length, 0);
  w = world({ mode: "edit" }); await tool("close_program").handler(w.ctx, {});
  assert.match(w.prompts[0], /close "a\.out"/); assert.ok(w.calls.some((c) => c[0] === "uiClose"));
  w = world({ mode: "full" });
  await tool("open_program").handler(w.ctx, { program: "def" }); await tool("close_program").handler(w.ctx, {});
  assert.equal(w.prompts.length, 0);
  w = world({ mode: "edit", ui: "none" }); // headless
  await tool("open_program").handler(w.ctx, { program: "abc" }); await tool("open_program").handler(w.ctx, { path: "/bin/ls" }); await tool("close_program").handler(w.ctx, {});
  assert.deepEqual(w.calls.map((c) => c[0]), ["reopen", "open", "close"]); assert.equal(w.prompts.length, 0);
});

test("open_program lists, resolves by name, rejects unknown, relative path", async () => {
  const w = world({ mode: "full", ui: "none" });
  assert.match(await tool("open_program").handler(w.ctx, {}), /2 stored programs.*b\.out/);
  assert.match(await msg(tool("open_program").handler(w.ctx, { program: "nope" })), /No stored program/);
  assert.match(await msg(tool("open_program").handler(w.ctx, { path: "bin/ls" })), /absolute/);
  assert.match(await msg(tool("open_program").handler(w.ctx, { path: "/bin/ls", program: "abc" })), /not both/);
});

test("load_coverage summarises per function; relative path refused", async () => {
  const w = world();
  const r = await tool("load_coverage").handler(w.ctx, { path: "/tmp/cov.txt" });
  assert.match(r, /3 ranges \(17 bytes\), touching 2 of 3 functions/);
  assert.match(r, /f\s+0x401000\s+16\/16\s+100%/); assert.match(r, /h\s+0x403000\s+1\/4\s+25%/); assert.ok(!/\bg\b\s+0x402000/.test(r));
  assert.match(await msg(tool("load_coverage").handler(w.ctx, { path: "cov.txt" })), /absolute/);
});

test("no program is a tool error; visibility follows the mode", async () => {
  const w = world({ session: false });
  assert.match(await msg(tool("save").handler(w.ctx, {})), /No program is open/);
  const names = (mode) => visibleTools(mode).map((t) => t.name);
  for (const n of ["patch", "list_patches", "save", "export", "load_coverage"]) { assert.ok(!names("edit").includes(n), n); assert.ok(names("full").includes(n), n); }
  for (const n of ["open_program", "close_program"]) { assert.ok(!names("read").includes(n)); assert.ok(names("edit").includes(n)); }
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length);
  for (const t of fullTools) assert.ok(t.annotations.title && typeof t.annotations.readOnlyHint === "boolean" && typeof t.annotations.destructiveHint === "boolean" && typeof t.annotations.idempotentHint === "boolean", t.name);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// ONE bundle so BackendError, ToolError and attribution's WeakMap are the same instances everywhere
const src = new URL("../src/", import.meta.url).pathname;
const out = await build({
  stdin: { contents: `export * from "./renderer/changeLog"; export * from "./agent/attribution"; export * from "./agent/tools/edit"; export * from "./agent/types"; export { BackendError } from "./renderer/backend"; export { TOOLS } from "./agent/tools/index";`, resolveDir: src, loader: "ts" },
  bundle: true, format: "esm", write: false, platform: "node",
});
const { ChangeLog, tagParams, agentOf, editTools, ToolError, BackendError, TOOLS } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
const tool = (name) => editTools.find((t) => t.name === name);

const sym = (name, address, kind = "function") => ({ name, address, kind });
const SYMS = [sym("main", "0x401000"), sym("FUN_00401000x", "0x401800"), sym("helper", "0x405000"), sym("helper", "0x406000", "label"), sym("dup", "0x407000"), sym("dup", "0x408000")];
const FN = { name: "main", entry: "0x401000", size: 64, signature: "int main(void)" };

/**
 * An in-memory program. Every edit mirrors rpc.ts's `edit()` (the caller's own params object goes to the change log) and the sidecar's undo step names
 * (docs: `ses.edit(name, ...)`), so the undo guard runs against the real label/undoName pairs.
 */
function world({ client = "claude-code", fails = {} } = {}) {
  const log = new ChangeLog(), stack = [], seen = [], undoCalls = [], attempts = {};
  const sidecarName = {
    renameSymbol: (p) => `Rename old to ${p.newName}`, createLabel: (p) => `Create label ${p.name}`, setComment: (p) => `${p.text ? "Set" : "Clear"} ${p.kind} comment`,
    createFunction: (p) => `Create function at ${p.address}`, setFunctionSignature: () => "Edit signature of main", renameVariable: () => "Rename variable in main",
    retypeVariable: () => "Retype variable in main", defineData: () => "Define data", setBookmark: () => "Set bookmark",
    createDataType: (p) => `Create ${p.kind} ${p.name ?? "pointer"}`, editStruct: (p) => `Edit ${p.path.split("/").pop()}: ${p.op.op}`, editEnum: (p) => `Edit ${p.path.split("/").pop()}: ${p.op.op}`,
  };
  const mk = (cmd, result = {}) => async (p) => {
    seen.push({ cmd, p });
    const n = (attempts[cmd] = (attempts[cmd] ?? 0) + 1), f = fails[cmd]?.[n - 1];
    if (f) throw f;
    const name = sidecarName[cmd](p), r = { ...(typeof result === "function" ? result(p) : result), undoName: name }; // like the sidecar: the result names the step it committed
    stack.push(name);
    log.record(cmd, p, r);
    return r;
  };
  const user = (cmd, p) => { const name = sidecarName[cmd](p); stack.push(name); log.record(cmd, p, { undoName: name }); }; // the UI: untagged params
  const ops = {
    searches: { searchSymbols: ({ query }) => ({ result: Promise.resolve(SYMS.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))), cancel() {} }) },
    functions: { containing: async ({ address }) => (address === "0x401000" || address === "0x401010" ? FN : null) },
    edits: {
      renameSymbol: mk("renameSymbol"), createLabel: mk("createLabel"), setComment: mk("setComment"), setFunctionSignature: mk("setFunctionSignature"),
      renameVariable: mk("renameVariable"), retypeVariable: mk("retypeVariable"), defineData: mk("defineData"),
      createFunction: mk("createFunction", (p) => ({ entry: p.address, name: p.name ?? "FUN_new" })),
    },
    typeEdits: { createDataType: mk("createDataType", (p) => ({ path: `/${p.name ?? "ptr"}` })), editStruct: mk("editStruct"), editEnum: mk("editEnum") },
    bookmarks: { set: mk("setBookmark") },
    history: {
      state: async () => ({ canUndo: stack.length > 0, canRedo: false, undoName: stack.at(-1), dirty: stack.length > 0 }),
      undo: async (expect) => { // the sidecar's `undo {expect}`: checked where the stack lives, nothing undone on a mismatch
        if (!stack.length) throw new BackendError("invalid", "nothing to undo");
        if (expect !== undefined && stack.at(-1) !== expect) throw new BackendError("cancelled", `the top undo step is '${stack.at(-1)}', not '${expect}'; nothing was undone`);
        undoCalls.push(stack.at(-1)); stack.pop(); log.record("undo", {}, {}); return { canUndo: stack.length > 0, canRedo: true, dirty: true };
      },
    },
  };
  const ac = new AbortController();
  const ctx = {
    ops, session: { sessionId: "s", programId: "p", name: "a.out" }, backend: { capabilities: new Set() }, signal: ac.signal, client, mode: "edit",
    changes: { newest: () => { const c = [...log.items].reverse().find((x) => !x.undone && !x.saved && !x.locked); return c ? { label: c.label, by: c.by, undoName: c.undoName } : null; } },
    tag: (p) => tagParams(p, client),
  };
  return { ctx, log, stack, seen, undoCalls, ac, user, attempts };
}
const msg = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof ToolError); return e.message; } assert.fail("expected a ToolError"); };

test("each tool sends the resolved params to its op, tagged with the client (same object)", async () => {
  const w = world();
  const cases = [
    ["rename_symbol", { target: "main", newName: "entry" }, "renameSymbol", { address: "0x401000", newName: "entry" }, /Renamed main to entry at 0x401000/],
    ["create_label", { address: "0x402000", name: "lbl" }, "createLabel", { address: "0x402000", name: "lbl" }, /Created label lbl at 0x402000/],
    ["rename_variable", { function: "main", variable: "local_10", newName: "len" }, "renameVariable", { entry: "0x401000", name: "local_10", newName: "len" }, /Renamed local_10 to len in main/],
    ["retype_variable", { function: "0x401010", variable: "param_1", type: "char *" }, "retypeVariable", { entry: "0x401000", name: "param_1", dataType: "char *" }, /Retyped param_1 as char \*/],
    ["set_function_signature", { function: "main", signature: " int main(int argc) " }, "setFunctionSignature", { entry: "0x401000", signature: "int main(int argc)" }, /Set the signature of main/],
    ["set_comment", { address: "0x401000", text: "entry point" }, "setComment", { address: "0x401000", kind: "eol", text: "entry point" }, /Set the eol comment at 0x401000/],
    ["set_comment", { address: "401000", text: "", kind: "plate" }, "setComment", { address: "0x401000", kind: "plate", text: "" }, /Cleared the plate comment/],
    ["define_data", { address: "code:2000", type: "char[16]" }, "defineData", { address: "code:2000", dataType: "char[16]" }, /Defined char\[16\] at code:2000/],
    ["create_function", { address: "0x403000", name: "f" }, "createFunction", { address: "0x403000", name: "f" }, /Created function f at 0x403000/],
    ["create_function", { address: "0x403100" }, "createFunction", { address: "0x403100" }, /Created function FUN_new at 0x403100/],
    ["set_bookmark", { address: "0x401000", comment: "parses input" }, "setBookmark", { address: "0x401000", category: "agent", comment: "parses input" }, /Bookmarked 0x401000 \(agent\)/],
    ["create_type", { kind: "struct", name: "Hdr", size: 8 }, "createDataType", { kind: "struct", name: "Hdr", size: 8 }, /Created struct \/Hdr/],
    ["edit_struct", { path: "/Hdr", op: { op: "add", type: "int", name: "magic" } }, "editStruct", { path: "/Hdr", op: { op: "add", type: "int", name: "magic" } }, /Edited \/Hdr: add/],
    ["edit_enum", { path: "/E", op: { op: "set", name: "A", value: "0x1" } }, "editEnum", { path: "/E", op: { op: "set", name: "A", value: "0x1" } }, /Edited \/E: set/],
  ];
  for (const [name, args, cmd, params, text] of cases) {
    const before = w.seen.length;
    assert.match(await tool(name).handler(w.ctx, args), text, name);
    assert.equal(w.seen.length, before + 1, `${name} made one call`);
    const { cmd: got, p } = w.seen.at(-1);
    assert.equal(got, cmd, name);
    assert.deepEqual({ ...p }, params, name);
    assert.equal(agentOf(p), "claude-code", `${name}: the params object the op saw is tagged`);
  }
  assert.ok(w.log.items.every((c) => c.by === "claude-code"), "and so is every change-log entry");
  assert.equal(w.log.items.length, cases.length);
});

test("a user's edit between two agent edits is not attributed to the agent", async () => {
  const w = world();
  await tool("rename_symbol").handler(w.ctx, { target: "main", newName: "a" });
  w.user("setComment", { address: "0x1", kind: "eol", text: "mine" });
  await tool("rename_symbol").handler(w.ctx, { target: "0x401800", newName: "b" });
  assert.deepEqual(w.log.items.map((c) => c.by), ["claude-code", undefined, "claude-code"]);
});

test("ambiguous and unknown names edit nothing and say why", async () => {
  const w = world();
  const m = await msg(tool("rename_symbol").handler(w.ctx, { target: "helper", newName: "x" }));
  assert.match(m, /ambiguous/); assert.match(m, /0x405000/); assert.match(m, /0x406000/);
  assert.match(await msg(tool("rename_variable").handler(w.ctx, { function: "dup", variable: "a", newName: "b" })), /ambiguous/);
  assert.match(await msg(tool("set_comment").handler(w.ctx, { address: "nope_nothing", text: "x" })), /No symbol named/);
  assert.match(await msg(tool("rename_variable").handler(w.ctx, { function: "0x999999", variable: "a", newName: "b" })), /No function contains/);
  assert.equal(w.seen.length, 0);
});

test("no program open: a tool says so", async () => {
  const w = world();
  w.ctx.ops = null;
  assert.match(await msg(tool("rename_symbol").handler(w.ctx, { target: "main", newName: "x" })), /No program is open/);
});

test("cancelled is retried once, with a fresh tagged params object", async () => {
  const w = world({ fails: { renameVariable: [new BackendError("cancelled", "raced")] } });
  assert.match(await tool("rename_variable").handler(w.ctx, { function: "main", variable: "a", newName: "b" }), /Renamed a to b/);
  const calls = w.seen.filter((s) => s.cmd === "renameVariable");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].p, calls[1].p);
  assert.ok(calls.every((c) => agentOf(c.p) === "claude-code"));
  assert.equal(w.log.items.length, 1);
  assert.equal(w.log.items[0].by, "claude-code");
});

test("cancelled twice reports the failure; the message says what to do", async () => {
  const w = world({ fails: { retypeVariable: [new BackendError("cancelled", "raced"), new BackendError("cancelled", "raced again")] } });
  const m = await msg(tool("retype_variable").handler(w.ctx, { function: "main", variable: "a", type: "int" }));
  assert.match(m, /Cancelled/);
  assert.equal(w.seen.length, 2);
  assert.equal(w.log.items.length, 0);
});

test("other failures are not retried: busy points at wait_for_analysis", async () => {
  const w = world({ fails: { renameVariable: [new BackendError("busy", "analysis running"), new BackendError("busy", "analysis running")] } });
  const m = await msg(tool("rename_variable").handler(w.ctx, { function: "main", variable: "a", newName: "b" }));
  assert.match(m, /wait_for_analysis/);
  assert.equal(w.seen.length, 1);
  const w2 = world({ fails: { defineData: [new BackendError("invalid", "no room")] } });
  assert.match(await msg(tool("define_data").handler(w2.ctx, { address: "0x401000", type: "int" })), /Invalid argument: no room/);
  assert.equal(w2.seen.length, 1);
});

test("no retry once the call is aborted", async () => {
  const w = world({ fails: { renameVariable: [new BackendError("cancelled", "raced")] } });
  w.ac.abort();
  assert.match(await msg(tool("rename_variable").handler(w.ctx, { function: "main", variable: "a", newName: "b" })), /Cancelled/);
  assert.equal(w.seen.length, 1);
});

test("undo_agent_edit: the user's edit is newest: refused, undo not called", async () => {
  const w = world();
  await tool("rename_symbol").handler(w.ctx, { target: "main", newName: "a" });
  w.user("setComment", { address: "0x1", kind: "eol", text: "mine" });
  assert.match(await msg(tool("undo_agent_edit").handler(w.ctx, {})), /user's/);
  assert.equal(w.undoCalls.length, 0);
  assert.equal(w.stack.length, 2);
});

test("undo_agent_edit: the agent's edit is newest: undone, and the log entry flips", async () => {
  const w = world();
  w.user("setComment", { address: "0x1", kind: "eol", text: "mine" });
  await tool("rename_symbol").handler(w.ctx, { target: "main", newName: "a" });
  assert.match(await tool("undo_agent_edit").handler(w.ctx, {}), /Undid: Rename to a/);
  assert.deepEqual(w.undoCalls, ["Rename old to a"]);
  assert.deepEqual(w.log.items.map((c) => c.undone), [false, true]);
  assert.match(await msg(tool("undo_agent_edit").handler(w.ctx, {})), /user's/); // the next one down is the user's
  assert.equal(w.undoCalls.length, 1);
});

test("undo_agent_edit: another agent's edit, nothing to undo, saved or locked entries, mismatching undo name", async () => {
  const other = world({ client: "codex" });
  await tool("set_bookmark").handler(other.ctx, { address: "0x401000", comment: "x" });
  other.ctx.client = "claude-code"; // a different client asks
  assert.match(await msg(tool("undo_agent_edit").handler(other.ctx, {})), /made by codex/);
  assert.equal(other.undoCalls.length, 0);

  const none = world();
  assert.match(await msg(tool("undo_agent_edit").handler(none.ctx, {})), /Nothing to undo/);

  const saved = world();
  await tool("rename_symbol").handler(saved.ctx, { target: "main", newName: "a" });
  saved.log.record("save", {}, { saved: true, undoHistoryCleared: true }); // newest() skips saved entries
  assert.match(await msg(tool("undo_agent_edit").handler(saved.ctx, {})), /Nothing to undo/);

  const locked = world();
  await tool("rename_symbol").handler(locked.ctx, { target: "main", newName: "a" });
  locked.log.reconcile({ canUndo: false, canRedo: false, dirty: true });
  assert.equal(locked.log.items[0].locked, true);
  assert.match(await msg(tool("undo_agent_edit").handler(locked.ctx, {})), /Nothing to undo/);
  assert.equal(saved.undoCalls.length + locked.undoCalls.length, 0);

  const gone = world(); // the log has the entry, the provider's history does not (an analysis cleared it)
  await tool("rename_symbol").handler(gone.ctx, { target: "main", newName: "a" });
  gone.stack.length = 0;
  assert.match(await msg(tool("undo_agent_edit").handler(gone.ctx, {})), /no undo history/);

  const skew = world(); // an edit the log never saw lands on top of ours (the race the provider's `expect` closes): it refuses, nothing is undone
  await tool("rename_symbol").handler(skew.ctx, { target: "main", newName: "a" });
  skew.stack.push("Set eol comment");
  assert.match(await msg(tool("undo_agent_edit").handler(skew.ctx, {})), /no longer the newest undo step/);
  assert.equal(skew.undoCalls.length, 0);
  assert.equal(skew.stack.length, 2);

  const old = world(); // a provider that does not report undo names: the tool refuses rather than guess
  await tool("rename_symbol").handler(old.ctx, { target: "main", newName: "a" });
  delete old.log.items[0].undoName;
  assert.match(await msg(tool("undo_agent_edit").handler(old.ctx, {})), /did not report an undo step/);
  assert.equal(old.undoCalls.length, 0);
});

test("every agent edit kind logs the undo step its result named, and each can be undone in turn through `expect`", async () => {
  const w = world();
  const run = [
    ["rename_symbol", { target: "main", newName: "a" }], ["create_label", { address: "0x402000", name: "lbl" }], ["rename_variable", { function: "main", variable: "a", newName: "b" }],
    ["retype_variable", { function: "main", variable: "a", type: "int" }], ["set_function_signature", { function: "main", signature: "int main(void)" }],
    ["set_comment", { address: "0x401000", text: "x" }], ["set_comment", { address: "0x401000", text: "", kind: "pre" }], ["define_data", { address: "0x402000", type: "int" }],
    ["create_function", { address: "0x403000", name: "f" }], ["create_function", { address: "0x403100" }], ["set_bookmark", { address: "0x401000", comment: "c" }],
    ["create_type", { kind: "struct", name: "S" }], ["create_type", { kind: "pointer", base: "int" }], ["edit_struct", { path: "/cat/S", op: { op: "delete", ordinal: 0 } }],
    ["edit_enum", { path: "/E", op: { op: "remove", name: "A" } }],
  ];
  for (const [name, args] of run) {
    await tool(name).handler(w.ctx, args);
    assert.equal(w.log.items.at(-1).undoName, w.stack.at(-1), `${name}: the change-log entry carries the step the provider named`);
  }
  while (w.log.items.some((c) => !c.undone)) await tool("undo_agent_edit").handler(w.ctx, {});
  assert.equal(w.undoCalls.length, run.length);
});

test("undo_agent_edit: a provider answer of Invalid means there is nothing left to undo; other failures are reported", async () => {
  const w = world();
  await tool("rename_symbol").handler(w.ctx, { target: "main", newName: "a" });
  w.ctx.ops.history.undo = async () => { throw new BackendError("busy", "analysis running"); };
  assert.match(await msg(tool("undo_agent_edit").handler(w.ctx, {})), /wait_for_analysis/);
});

test("schemas: unique names, edit access, annotations, closed objects, capabilities", () => {
  const names = editTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), ["create_function", "create_label", "create_type", "define_data", "edit_enum", "edit_struct", "rename_symbol", "rename_variable", "retype_variable", "set_bookmark", "set_comment", "set_function_signature", "undo_agent_edit"].sort());
  const all = TOOLS.map((t) => t.name);
  assert.equal(new Set(all).size, all.length, "unique across the whole table");
  for (const n of names) assert.ok(all.includes(n), `${n} is in TOOLS`);
  const check = (s, where) => {
    if (!s || typeof s !== "object") return;
    if (s.type === "object") assert.equal(s.additionalProperties, false, `${where} is a closed object`);
    for (const [k, v] of Object.entries(s.properties ?? {})) check(v, `${where}.${k}`);
    for (const r of s.required ?? []) assert.ok(r in s.properties, `${where} requires ${r}`);
  };
  for (const t of editTools) {
    assert.equal(t.access, "edit", t.name);
    assert.match(t.name, /^[a-z]+(_[a-z]+)*$/);
    assert.ok(t.capability, `${t.name} has a capability`);
    assert.equal(t.annotations.readOnlyHint, false, t.name);
    for (const k of ["destructiveHint", "idempotentHint"]) assert.equal(typeof t.annotations[k], "boolean", `${t.name}.${k}`);
    assert.ok(t.description.length > 20 && t.timeoutSecs > 0);
    check(t.inputSchema, t.name);
  }
  const hint = (n) => tool(n).annotations;
  for (const n of ["set_comment", "retype_variable", "set_function_signature", "define_data"]) assert.equal(hint(n).destructiveHint, true, n);
  for (const n of ["rename_symbol", "create_label", "create_function", "create_type"]) assert.equal(hint(n).destructiveHint, false, n);
  for (const n of ["rename_symbol", "set_comment", "rename_variable"]) assert.equal(hint(n).idempotentHint, true, n);
  assert.equal(tool("rename_variable").capability, "variableEditing");
  assert.equal(tool("undo_agent_edit").capability, "undo");
});

test("undo_agent_edit: two sessions of the same client (same name, different connection ids) cannot undo each other's edits", async () => {
  const w = world({ client: "Claude Code#1" });
  await tool("set_bookmark").handler(w.ctx, { address: "0x401000", comment: "x" });
  assert.equal(w.log.items.at(-1).by, "Claude Code#1");
  w.ctx.client = "Claude Code#2"; // the other session of the same client
  assert.match(await msg(tool("undo_agent_edit").handler(w.ctx, {})), /made by Claude Code#1/);
  assert.equal(w.undoCalls.length, 0);
  w.ctx.client = "Claude Code#1"; // the author can
  assert.match(await tool("undo_agent_edit").handler(w.ctx, {}), /Undid/);
});

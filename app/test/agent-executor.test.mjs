import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// One bundle, so ToolError / BackendError are the same classes in the executor and in the test.
const dir = new URL("../src/", import.meta.url).pathname;
const r = await build({
  stdin: { resolveDir: dir, contents: `export * from "./renderer/features/agent"; export * from "./agent/host"; export * from "./agent/types"; export * from "./agent/attribution"; export { BackendError } from "./renderer/backend"; export { createViews } from "./renderer/store/views"; export { ChangeLog } from "./renderer/changeLog";` },
  bundle: true, format: "esm", write: false, platform: "node",
});
globalThis.window = {};
const m = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
const { createAgentExecutor, createConfirmer, agentView, agentBadge, changeView, ToolError, BackendError, agentOf, ChangeLog, createViews } = m;

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const call = (tool, extra = {}) => ({ callId: "c" + Math.random(), tool, args: {}, client: "Claude Code", mode: "edit", timeoutSecs: 5, ...extra });
const ONE = { api: { who: "one" }, session: { sessionId: "s1" } };

function setup(tools, over = {}) {
  const replies = [], busy = [];
  let program = ONE;
  const d = {
    tools, backend: { b: 1 }, program: () => program, ui: { view: async () => ({ address: null }), goto: async () => {} }, confirm: async () => true,
    changes: { newest: () => null }, host: { agentReply: async (x) => { replies.push(x); } }, onBusy: (n) => busy.push(n), ...over,
  };
  return { ex: createAgentExecutor(d), replies, busy, set: (p) => { program = p; } };
}
const tool = (name, handler) => ({ name, handler });

test("a call runs the handler with the bound ctx and replies once", async () => {
  let ctx, args;
  const { ex, replies, busy } = setup([tool("t", async (c, a) => { ctx = c; args = a; return "hello"; })]);
  await ex.handle(call("t", { callId: "x", args: { n: 1 } }));
  assert.deepEqual(replies, [{ callId: "x", ok: true, content: "hello" }]);
  assert.equal(ctx.ops.who, "one"); assert.equal(ctx.session.sessionId, "s1"); assert.deepEqual(ctx.backend, { b: 1 });
  assert.equal(ctx.client, "Claude Code"); assert.equal(ctx.mode, "edit"); assert.deepEqual(args, { n: 1 });
  assert.ok(ctx.signal instanceof AbortSignal && !ctx.signal.aborted);
  assert.deepEqual(busy, [1, 0]);
});

test("no program: ops and session are null; tag attributes by identity", async () => {
  let ctx;
  const s = setup([tool("t", async (c) => { ctx = c; return ""; })]); s.set(null);
  await s.ex.handle(call("t", { client: "Codex" }));
  assert.equal(ctx.ops, null); assert.equal(ctx.session, null);
  const p = { a: 1 }, other = { a: 1 };
  assert.equal(ctx.tag(p), p);
  assert.equal(agentOf(p), "Codex"); assert.equal(agentOf(other), undefined);
});

test("failures reply ok:false with the toToolError text", async () => {
  const fail = (e) => tool("f", async () => { throw e; });
  for (const [e, re] of [
    [new BackendError("stale", "x"), /opened, replaced or closed the program/],
    [new BackendError("busy", "analysis running"), /Busy: analysis running.*wait_for_analysis/],
    [new ToolError("tell the agent"), /^tell the agent$/],
    [new Error("boom"), /^boom$/],
    ["str", /^str$/],
  ]) {
    const { ex, replies } = setup([fail(e)]);
    await ex.handle(call("f"));
    assert.equal(replies.length, 1); assert.equal(replies[0].ok, false); assert.match(replies[0].error, re);
  }
});

test("an unknown tool is an error reply", async () => {
  const { ex, replies } = setup([]);
  await ex.handle(call("nope"));
  assert.equal(replies[0].ok, false); assert.match(replies[0].error, /Unknown tool nope/);
});

test("cancel aborts only that call; the handler ends and there is one reply; unknown/finished ids are no-ops", async () => {
  const gate = deferred();
  const t = tool("wait", async (c) => { await new Promise((res) => c.signal.addEventListener("abort", res)); throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
  const { ex, replies } = setup([t, tool("slow", async () => { await gate.promise; return "done"; })]);
  const a = ex.handle(call("wait", { callId: "a" })), b = ex.handle(call("slow", { callId: "b" }));
  await tick();
  ex.cancel("nope");
  ex.cancel("a");
  await a;
  assert.deepEqual(replies, [{ callId: "a", ok: false, error: "Cancelled." }]);
  gate.resolve(); await b;
  assert.deepEqual(replies[1], { callId: "b", ok: true, content: "done" });
  ex.cancel("a"); ex.cancel("b"); await tick();
  assert.equal(replies.length, 2);
});

test("cancel racing completion still gives exactly one reply", async () => {
  const gate = deferred();
  const { ex, replies } = setup([tool("t", async () => { await gate.promise; return "x"; })]);
  const p = ex.handle(call("t", { callId: "r" }));
  await tick();
  gate.resolve(); ex.cancel("r"); ex.cancel("r");
  await p;
  assert.equal(replies.length, 1);
});

test("concurrent calls do not mix up", async () => {
  const gates = { a: deferred(), b: deferred() };
  const { ex, replies } = setup([tool("t", async (c) => { await gates[c.client].promise; return c.client; })]);
  const a = ex.handle(call("t", { callId: "1", client: "a" })), b = ex.handle(call("t", { callId: "2", client: "b" }));
  gates.b.resolve(); await b; gates.a.resolve(); await a;
  assert.deepEqual(replies, [{ callId: "2", ok: true, content: "b" }, { callId: "1", ok: true, content: "a" }]);
});

function fakeHost() {
  const log = [], h = { log, handlers: {} };
  h.onAgentCall = (cb) => { log.push("call"); h.handlers.call = cb; return () => { log.push("-call"); }; };
  h.onAgentCancel = (cb) => { log.push("cancel"); h.handlers.cancel = cb; return () => { log.push("-cancel"); }; };
  h.onAgentState = (cb) => { log.push("state"); h.handlers.state = cb; return () => { log.push("-state"); }; };
  h.agentReady = async (v) => { log.push("ready:" + v); };
  h.agentReply = async (x) => { log.push("reply:" + x.callId); };
  return h;
}

test("listen: ready after the listeners; dispose says not ready and aborts in-flight calls; messages route", async () => {
  const host = fakeHost(); let sig;
  const { ex } = setup([tool("w", async (c) => { sig = c.signal; await new Promise((res) => c.signal.addEventListener("abort", res)); return "late"; })], { host });
  const states = [];
  const off = ex.listen(host, (s) => states.push(s));
  assert.deepEqual(host.log, ["call", "cancel", "state", "ready:true"]);
  host.handlers.state({ mode: "read", clients: ["x"] }); assert.deepEqual(states, [{ mode: "read", clients: ["x"] }]);
  host.handlers.call(call("w", { callId: "w1" })); await tick();
  host.handlers.cancel({ callId: "w1" }); assert.ok(sig.aborted);
  await tick();
  host.handlers.call(call("w", { callId: "w2" })); await tick();
  off();
  assert.ok(sig.aborted); assert.deepEqual(host.log.slice(-4), ["-call", "-cancel", "-state", "ready:false"]);
  await tick(); assert.ok(host.log.includes("reply:w2"));
});

test("changes.newest skips undone, saved and locked entries and reports by", () => {
  const items = [{ label: "a", undone: false, saved: false, by: "Codex", undoName: "Rename x to a" }, { label: "b", undone: true, saved: false }, { label: "c", undone: false, saved: true }, { label: "d", undone: false, saved: false, locked: true }];
  assert.deepEqual(changeView(() => items).newest(), { label: "a", by: "Codex", undoName: "Rename x to a" });
  assert.equal(changeView(() => items.slice(1)).newest(), null);
  const log = new ChangeLog(); log.record("renameSymbol", { newName: "x", address: "0x1" }, {});
  assert.equal(changeView(() => log.items).newest().label, "Rename to x");
});

test("confirm: answers, queues, false on dismiss, abort and reset", async () => {
  const views = createViews(); let reset = () => {};
  const confirm = createConfirmer(views, (f) => { reset = f; return () => {}; });
  const shown = () => views.getState().agentAsk;
  const sig = () => new AbortController();

  const a = confirm("open foo?", { client: "C", signal: sig().signal }), b = confirm("second", { client: "C", signal: sig().signal });
  assert.equal(shown().message, "open foo?"); assert.equal(shown().client, "C");
  shown().answer(true); assert.equal(await a, true);
  assert.equal(shown().message, "second");
  shown().answer(false); assert.equal(await b, false); assert.equal(shown(), null);

  const ac = sig(), c = confirm("x", { client: "C", signal: ac.signal });
  ac.abort(); assert.equal(await c, false); assert.equal(shown(), null);
  assert.equal(await confirm("y", { client: "C", signal: AbortSignal.abort() }), false);

  const d1 = confirm("p", { client: "C", signal: sig().signal }), d2 = confirm("q", { client: "C", signal: sig().signal });
  reset(); assert.deepEqual([await d1, await d2], [false, false]); assert.equal(shown(), null);
});

test("ctx.ui.confirm goes through the confirmer with the call's client and signal", async () => {
  let seen;
  const { ex, replies } = setup([tool("t", async (c) => ((await c.ui.confirm("ok?")) ? "yes" : "no"))], { confirm: async (msg, o) => { seen = { msg, client: o.client, aborted: o.signal.aborted }; return false; } });
  await ex.handle(call("t", { client: "Codex" }));
  assert.deepEqual(seen, { msg: "ok?", client: "Codex", aborted: false }); assert.equal(replies[0].content, "no");
});

test("view: cursor, function, tab, listing row or token, selection; nulls when empty", () => {
  const views = createViews();
  const refs = { listingRow: { current: null }, editor: { current: null }, lastPane: { current: "listing" } };
  const decompiler = { v: null };
  const deps = { views, refs, decompiler: () => decompiler.v };
  assert.deepEqual(agentView(deps), { address: null, function: null, tab: null, under: null, selection: null });

  views.dispatch({ type: "set", patch: { cursorAt: "0x401000", fn: { name: "main", entry: "0x401000", size: 4, signature: "" } } });
  refs.listingRow.current = () => ({ address: "0x401000", label: "main", mnemonic: "push", operands: "rbp" });
  assert.deepEqual(agentView(deps), { address: "0x401000", function: { name: "main", entry: "0x401000" }, tab: null, under: "0x401000 main push rbp", selection: null });

  decompiler.v = { entry: "0x401000", text: "int main(void)\n{ return foo; }", tokens: [{ line: 1, colStart: 2, colEnd: 8, kind: "keyword" }, { line: 1, colStart: 9, colEnd: 12, kind: "variable" }] };
  refs.lastPane.current = "decompiler";
  refs.editor.current = { getPosition: () => ({ lineNumber: 2, column: 11 }), getSelection: () => ({ isEmpty: () => false }), getModel: () => ({ getValueInRange: () => "return foo" }) };
  assert.deepEqual(agentView(deps), { address: "0x401000", function: { name: "main", entry: "0x401000" }, tab: "0x401000", under: "foo", selection: "return foo" });
});

test("status badge", () => {
  assert.equal(agentBadge({ mode: "read", clients: [] }, 0), null);
  assert.equal(agentBadge({ mode: "off", clients: [] }, 3), null);
  assert.deepEqual(agentBadge({ mode: "read", clients: ["Claude Code"] }, 0), { label: "Agent: Claude Code", pulsing: false });
  assert.deepEqual(agentBadge({ mode: "edit", clients: ["A", "B"] }, 2), { label: "Agent: A, B", pulsing: true });
});

test("edit tools run one at a time (a guard that reads the change log must not interleave with another edit); reads stay parallel; a queued call aborted before its turn never runs", async () => {
  const order = [], gate = deferred(); let ran = false;
  const w = (name, wait) => ({ name, access: "edit", handler: async () => { order.push("start " + name); await wait; order.push("end " + name); return name; } });
  const { ex, replies } = setup([w("e1", gate.promise), w("e2", Promise.resolve()), { name: "r", access: "read", handler: async () => { order.push("read"); return "r"; } }, { name: "e3", access: "edit", handler: async () => { ran = true; return "no"; } }]);
  const a = ex.handle(call("e1", { callId: "1" })), b = ex.handle(call("e2", { callId: "2" })), c3 = ex.handle(call("e3", { callId: "3" })), r = ex.handle(call("r", { callId: "4" }));
  await tick(); await r;
  assert.deepEqual([...order].sort(), ["read", "start e1"]); // e2 waits for e1; the read does not
  ex.cancel("3");
  gate.resolve(); await Promise.all([a, b, c3]);
  assert.deepEqual(order.filter((x) => x !== "read"), ["start e1", "end e1", "start e2", "end e2"]);
  assert.equal(ran, false);
  assert.deepEqual(replies.find((x) => x.callId === "3"), { callId: "3", ok: false, error: "Cancelled." });
});

test("ctx.functions: served from the app's list (two calls, no backend fetch); the provider is asked when the list is not trustworthy; no program is an instruction", async () => {
  const fetched = []; const mkApi = () => ({ functions: { list: async () => { fetched.push(1); return [{ name: "fresh", entry: "0x1", size: 1 }]; } } });
  const mine = [{ name: "cached", entry: "0x1", size: 1 }];
  let trusted = mine; const got = [];
  const read = tool("t", async (c) => { got.push((await c.functions())[0].name); return "ok"; });
  const program0 = { api: mkApi(), session: { sessionId: "s1" } };
  const s = setup([read], { functions: () => trusted }); s.set(program0);
  await s.ex.handle(call("t")); await s.ex.handle(call("t"));
  assert.deepEqual(got, ["cached", "cached"]); assert.equal(fetched.length, 0);
  trusted = null; // loading, or behind a change
  await s.ex.handle(call("t"));
  assert.deepEqual(got, ["cached", "cached", "fresh"]); assert.equal(fetched.length, 1);
  s.set(null);
  await s.ex.handle(call("t"));
  assert.match(s.replies.at(-1).error, /No program is open/);
});

test("trackFunctions: trusted once loaded; a symbol/function/broad change makes it stale until the refetch lands a new array; other kinds do not", () => {
  let st = { program: {}, map: {}, reading: false, funcs: [{ name: "a" }] }; let fire;
  const t = m.trackFunctions({ store: { getState: () => st }, onChanged: (f) => { fire = f; return () => { fire = null; }; } });
  assert.equal(t.list(), st.funcs);
  fire({ ranges: [], kinds: ["comment"] }); assert.equal(t.list(), st.funcs); // a comment changes no function
  fire({ ranges: [{}], kinds: ["symbol"] }); assert.equal(t.list(), null); // behind
  st = { ...st, funcs: [{ name: "b" }] }; assert.equal(t.list(), st.funcs); // the refetch landed
  fire({ ranges: null, kinds: ["comment"] }); assert.equal(t.list(), null); // a broad change
  st = { ...st, funcs: [{ name: "c" }] }; assert.equal(t.list(), st.funcs);
  fire({ ranges: [], kinds: [] }); assert.equal(t.list(), null);
  st = { ...st, funcs: [{ name: "d" }], reading: true }; assert.equal(t.list(), null); // still reading the program
  st = { ...st, reading: false, map: null }; assert.equal(t.list(), null);
  t.dispose(); assert.equal(fire, null);
});

test("a queued edit does not run against a program opened while it waited", async () => {
  const gate = deferred(); let ran = [];
  const w = (name, wait) => ({ name, access: "edit", handler: async (c) => { await wait; ran.push([name, c.session.sessionId]); return name; } });
  const { ex, replies, set } = setup([w("first", gate.promise), w("second", Promise.resolve())]);
  const a = ex.handle(call("first", { callId: "1" })), b = ex.handle(call("second", { callId: "2" })); // both made against program 1
  await tick();
  set({ api: { who: "two" }, session: { sessionId: "s2" } }); // the user opens another program while the first edit runs
  gate.resolve(); await Promise.all([a, b]);
  assert.deepEqual(ran, [["first", "s1"]]); // the second never ran, least of all against s2
  assert.match(replies.find((x) => x.callId === "2").error, /opened, replaced or closed the program/);
  set(null); // closed meanwhile: also refused
  const c = ex.handle(call("first", { callId: "3" })); set(ONE); await c;
  assert.match(replies.find((x) => x.callId === "3").error, /nothing was done/);
});

test("onCall sees the tool, args and client before the handler runs; a throwing observer does not fail the call", async () => {
  const seen = [];
  const { ex, replies } = setup([tool("t", async () => { seen.push("handler"); return "ok"; })], { onCall: (t, a, c) => { seen.push([t, a, c]); throw new Error("observer"); } });
  await ex.handle(call("t", { args: { n: 2 }, client: "Codex#3" }));
  assert.deepEqual(seen, [["t", { n: 2 }, "Codex#3"], "handler"]);
  assert.equal(replies[0].ok, true);
});

test("headless: without ui and confirm the tools get no ctx.ui", async () => {
  let ctx;
  const { ex, replies } = setup([tool("t", async (c) => { ctx = c; return "ok"; })], { ui: undefined, confirm: undefined });
  await ex.handle(call("t"));
  assert.equal(ctx.ui, undefined); assert.equal(replies[0].ok, true);
});

test("an unqueued full tool runs while another edit tool is still running (debug_pause during a waiting debug_continue)", async () => {
  const gate = deferred(), seen = [];
  const { ex } = setup([
    { name: "w", access: "full", handler: async () => { await gate.promise; return "w"; } },
    { name: "u", access: "full", unqueued: true, handler: async () => { seen.push("u"); return "u"; } },
    { name: "q", access: "edit", handler: async () => { seen.push("q"); return "q"; } },
  ]);
  const w = ex.handle(call("w")); const u = ex.handle(call("u")); const q = ex.handle(call("q"));
  await tick(); await u;
  assert.deepEqual(seen, ["u"]); // q waits behind w, u does not
  gate.resolve(); await w; await q;
  assert.deepEqual(seen, ["u", "q"]);
});

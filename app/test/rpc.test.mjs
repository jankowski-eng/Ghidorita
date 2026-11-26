import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

class FakeWS {
  static OPEN = 1;
  static active;
  readyState = 1;
  sent = [];
  constructor() { FakeWS.active = this; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.(); }
  reply(request, result) { this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) }); }
  notify(method, params) { this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) }); }
}
globalThis.WebSocket = FakeWS;
const r = await build({ entryPoints: [new URL("../src/renderer/rpc.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const { WebSocketBackend } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));

async function setup(capabilities = []) {
  const edits = [];
  const backend = new WebSocketBackend({ onEdit: (...args) => edits.push(args) });
  const connection = backend.connect(1234, "test");
  const ws = FakeWS.active;
  ws.onopen();
  await Promise.resolve();
  assert.equal(ws.sent.at(-1).method, "provider_info");
  ws.reply(ws.sent.at(-1), { version: 1, provider: "test", capabilities });
  await connection;
  return { backend, ws, edits };
}

async function open(backend, ws, sessionId) {
  const job = backend.lifecycle.open(sessionId, {}, () => {});
  ws.reply(ws.sent.at(-1), { sessionId, programId: "stable", name: sessionId, persisted: false });
  return job.result;
}

test("a call on a closed socket rejects instead of hanging", async () => {
  const { backend, ws } = await setup();
  ws.close();
  await assert.rejects(backend.lifecycle.active(), { kind: "connection" });
  assert.equal(ws.sent.length, 1);
});

test("late undo replies and change events from A cannot alter B", async () => {
  const { backend, ws, edits } = await setup(["undo"]);
  const a = backend.program(await open(backend, ws, "A"));
  const oldResult = a.history.undo();
  const oldRequest = ws.sent.at(-1);
  assert.equal(oldRequest.sessionId, "A");
  const rejected = assert.rejects(oldResult, { kind: "stale" });
  const events = [];
  backend.events.onChange((id, p) => events.push([id, p.undo.dirty]));
  const b = backend.program(await open(backend, ws, "B"));
  const undo = { dirty: true, canUndo: true, canRedo: false };
  ws.reply(oldRequest, undo);
  ws.notify("program_changed", { sessionId: "A", ranges: null, kinds: ["code"], undo });
  ws.notify("program_changed", { sessionId: "B", ranges: null, kinds: [], undo: { ...undo, dirty: false } });
  ws.notify("program_changed", { sessionId: "B", ranges: 7, kinds: [], undo });
  await rejected;
  const sent = ws.sent.length;
  await assert.rejects(a.history.redo(), { kind: "stale" });
  assert.equal(ws.sent.length, sent);
  assert.deepEqual(events, [["B", false]]);
  assert.deepEqual(edits, []);
  const current = b.history.undo();
  ws.reply(ws.sent.at(-1), undo);
  await current;
  assert.equal(edits[0][0], "undo");
});

test("discovery and listing validate replies before publishing data", async () => {
  const { backend, ws } = await setup();
  const program = backend.program(await open(backend, ws, "A"));
  const page = program.listing.rows({ address: "0x1", count: 2 });
  ws.reply(ws.sent.at(-1), [{ address: 100, length: 1, bytes: "00", mnemonic: "db", operands: "" }]);
  await assert.rejects(page, { kind: "protocol" });
  const validPage = program.listing.rows({ address: "0x1", count: 1 });
  const row = { address: "0x1", length: 1, bytes: "00", mnemonic: "db", operands: "",
    xrefs: { count: 1, items: [{ from: "Entry Point:0", kind: "data" }] } };
  ws.reply(ws.sent.at(-1), [row]);
  assert.deepEqual(await validPage, [row]);
  await assert.rejects(program.decompiler.decompile({ entry: "0x1" }).result, { kind: "unsupported" });
  assert.equal(ws.sent.at(-1).method, "listing_rows");
});

test("debug: calls need the capability, the state notification reaches the active session only", async () => {
  const { backend, ws } = await setup(["debugger"]);
  const a = backend.program(await open(backend, ws, "A"));
  const seen = [];
  backend.events.onDebug((id, st) => seen.push([id, st.state, st.stop]));
  const attach = a.debug.attach({ host: "localhost", port: 1234 });
  assert.deepEqual([ws.sent.at(-1).method, ws.sent.at(-1).params, ws.sent.at(-1).sessionId], ["debug_attach", { host: "localhost", port: 1234 }, "A"]);
  ws.reply(ws.sent.at(-1), {});
  await attach;
  const state = { state: "stopped", target: "localhost:1234", stop: 1, offset: "0x0", breakpoints: ["0x8"], address: "0x28", registers: [{ name: "pc", value: "0x00000028" }] };
  ws.notify("debug_state", { sessionId: "A", ...state });
  ws.notify("debug_state", { sessionId: "B", ...state });
  ws.notify("debug_state", { sessionId: "A", ...state, state: "flying" }); // not a state: dropped
  assert.deepEqual(seen, [["A", "stopped", 1]]);
  const bare = await setup([]); // a provider without the capability
  await assert.rejects(bare.backend.program(await open(bare.backend, bare.ws, "X")).debug.step(), { kind: "unsupported" });
});

test("projects.reopen opens by programId, never by path; without the projects capability it is refused", async () => {
  const entry = { programId: "pid", name: "n", sourcePath: "/gone/n", sizeBytes: 1, analyzed: true, options: { loader: "L" } };
  const { backend, ws } = await setup(["projects"]);
  const job = backend.projects.reopen(entry, () => {});
  assert.deepEqual({ ...ws.sent.at(-1), id: 0 }, { jsonrpc: "2.0", id: 0, method: "open_program", params: { programId: "pid" } });
  ws.reply(ws.sent.at(-1), { sessionId: "S", programId: "pid", name: "n", persisted: true });
  assert.equal((await job.result).sessionId, "S");
  const bare = await setup([]);
  await assert.rejects(bare.backend.projects.reopen(entry, () => {}).result, { kind: "unsupported" });
  assert.equal(bare.ws.sent.length, 1);
});

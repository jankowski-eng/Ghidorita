import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import WebSocket from "ws";

// The mock sidecar must speak the data type protocol (protocol.md "Data types") so the UI autotest can run without Ghidra.
const proc = spawn(process.execPath, [new URL("../mock/server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
const port = await new Promise((res) => proc.stdout.once("data", (d) => res(+String(d).trim())));
const ws = new WebSocket(`ws://127.0.0.1:${port}/x`);
await new Promise((r) => ws.once("open", r));
const notes = []; const waiters = new Map(); let nid = 0;
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id === undefined) notes.push(m); else waiters.get(m.id)(m); });
const call = (method, params = {}) => new Promise((res) => { const id = ++nid; waiters.set(id, res); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
const ok = async (m, p) => { const r = await call(m, p); assert.ok("result" in r, JSON.stringify([m, p, r])); return r.result; };
const err = async (m, p, code = -32602) => { const r = await call(m, p); assert.equal(r.error?.code, code, JSON.stringify([m, p, r])); };
test.after(() => { ws.close(); proc.kill(); });

test("mock data types: struct editor, apply, undo/redo, enum, categories", async () => {
  await ok("open_binary", { path: "/x/prog", analysis: "blocking" });
  assert.deepEqual((await ok("dt_sources")).map((s) => s.id), ["program", "builtin"]);
  assert.deepEqual(await ok("create_data_type", { kind: "struct", name: "S1" }), { path: "/S1" });
  await err("create_data_type", { kind: "struct", name: "S1" });
  for (const [t, n] of [["dword", "a"], ["char[8]", "nm"], ["S1 *", "next"]]) await ok("edit_struct", { path: "/S1", op: { op: "add", type: t, name: n } });
  let d = await ok("get_data_type", { path: "/S1" });
  assert.deepEqual(d.components.map((c) => [c.offset, c.length, c.type, c.name]), [[0, 4, "dword", "a"], [4, 8, "char[8]", "nm"], [12, 8, "S1 *", "next"]]);
  assert.equal(d.size, 20);
  await err("edit_struct", { path: "/S1", op: { op: "add", type: "S1" } });          // cycle
  await err("edit_struct", { path: "/S1", op: { op: "add", type: "string" } });      // dynamic
  await err("edit_struct", { path: "/S1", op: { op: "move", ordinal: 0, to: 1 } });  // unpacked
  assert.equal((await ok("undo_state")).undoName, "Edit S1: add"); // failures leave no undo step
  await ok("edit_struct", { path: "/S1", op: { op: "resize", size: 24 } });
  d = await ok("get_data_type", { path: "/S1" });
  assert.deepEqual(d.components.filter((c) => c.undefined).map((c) => c.offset), [20, 21, 22, 23]);
  await ok("edit_struct", { path: "/S1", op: { op: "set", ordinal: 3, type: "dword", name: "tail" } });
  assert.equal((await ok("get_data_type", { path: "/S1" })).components[3].length, 4);
  await ok("edit_struct", { path: "/S1", op: { op: "clear", ordinal: 0 } });
  d = await ok("get_data_type", { path: "/S1" });
  assert.equal(d.size, 24); assert.ok(d.components[0].undefined);
  // apply to the listing, edit while applied, undo/redo
  await ok("define_data", { address: "0x401100", dataType: "/S1" });
  assert.equal((await ok("listing_rows", { address: "0x401100", count: 1 }))[0].mnemonic, "S1");
  assert.equal((await ok("listing_rows", { address: "0x401100", count: 1 }))[0].length, 24);
  await ok("edit_struct", { path: "/S1", op: { op: "delete", ordinal: 0 } });
  const kinds = notes.filter((n) => n.method === "program_changed").at(-1).params;
  assert.ok(kinds.kinds.includes("type") && kinds.ranges === null);
  assert.equal((await ok("listing_rows", { address: "0x401100", count: 1 }))[0].length, 23);
  await ok("undo");
  assert.equal((await ok("get_data_type", { path: "/S1" })).size, 24);
  await ok("redo");
  assert.equal((await ok("get_data_type", { path: "/S1" })).size, 23);
  // decompile cache: whole cache cleared by a type change
  await ok("decompile", { entry: "0x401000" }); assert.equal((await ok("decompile", { entry: "0x401000" })).cached, true);
  await ok("edit_struct", { path: "/S1", op: { op: "add", type: "byte" } });
  assert.equal((await ok("decompile", { entry: "0x401000" })).cached, false);
  // pack / move / union
  await err("edit_struct", { path: "/S1", op: { op: "move", ordinal: 0, to: 1 } });
  await ok("edit_struct", { path: "/S1", op: { op: "pack", packed: true } });
  const before = (await ok("get_data_type", { path: "/S1" })).components.map((c) => c.name);
  await ok("edit_struct", { path: "/S1", op: { op: "move", ordinal: 0, to: 2 } });
  const after = (await ok("get_data_type", { path: "/S1" })).components.map((c) => c.name);
  assert.deepEqual(after, [before[1], before[2], before[0], ...before.slice(3)]);
  await ok("create_data_type", { kind: "union", name: "U1" });
  await ok("edit_struct", { path: "/U1", op: { op: "add", type: "qword", name: "q" } });
  await ok("edit_struct", { path: "/U1", op: { op: "add", type: "dword", name: "i" } });
  assert.equal((await ok("get_data_type", { path: "/U1" })).size, 8);
  // enum, typedef, pointer, categories, rename, delete
  await ok("create_data_type", { kind: "enum", name: "E1", size: 2 });
  await ok("edit_enum", { path: "/E1", op: { op: "set", name: "A", value: "0x10" } });
  await ok("edit_enum", { path: "/E1", op: { op: "set", name: "B", value: "-1" } });
  await ok("edit_enum", { path: "/E1", op: { op: "set", oldName: "A", name: "A2", value: "3" } });
  assert.deepEqual((await ok("get_data_type", { path: "/E1" })).values, [{ name: "B", value: "-1" }, { name: "A2", value: "3" }]);
  await err("edit_enum", { path: "/E1", op: { op: "set", name: "Z", value: "nope" } });
  await err("edit_enum", { path: "/E1", op: { op: "remove", name: "none" } }, -32004);
  assert.deepEqual(await ok("create_data_type", { kind: "typedef", name: "mytype_t", base: "S1 *" }), { path: "/mytype_t" });
  assert.equal((await ok("create_data_type", { kind: "pointer", base: "E1" })).path, "/E1 *");
  await ok("create_data_type", { kind: "category", name: "Mine" });
  assert.equal((await ok("create_data_type", { kind: "struct", name: "In", category: "/Mine" })).path, "/Mine/In");
  assert.deepEqual((await ok("dt_children", { path: "/Mine" })).types.map((t) => t.path), ["/Mine/In"]);
  await err("delete_data_type", { path: "/Mine", category: true });
  assert.deepEqual(await ok("rename_data_type", { path: "/Mine/In", newName: "Out" }), { path: "/Mine/Out" });
  await ok("delete_data_type", { path: "/Mine/Out" });
  await ok("delete_data_type", { path: "/Mine", category: true });
  await err("dt_children", { path: "/Mine" }, -32004);
  const hits = await ok("list_data_types", { query: "s1", limit: 10 });
  assert.ok(hits.some((h) => h.path === "/S1" && h.kind === "struct"));
  // auto create structure from a decompiler variable
  await err("auto_create_structure", { entry: "0x401000", name: "nope" }, -32004);
  assert.deepEqual(await ok("auto_create_structure", { entry: "0x401000", name: "param_1", structName: "AutoS" }), { path: "/auto_structs/AutoS" });
  assert.ok((await ok("decompile", { entry: "0x401000" })).text.includes("AutoS *"));
  assert.equal((await ok("undo_state")).undoName, "Auto create structure in entry");
  // from data: instructions refused, defined items become fields
  await err("create_struct_from_data", { address: "0x401200", length: 4, name: "X" });
  await ok("define_data", { address: "0x401200", dataType: "int" }); await ok("define_data", { address: "0x401204", dataType: "short" });
  assert.deepEqual(await ok("create_struct_from_data", { address: "0x401200", length: 6, name: "FromData" }), { path: "/FromData" });
  assert.deepEqual((await ok("get_data_type", { path: "/FromData" })).components.map((c) => [c.offset, c.type]), [[0, "int"], [4, "short"]]);
  assert.equal((await ok("listing_rows", { address: "0x401200", count: 1 }))[0].mnemonic, "FromData");
  await ok("undo");
  await err("get_data_type", { path: "/FromData" }, -32004);
});

test("mock open_program opens the requested catalog entry, seeded or not", async () => {
  const seeded = (await ok("list_programs")).find((e) => e.programId !== "mock:/x/prog" && e.sourcePath);
  assert.ok(seeded, "the mock seeds catalog entries");
  const r = await ok("open_program", { programId: seeded.programId });
  assert.equal(r.programId, seeded.programId);
  assert.equal(r.persisted, true);
  await err("open_program", { programId: "nope" }, -32004);
});

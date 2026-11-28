import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport as LineTransport } from "@modelcontextprotocol/sdk/server/stdio.js"; // newline-JSON over any streams: also fine as the client side
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

// Main's MCP server (src/main/agent.ts) in plain Node: real SDK Client over a real unix socket, a stub renderer (the `send` callback + reply()/setReady()), fake tool tables.
const out = fs.mkdtempSync("/tmp/ghb"); // a real file: the SDK's CJS deps need import.meta.url for require
process.on("exit", () => fs.rmSync(out, { recursive: true, force: true }));
let n = 0;
const bundle = async (entry, extra = {}) => {
  const file = path.join(out, `b${n++}.mjs`);
  fs.writeFileSync(file, (await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, ...extra })).outputFiles[0].text);
  return import(file);
};
const { createAgent, visibleTools, loadMode, setupText, cleanName, REPLY_MAX, ERROR_MAX } = await bundle("../src/main/agent.ts");
const { INSTRUCTIONS } = await bundle("../src/agent/instructions.ts");
const electron = new URL("./stub-electron.mjs", import.meta.url).pathname;
const { createMenu } = await bundle("../src/main/menu.ts", { alias: { electron } });

const schema = { type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false };
const ann = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const tool = (name, access, extra = {}) => ({ name, description: name, inputSchema: schema, annotations: ann, access, timeoutSecs: 5, handler: async () => "never run in main", ...extra });
const TABLE = [tool("status", "off", { inputSchema: { type: "object", properties: {}, additionalProperties: false } }), tool("rd", "read"), tool("ed", "edit"), tool("ui", "read", { appOnly: true }), tool("slow", "read", { timeoutSecs: 0.05 }), tool("cap", "read", { capability: "bookmarks" })];

const tmp = () => fs.mkdtempSync("/tmp/gh");
const until = async (f, ms = 3000) => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + f); await new Promise((r) => setTimeout(r, 5)); } };
const names = (r) => r.tools.map((t) => t.name).sort();

async function rig(o = {}) {
  const dir = tmp(), sent = [], logs = [];
  const sock = o.sock ?? path.join(dir, "s");
  const settingsFile = path.join(dir, "agent.json");
  const agent = createAgent({ send: (ch, p) => sent.push({ ch, p }), settingsFile, socket: { path: sock, ownDir: null }, table: TABLE, marginMs: 20, env: {}, log: (m) => logs.push(m), ...o.opts });
  if (o.mode) agent.setMode(o.mode);
  await agent.start();
  if (o.ready !== false) agent.setReady(true);
  const clients = [];
  const connect = async (name = "claude-code") => {
    const s = net.connect(sock);
    await new Promise((r, j) => { s.once("connect", r); s.once("error", j); });
    const c = new Client({ name, version: "1" });
    c.changes = 0;
    c.setNotificationHandler(ToolListChangedNotificationSchema, () => { c.changes++; });
    await c.connect(new LineTransport(s, s));
    c.sock = s; clients.push(c);
    return c;
  };
  const calls = () => sent.filter((m) => m.ch === "agent-call").map((m) => m.p);
  const cancels = () => sent.filter((m) => m.ch === "agent-cancel").map((m) => m.p.callId);
  const close = async () => { for (const c of clients) { c.sock.destroy(); await c.close().catch(() => {}); } await agent.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { agent, sent, logs, dir, sock, settingsFile, connect, calls, cancels, close };
}

test("initialize returns the instructions; tools/list follows the mode and list_changed follows a change", async () => {
  const r = await rig();
  const c = await r.connect();
  assert.equal(c.getInstructions(), INSTRUCTIONS);
  assert.deepEqual(names(await c.listTools()), ["status"]); // off
  r.agent.setMode("read");
  await until(() => c.changes === 1);
  const read = await c.listTools();
  assert.deepEqual(names(read), ["rd", "slow", "status", "ui", "cap"].sort()); // no edit tools
  assert.deepEqual(Object.keys(read.tools[0]).sort(), ["annotations", "description", "inputSchema", "name"]);
  r.agent.setMode("edit");
  await until(() => c.changes === 2);
  assert.ok(names(await c.listTools()).includes("ed"));
  assert.deepEqual(r.sent.filter((m) => m.ch === "agent-state").map((m) => m.p.mode).filter((x, i, l) => x !== l[i - 1]), ["off", "read", "edit"]); // off: sent when the client initialised
  await r.close();
});

test("visibleTools: mode, headless app-only flag and the optional capability set", () => {
  const n = (m, o) => visibleTools(m, o, TABLE).map((t) => t.name);
  assert.deepEqual(n("off"), ["status"]);
  assert.deepEqual(n("read", { headless: true }), ["status", "rd", "slow", "cap"]);
  assert.deepEqual(n("full"), TABLE.map((t) => t.name));
  assert.deepEqual(n("read", { capabilities: new Set() }), ["status", "rd", "ui", "slow"]);
  assert.deepEqual(n("read", { capabilities: new Set(["bookmarks"]) }), ["status", "rd", "ui", "slow", "cap"]);
});

test("off: status is answered by main and nothing reaches the renderer", async () => {
  const r = await rig();
  const c = await r.connect();
  const s = await c.callTool({ name: "status", arguments: {} });
  assert.match(s.content[0].text, /Agent > Access/);
  const x = await c.callTool({ name: "rd", arguments: { x: "1" } });
  assert.equal(x.isError, true);
  assert.deepEqual(r.calls(), []);
  await r.close();
});

test("a call outside the mode is refused without reaching the renderer, even with the stale list", async () => {
  const r = await rig({ mode: "edit" });
  const c = await r.connect();
  assert.ok(names(await c.listTools()).includes("ed")); // the client has the edit list
  r.agent.setMode("read");
  const x = await c.callTool({ name: "ed", arguments: { x: "1" } });
  assert.equal(x.isError, true);
  assert.match(x.content[0].text, /Agent access is read.*edit mode.*Agent menu/);
  assert.equal((await c.callTool({ name: "nope", arguments: {} })).isError, true);
  assert.deepEqual(r.calls(), []);
  await r.close();
});

test("headless refuses app-only tools; a missing capability refuses too", async () => {
  const r = await rig({ mode: "read", opts: { headless: true } });
  const c = await r.connect();
  assert.match((await c.callTool({ name: "ui", arguments: { x: "1" } })).content[0].text, /headless/);
  const r2 = await rig({ mode: "read", opts: { capabilities: () => new Set() } });
  const c2 = await r2.connect();
  assert.equal((await c2.callTool({ name: "cap", arguments: { x: "1" } })).isError, true);
  assert.deepEqual([...r.calls(), ...r2.calls()], []);
  await r.close(); await r2.close();
});

test("a call is forwarded as an AgentCall and the reply comes back; ok:false is an error result", async () => {
  const r = await rig({ mode: "read" });
  const c = await r.connect("My Agent\u0007 " + "x".repeat(100));
  const p = c.callTool({ name: "rd", arguments: { x: "hi" } });
  const call = (await until(() => r.calls()[0]));
  assert.equal(call.tool, "rd"); assert.deepEqual(call.args, { x: "hi" }); assert.equal(call.mode, "read"); assert.equal(call.timeoutSecs, 5);
  assert.equal(call.client.length, 60); assert.ok(call.client.startsWith("My Agent x"));
  assert.equal(typeof call.callId, "string");
  r.agent.reply({ callId: call.callId, ok: true, content: "hello" });
  const res = await p;
  assert.deepEqual(res.content, [{ type: "text", text: "hello" }]); assert.equal(res.isError, undefined);
  const q = c.callTool({ name: "rd", arguments: { x: "hi" } });
  const c2 = await until(() => r.calls()[1]);
  assert.notEqual(c2.callId, call.callId);
  r.agent.reply({ callId: c2.callId, ok: false, error: "boom" });
  const bad = await q;
  assert.equal(bad.isError, true); assert.equal(bad.content[0].text, "boom");
  assert.equal(r.agent.pendingCount(), 0);
  await r.close();
});

test("invalid arguments are refused before the renderer and name the field", async () => {
  const r = await rig({ mode: "read" });
  const c = await r.connect();
  for (const args of [{}, { x: 5 }, { x: "1", extra: true }]) {
    const x = await c.callTool({ name: "rd", arguments: args });
    assert.equal(x.isError, true, JSON.stringify(args));
    assert.match(x.content[0].text, /Invalid arguments for rd/);
  }
  assert.match((await c.callTool({ name: "rd", arguments: {} })).content[0].text, /x/);
  assert.deepEqual(r.calls(), []);
  await r.close();
});

test("replies: forged, late, duplicate and malformed are dropped; oversized ones are truncated", async () => {
  const r = await rig({ mode: "read" });
  const c = await r.connect();
  const p = c.callTool({ name: "rd", arguments: { x: "1" } });
  const { callId } = await until(() => r.calls()[0]);
  for (const bad of [null, "x", {}, { callId: 1, ok: true, content: "a" }, { callId: "nope", ok: true, content: "a" }, { callId, ok: "yes", content: "a" }, { callId, ok: true, content: 5 }, { callId, ok: false, error: {} }])
    r.agent.reply(bad);
  assert.equal(r.agent.pendingCount(), 1);
  r.agent.reply({ callId, ok: true, content: "y".repeat(REPLY_MAX + 5000) });
  r.agent.reply({ callId, ok: true, content: "second" }); // duplicate
  assert.equal((await p).content[0].text.length, REPLY_MAX);
  const q = c.callTool({ name: "rd", arguments: { x: "1" } });
  const id2 = (await until(() => r.calls()[1])).callId;
  r.agent.reply({ callId: id2, ok: false, error: "e".repeat(ERROR_MAX + 10) });
  assert.equal((await q).content[0].text.length, ERROR_MAX);
  await r.close();
});

test("cancel from the client sends agent-cancel once; a late reply is dropped; a cancel after the reply is a no-op", async () => {
  const r = await rig({ mode: "read" });
  const c = await r.connect();
  const ac = new AbortController();
  const p = c.callTool({ name: "rd", arguments: { x: "1" } }, undefined, { signal: ac.signal });
  p.catch(() => {});
  const { callId } = await until(() => r.calls()[0]);
  ac.abort();
  await assert.rejects(p);
  await until(() => r.cancels().length === 1);
  assert.deepEqual(r.cancels(), [callId]);
  r.agent.reply({ callId, ok: true, content: "late" });
  assert.equal(r.agent.pendingCount(), 0);
  // reply first, cancel after: nothing more is sent
  const ac2 = new AbortController();
  const q = c.callTool({ name: "rd", arguments: { x: "1" } }, undefined, { signal: ac2.signal });
  const id2 = (await until(() => r.calls()[1])).callId;
  r.agent.reply({ callId: id2, ok: true, content: "done" });
  await q; ac2.abort();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(r.cancels(), [callId]);
  await r.close();
});

test("a call times out after the tool's limit plus the margin: agent-cancel and an error", async () => {
  const r = await rig({ mode: "read" });
  const c = await r.connect();
  const res = await c.callTool({ name: "slow", arguments: { x: "1" } });
  assert.equal(res.isError, true); assert.match(res.content[0].text, /timed out/);
  assert.deepEqual(r.cancels(), [r.calls()[0].callId]);
  assert.equal(r.agent.pendingCount(), 0);
  r.agent.reply({ callId: r.calls()[0].callId, ok: true, content: "late" }); // dropped
  await r.close();
});

test("window not ready: before agent-ready, and every pending call fails when the window reloads", async () => {
  const r = await rig({ mode: "read", ready: false });
  const c = await r.connect();
  const x = await c.callTool({ name: "rd", arguments: { x: "1" } });
  assert.equal(x.isError, true); assert.match(x.content[0].text, /window is not ready/);
  assert.deepEqual(r.calls(), []);
  r.agent.setReady(true);
  assert.deepEqual(r.sent.at(-1), { ch: "agent-state", p: { mode: "read", clients: ["claude-code"] } });
  const p = c.callTool({ name: "rd", arguments: { x: "1" } });
  const { callId } = await until(() => r.calls()[0]);
  r.agent.setReady(false); // did-start-loading
  const res = await p;
  assert.match(res.content[0].text, /window reloaded/); assert.equal(res.isError, true);
  assert.deepEqual(r.cancels(), [callId]);
  assert.match((await c.callTool({ name: "rd", arguments: { x: "1" } })).content[0].text, /not ready/);
  await r.close();
});

test("two simultaneous clients: both listed, calls independent, closing one cancels only its calls", async () => {
  const r = await rig({ mode: "read" });
  const a = await r.connect("alpha"), b = await r.connect("beta");
  await until(() => r.agent.clients().length === 2);
  assert.deepEqual(r.agent.clients().sort(), ["alpha", "beta"]);
  const pa = a.callTool({ name: "rd", arguments: { x: "a" } }), pb = b.callTool({ name: "rd", arguments: { x: "b" } });
  pa.catch(() => {});
  const [ca, cb] = await until(() => r.calls().length === 2 && r.calls());
  assert.equal(ca.client, "alpha"); assert.equal(cb.client, "beta");
  r.agent.reply({ callId: cb.callId, ok: true, content: "B" });
  assert.equal((await pb).content[0].text, "B");
  a.sock.destroy();
  await until(() => r.cancels().includes(ca.callId));
  await until(() => r.agent.clients().length === 1);
  assert.deepEqual(r.agent.clients(), ["beta"]);
  assert.equal(r.agent.pendingCount(), 0);
  assert.deepEqual(r.sent.at(-1).p.clients, ["beta"]);
  await r.close();
});

test("socket: 0600 file in a 0700 dir; stop removes it", { skip: process.platform === "win32" }, async () => {
  const dir = tmp(), own = path.join(dir, "own"), sock = path.join(own, "s");
  const r = await rig({ sock, opts: { socket: { path: sock, ownDir: own } } });
  assert.equal(fs.statSync(own).mode & 0o777, 0o700);
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  const c = await r.connect();
  assert.ok(c.getInstructions());
  await r.close();
  assert.equal(fs.existsSync(sock), false);
  fs.rmSync(dir, { recursive: true });
});

test("socket: a symlinked or foreign-mode own dir is refused", { skip: process.platform === "win32" }, async () => {
  const dir = tmp(), real = path.join(dir, "real"), link = path.join(dir, "link");
  fs.mkdirSync(real); fs.symlinkSync(real, link);
  const logs = [];
  const a = createAgent({ send() {}, settingsFile: path.join(dir, "a.json"), socket: { path: path.join(link, "s"), ownDir: link }, table: TABLE, env: {}, log: (m) => logs.push(m) });
  await a.start();
  assert.ok(logs.some((m) => /symlink/.test(m)));
  assert.equal(fs.existsSync(path.join(real, "s")), false);
  await a.stop();
  fs.rmSync(dir, { recursive: true });
});

test("socket: a stale file is replaced; a live socket of another server is left alone", { skip: process.platform === "win32" }, async () => {
  const dir = tmp(), sock = path.join(dir, "s");
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res) => child.stdout.once("data", res));
  child.kill("SIGKILL"); await new Promise((res) => child.once("exit", res));
  assert.ok(fs.existsSync(sock)); // stale: nothing listens
  const r = await rig({ sock, mode: "read" });
  const c = await r.connect();
  assert.ok(c.getInstructions());
  await r.close();
  // live: another server answers
  const other = net.createServer(); await new Promise((res) => other.listen(sock, res));
  const ino = fs.statSync(sock).ino;
  const logs = [];
  const a = createAgent({ send() {}, settingsFile: path.join(dir, "a.json"), socket: { path: sock, ownDir: null }, table: TABLE, env: {}, log: (m) => logs.push(m) });
  await a.start();
  assert.ok(logs.some((m) => /another Ghidorita/.test(m)));
  await a.stop(); // must not unlink what it does not own
  assert.equal(fs.statSync(sock).ino, ino);
  await new Promise((res) => other.close(res));
  fs.rmSync(dir, { recursive: true });
});

test("mode: persisted round trip; garbage or unknown values give off; the env override wins and is not saved", async () => {
  const dir = tmp(), file = path.join(dir, "agent.json"), mk = (env = {}) => createAgent({ send() {}, settingsFile: file, socket: { path: path.join(dir, "s"), ownDir: null }, table: TABLE, env, log() {} });
  assert.equal(loadMode(file), "off"); // missing
  const a = mk(); assert.equal(a.mode(), "off");
  a.setMode("edit");
  assert.equal(mk().mode(), "edit");
  for (const junk of ["{not json", "null", '{"mode":"root"}', '{"mode":5}', "[]"]) { fs.writeFileSync(file, junk); assert.equal(loadMode(file), "off", junk); }
  fs.writeFileSync(file, '{"mode":"read"}');
  const e = mk({ GHIDORITA_AGENT_MODE: "full" });
  assert.equal(e.mode(), "full");
  e.setMode("read");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { mode: "read" });
  e.setMode("edit"); // env override active: not persisted
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { mode: "read" });
  assert.equal(mk({ GHIDORITA_AGENT_MODE: "bogus" }).mode(), "read");
  fs.rmSync(dir, { recursive: true });
});

test("helpers: client names are sanitised; the setup text carries the real path", () => {
  assert.equal(cleanName("  a\nb\u0000c  "), "a b c");
  assert.equal(cleanName(""), "agent"); assert.equal(cleanName(7), "agent"); assert.equal(cleanName("\u0007"), "agent");
  const packaged = setupText({ packaged: true, resourcesPath: "/Applications/Ghidorita.app/Contents/Resources", appDir: "/x" });
  assert.match(packaged, /claude mcp add ghidorita -- "\/Applications\/Ghidorita.app\/Contents\/Resources\/mcp\/ghidorita-mcp"/);
  assert.match(packaged, /command = "\/Applications\/Ghidorita.app\/Contents\/Resources\/mcp\/ghidorita-mcp"\ntool_timeout_sec = 120/);
  const dev = setupText({ packaged: false, resourcesPath: "/r", appDir: "/dev/app" });
  assert.match(dev, /claude mcp add ghidorita -- "node" "\/dev\/app\/out\/mcp\/bridge.cjs"/);
  assert.match(dev, /command = "node"\nargs = \["\/dev\/app\/out\/mcp\/bridge.cjs"\]/);
});

test("native menu: Agent radios follow the mode, clients are listed, Help copies the setup", () => {
  let mode = "off", clients = [];
  const agent = { mode: () => mode, setMode: (m) => { mode = m; }, clients: () => clients, setupText: () => "SETUP" };
  const m = createMenu({ getWin: () => undefined, pick: async () => null, agent });
  const find = () => { const flat = (items) => items.flatMap((i) => [i, ...(i.submenu ?? []).flatMap((s) => flat([s]))]); return (id) => flat(globalThis.__builtMenu).find((i) => i.id === id || i.label === id); };
  let f = find();
  assert.ok(f("Agent")); assert.ok(f("Help") || globalThis.__builtMenu.some((i) => i.role === "help"));
  assert.deepEqual(["off", "read", "edit"].map((x) => f("agent-" + x).checked), [true, false, false]);
  assert.equal(f("agent-full"), undefined); // Full is not offered yet
  assert.equal(f("agent-clients").label, "No agent connected"); assert.equal(f("agent-clients").enabled, false);
  f("agent-edit").click();
  clients = ["Claude Code", "codex"]; m.refresh(); f = find();
  assert.deepEqual(["off", "read", "edit"].map((x) => f("agent-" + x).checked), [false, false, true]);
  assert.equal(f("agent-clients").label, "Connected: Claude Code, codex");
  f("agent-setup").click();
  assert.equal(globalThis.__clipboard, "SETUP");
});

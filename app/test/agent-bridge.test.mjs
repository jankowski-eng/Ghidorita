import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const dir = fs.mkdtempSync(path.join("/tmp", "gb-")); // short: sun_path is 104 bytes on macOS
const bridge = path.join(dir, "bridge.cjs");
before(() => build({ entryPoints: [new URL("../src/mcp/bridge.ts", import.meta.url).pathname], outfile: bridge, bundle: true, platform: "node", format: "cjs" }));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
const sockPath = () => path.join(dir, `s${n++}.sock`);
const run = (args, sock, env = {}) => {
  const p = spawn(process.execPath, [bridge, ...args], { env: { ...process.env, GHIDORITA_AGENT_SOCKET: sock, GHIDORITA_RETRY_MS: "50", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  p.out = []; p.on("error", () => {});
  p.stdout.on("data", (c) => p.out.push(c));
  p.exit = new Promise((r) => p.on("close", (code) => r(code)));
  return p;
};
const server = (sock, onConn) => new Promise((res) => { const s = net.createServer(onConn); s.listen(sock, () => res(s)); });
const rpc = (p, msg) => new Promise((res) => {
  const want = Buffer.concat(p.out).toString().split("\n").length;
  const t = setInterval(() => { const ls = Buffer.concat(p.out).toString().split("\n"); if (ls.length > want) { clearInterval(t); res(JSON.parse(ls[want - 1])); } }, 10);
  p.stdin.write(JSON.stringify(msg) + "\n");
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what = "condition") => { for (let i = 0; i < 300; i++) { if (await f()) return; await sleep(20); } throw new Error(`timeout: ${what}`); };
const lines = (p) => Buffer.concat(p.out).toString().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });

// the app as main runs it: an SDK Server on every connection
async function fakeApp(sock) {
  const conns = new Set();
  const srv = net.createServer((c) => {
    conns.add(c); c.on("close", () => conns.delete(c)); c.on("error", () => {});
    const s = new Server({ name: "fake", version: "1" }, { capabilities: { tools: { listChanged: true } }, instructions: "app" });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["alpha", "slow"].map((name) => ({ name, inputSchema: { type: "object" } })) }));
    s.setRequestHandler(CallToolRequestSchema, async (r) => { if (r.params.name === "slow") await new Promise(() => {}); return { content: [{ type: "text", text: `ran ${r.params.name}` }] }; });
    s.connect(new StdioServerTransport(c, c));
  });
  await new Promise((r) => srv.listen(sock, r));
  return { conns, kill: () => { conns.forEach((c) => c.destroy()); return new Promise((r) => srv.close(r)); } };
}
async function sdkClient(sock, env = {}) {
  const c = new Client({ name: "t", version: "1" }, {});
  c.errors = []; c.changes = 0;
  c.onerror = (e) => c.errors.push(e);
  c.setNotificationHandler(ToolListChangedNotificationSchema, () => { c.changes++; });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bridge], env: { ...process.env, GHIDORITA_AGENT_SOCKET: sock, GHIDORITA_RETRY_MS: "50", ...env }, stderr: "ignore" }));
  return c;
}
const names = async (c) => (await c.listTools()).tools.map((t) => t.name);

test("pipes bytes both ways unchanged, partial and 1 MB lines included", async () => {
  const sock = sockPath(), got = [];
  const srv = await server(sock, (c) => { c.on("data", (d) => { got.push(d); c.write(d); }); });
  const p = run([], sock);
  const big = "x".repeat(1 << 20) + "\n";
  p.stdin.write('{"a":'); await new Promise((r) => setTimeout(r, 50)); p.stdin.write('1}\n'); p.stdin.write(big);
  while (Buffer.concat(p.out).length < big.length + 6) await new Promise((r) => setTimeout(r, 20));
  assert.equal(Buffer.concat(p.out).toString(), '{"a":1}\n' + big);
  assert.equal(Buffer.concat(got).toString(), '{"a":1}\n' + big);
  p.stdin.end();
  assert.equal(await p.exit, 0); // stdin EOF closes the socket and exits
  srv.close();
});

test("socket close returns to the fallback; the process lives until stdin ends", async () => {
  const sock = sockPath();
  const srv = await server(sock, (c) => c.end("bye\n"));
  const p = run([], sock, { GHIDORITA_RETRY_MS: "60000" });
  await until(() => lines(p).length >= 1);
  assert.equal(lines(p)[0], "bye");
  const call = await rpc(p, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status" } });
  assert.match(call.result.content[0].text, /not running/);
  assert.ok(!lines(p).some((m) => m.method === "notifications/tools/list_changed")); // this client never initialized: nothing to announce
  p.stdin.end();
  assert.equal(await p.exit, 0);
  srv.close();
});

test("without the app: answers at once, advertises listChanged, status says how to launch", async () => {
  const sock = sockPath(), marker = path.join(dir, `launched${n}`);
  const t0 = Date.now();
  const c = await sdkClient(sock, { GHIDORITA_APP_CMD: `touch ${marker}` });
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(c.getServerCapabilities().tools.listChanged, true);
  assert.deepEqual(await names(c), ["status"]);
  const text = (await c.callTool({ name: "status", arguments: {} })).content[0].text;
  assert.match(text, /launch: true/); assert.match(text, /Agent > Access/);
  await sleep(100);
  assert.ok(!fs.existsSync(marker)); // nothing launched by itself
  const t1 = Date.now();
  const r = await c.callTool({ name: "status", arguments: { launch: true } });
  assert.ok(Date.now() - t1 < 1000); assert.match(r.content[0].text, /switches to the app by itself/);
  await until(() => fs.existsSync(marker), "launcher ran");
  await c.close();
});

test("status launch without a launcher command says so where there is none", { skip: process.platform === "darwin" }, async () => {
  const c = await sdkClient(sockPath());
  assert.match((await c.callTool({ name: "status", arguments: { launch: true } })).content[0].text, /cannot be started/);
  await c.close();
});

test("app starts after the bridge, quits mid-call, comes back: list_changed each time, no client restart", async () => {
  const sock = sockPath();
  const c = await sdkClient(sock);
  assert.deepEqual(await names(c), ["status"]);
  let app = await fakeApp(sock);
  await until(() => c.changes >= 1, "list_changed after the app appeared");
  assert.deepEqual(await names(c), ["alpha", "slow"]);
  assert.equal((await c.callTool({ name: "alpha", arguments: {} })).content[0].text, "ran alpha");
  const hung = c.callTool({ name: "slow", arguments: {} });
  hung.catch(() => {});
  await sleep(150);
  await app.kill();
  await assert.rejects(hung, (e) => e.code === -32000 && /closed the connection/.test(e.message));
  await until(() => c.changes >= 2, "list_changed after the app left");
  assert.deepEqual(await names(c), ["status"]);
  assert.match((await c.callTool({ name: "status", arguments: {} })).content[0].text, /not running/);
  app = await fakeApp(sock);
  await until(() => c.changes >= 3, "list_changed after the app came back");
  assert.deepEqual(await names(c), ["alpha", "slow"]);
  assert.equal((await c.callTool({ name: "alpha", arguments: {} })).content[0].text, "ran alpha");
  assert.deepEqual(c.errors, []); // a stray or doubled response would show up here
  await c.close(); await app.kill();
});

test("requests fired during the handover are each answered exactly once", async () => {
  const sock = sockPath();
  const p = run([], sock);
  const init = await rpc(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.match(init.result.instructions, /launch: true/);
  p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  let id = 100;
  const sendOne = () => { const i = id++; p.stdin.write(JSON.stringify(i % 2 ? { jsonrpc: "2.0", id: i, method: "tools/list" } : { jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "alpha", arguments: {} } }) + "\n"); };
  const ticker = setInterval(sendOne, 2);
  await sleep(100);
  const app = await fakeApp(sock);
  await until(() => lines(p).some((m) => m.method === "notifications/tools/list_changed"));
  await sleep(100);
  clearInterval(ticker);
  const sent = id - 100;
  await until(() => lines(p).filter((m) => m.id >= 100).length >= sent, "every request answered");
  await sleep(150);
  const got = lines(p).filter((m) => m.id !== undefined);
  assert.equal(got.length, sent + 1); // + the fallback's initialize reply (the app's was swallowed)
  assert.equal(new Set(got.map((m) => m.id)).size, sent + 1);
  assert.ok(lines(p).every((m) => typeof m === "object" && (m.id !== undefined || m.method === "notifications/tools/list_changed")));
  p.stdin.end(); assert.equal(await p.exit, 0);
  await app.kill();
});

test("stdin ending during the handover or while piping exits and closes the socket", async () => {
  // handover: the app accepts but never answers initialize
  let sock = sockPath(), closed = 0;
  const p = run([], sock);
  await rpc(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const conns = [];
  const mute = await server(sock, (c) => { conns.push(c); c.on("data", () => {}); c.on("error", () => {}); c.on("close", () => closed++); });
  await until(() => conns.length === 1);
  p.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'); // queued behind the replay
  p.stdin.end();
  assert.equal(await p.exit, 0);
  await until(() => closed === 1, "socket closed");
  mute.close();
  // piping
  sock = sockPath(); closed = 0;
  const echo = await server(sock, (c) => { c.on("data", (d) => c.write(d)); c.on("error", () => {}); c.on("close", () => closed++); });
  const q = run([], sock);
  q.stdin.write("hi\n");
  await until(() => lines(q).length === 1);
  q.stdin.end();
  assert.equal(await q.exit, 0);
  await until(() => closed === 1, "socket closed");
  echo.close();
});

test("the app quitting during the replay returns to the fallback without crashing", async () => {
  const sock = sockPath();
  const p = run([], sock);
  await rpc(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  let hits = 0;
  const dying = await server(sock, (c) => { hits++; c.on("error", () => {}); c.once("data", () => c.destroy()); });
  await until(() => hits >= 2, "bridge retried");
  const call = await rpc(p, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status" } });
  assert.match(call.result.content[0].text, /not running/);
  assert.ok(!lines(p).some((m) => m.method === "notifications/tools/list_changed")); // the client was never told of app tools
  p.stdin.end(); assert.equal(await p.exit, 0);
  dying.close();
});

test("--no-launch is accepted; the fallback answers", async () => {
  const p = run(["--no-launch"], sockPath());
  const init = await rpc(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "ghidorita");
  assert.equal(init.result.capabilities.tools.listChanged, true);
  p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n');
  assert.equal((await rpc(p, { jsonrpc: "2.0", id: 4, method: "ping" })).result !== undefined, true);
  assert.equal((await rpc(p, { jsonrpc: "2.0", id: 5, method: "resources/list" })).error.code, -32601);
  assert.match((await rpc(p, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })).error.message, /Unknown tool/);
  p.stdin.end();
  assert.equal(await p.exit, 0);
});

test("a stale socket file counts as not running", async () => {
  const sock = sockPath();
  const dead = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}).on("listening",()=>process.kill(process.pid,"SIGKILL"))`]);
  await new Promise((r) => dead.on("close", r)); // killed, so the socket file stays: ECONNREFUSED
  assert.ok(fs.existsSync(sock));
  const p = run([], sock);
  const call = await rpc(p, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status" } });
  assert.match(call.result.content[0].text, /not running/);
  p.stdin.end(); await p.exit;
});

test("the app was already running when the bridge started, then restarts: the new connection gets the client's handshake again (calls work)", async () => {
  const sock = sockPath();
  let app = await fakeApp(sock);
  const c = await sdkClient(sock);
  assert.deepEqual(await names(c), ["alpha", "slow"]); // piped from the start: the bridge never answered initialize itself
  await app.kill();
  await until(async () => (await names(c).catch(() => [])).join() === "status", "fallback after the app quit"); // a list in flight when the app dies gets the documented error
  app = await fakeApp(sock);
  await until(async () => (await names(c).catch(() => [])).includes("alpha"), "the app is back");
  const r = await c.callTool({ name: "alpha", arguments: {} }); // main refuses tools/call before notifications/initialized: it must have been replayed
  assert.equal(r.content[0].text, "ran alpha");
  assert.deepEqual(c.errors, []);
  await c.close(); await app.kill();
});

test("stdin ending while the first connect attempt is still deciding still answers what was sent (one-shot use)", async () => {
  const sock = sockPath();
  const p = run([], sock);
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-03-26" } }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" })); // the last line has no newline
  p.stdin.end();
  assert.equal(await p.exit, 0);
  const got = lines(p);
  assert.deepEqual(got.map((m) => m.id), [7, 8]);
  assert.equal(got[1].result.tools[0].name, "status");
});

test("a repeated status launch within a few seconds does not start another process", async () => {
  const sock = sockPath(), marker = path.join(dir, `count${n}`);
  const c = await sdkClient(sock, { GHIDORITA_APP_CMD: `echo x >> ${marker}` });
  for (let i = 0; i < 3; i++) assert.match((await c.callTool({ name: "status", arguments: { launch: true } })).content[0].text, /switches to the app/);
  await until(() => fs.existsSync(marker), "launcher ran"); await sleep(200);
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").length, 1);
  await c.close();
});

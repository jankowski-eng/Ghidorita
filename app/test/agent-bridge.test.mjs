import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const dir = fs.mkdtempSync(path.join("/tmp", "gb-")); // short: sun_path is 104 bytes on macOS
const bridge = path.join(dir, "bridge.cjs");
before(() => build({ entryPoints: [new URL("../src/mcp/bridge.ts", import.meta.url).pathname], outfile: bridge, bundle: true, platform: "node", format: "cjs" }));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
const sockPath = () => path.join(dir, `s${n++}.sock`);
const run = (args, sock, env = {}) => {
  const p = spawn(process.execPath, [bridge, ...args], { env: { ...process.env, GHIDORITA_AGENT_SOCKET: sock, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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

test("socket close ends the process", async () => {
  const sock = sockPath();
  const srv = await server(sock, (c) => c.end("bye\n"));
  const p = run([], sock);
  assert.equal(await p.exit, 0);
  assert.equal(Buffer.concat(p.out).toString(), "bye\n");
  srv.close();
});

test("--no-launch without the app answers for it", async () => {
  const p = run(["--no-launch"], sockPath());
  const init = await rpc(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "ghidorita");
  assert.ok(init.result.capabilities.tools);
  p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n');
  const list = await rpc(p, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["status"]);
  const call = await rpc(p, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } });
  assert.ok(!call.result.isError);
  assert.match(call.result.content[0].text, /Ghidorita is not running/);
  assert.equal((await rpc(p, { jsonrpc: "2.0", id: 4, method: "ping" })).result !== undefined, true);
  assert.equal((await rpc(p, { jsonrpc: "2.0", id: 5, method: "resources/list" })).error.code, -32601);
  p.stdin.end();
  assert.equal(await p.exit, 0);
});

test("a stale socket file counts as not running", async () => {
  const sock = sockPath();
  const dead = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}).on("listening",()=>process.kill(process.pid,"SIGKILL"))`]);
  await new Promise((r) => dead.on("close", r)); // killed, so the socket file stays: ECONNREFUSED
  assert.ok(fs.existsSync(sock));
  const p = run(["--no-launch"], sock);
  const call = await rpc(p, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status" } });
  assert.match(call.result.content[0].text, /not running/);
  p.stdin.end(); await p.exit;
});

test("--launch waits for the socket and keeps the early initialize", async () => {
  const sock = sockPath(), marker = path.join(dir, "launched");
  const helper = path.join(dir, "app.cjs");
  fs.writeFileSync(helper, `setTimeout(()=>{const s=require("net").createServer(c=>c.on("data",d=>c.write(d)));s.listen(${JSON.stringify(sock)});},600);`);
  const p = run([], sock, { GHIDORITA_APP_CMD: `touch ${marker}; exec "${process.execPath}" ${helper}` });
  p.stdin.write('{"id":1,"method":"initialize"}\n');
  while (!Buffer.concat(p.out).toString().includes("\n")) await new Promise((r) => setTimeout(r, 20));
  assert.equal(Buffer.concat(p.out).toString(), '{"id":1,"method":"initialize"}\n');
  assert.ok(fs.existsSync(marker));
  p.stdin.end(); assert.equal(await p.exit, 0);
  spawn("pkill", ["-f", helper]);
});

test("--launch that never opens the socket falls back with that reason", async () => {
  const p = run([], sockPath(), { GHIDORITA_APP_CMD: "true", GHIDORITA_LAUNCH_TIMEOUT_MS: "600" });
  const call = await rpc(p, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status" } });
  assert.match(call.result.content[0].text, /did not open its agent socket/);
  p.stdin.end(); await p.exit;
});

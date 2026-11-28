import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport as LineTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// The headless host and what protects the agent socket: the socket owner check, the lock, the handover protocol, the host's lifetime, the headless executor, the bridge's --headless launch.
process.umask(0o077);
const out = fs.mkdtempSync("/tmp/ghh");
process.on("exit", () => fs.rmSync(out, { recursive: true, force: true }));
let n = 0;
const bundle = async (entry) => {
  const file = path.join(out, `b${n++}.mjs`);
  fs.writeFileSync(file, (await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } })).outputFiles[0].text);
  return import(file);
};
const { socketProblem, ctlPath, lockPath, agentSocketPlace } = await bundle("../src/agent/socketPath.ts");
const { acquireLock, lockAge } = await bundle("../src/main/socketLock.ts");
const { serveControl, requestHandover, claimSocket } = await bundle("../src/main/hostControl.ts");
const { createHeadless, startHost } = await bundle("../src/main/agentHost.ts");
const { createAgent, MAX_REQUEST_LINE } = await bundle("../src/main/agent.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + f); await sleep(10); } };
const tmp = () => fs.mkdtempSync("/tmp/gh");
const deadPid = async () => { const c = spawn(process.execPath, ["-e", ""]); await new Promise((r) => c.once("exit", r)); return c.pid; };

// ---- socket owner check ----
const st = (o) => ({ mode: 0o140600, uid: 501, isSocket: () => true, ...o });
const fsOf = (files) => (p) => files[p] ?? null;
test("socketProblem: a socket must be ours, closed to others, and in a directory others cannot swap it in", () => {
  const dir = { mode: 0o40700, uid: 501, isSocket: () => false };
  const ok = fsOf({ "/r/s": st(), "/r": dir });
  assert.equal(socketProblem("/r/s", ok, 501), null);
  assert.equal(socketProblem("/r/missing", fsOf({ "/r": dir }), 501), null, "nothing there yet: fine");
  assert.match(socketProblem("/r/s", fsOf({ "/r/s": st({ uid: 0 }), "/r": dir }), 501), /not owned/);
  assert.match(socketProblem("/r/s", fsOf({ "/r/s": st({ mode: 0o140666 }), "/r": dir }), 501), /accessible to others/);
  assert.match(socketProblem("/r/s", fsOf({ "/r/s": st({ mode: 0o140660 }), "/r": dir }), 501), /accessible to others/);
  assert.match(socketProblem("/r/s", fsOf({ "/r/s": st({ isSocket: () => false }), "/r": dir }), 501), /not a socket/);
  assert.match(socketProblem("/r/s", fsOf({ "/r/s": st(), "/r": { ...dir, uid: 1234 } }), 501), /directory/);
  assert.match(socketProblem("/r/s", fsOf({ "/r/s": st(), "/r": { ...dir, mode: 0o40777 } }), 501), /directory/);
  assert.equal(socketProblem("/tmp/s", fsOf({ "/tmp/s": st(), "/tmp": { mode: 0o41777, uid: 0, isSocket: () => false } }), 501), null, "a sticky world-writable /tmp is how this works");
  assert.equal(socketProblem("/p", fsOf({}), null), null, "Windows pipes are not checked");
});

test("the paths next to the socket, and the long-path fallback leaves room for them", () => {
  assert.equal(ctlPath("/a/s"), "/a/s.ctl"); assert.equal(lockPath("/a/s"), "/a/s.lock");
  const at = { env: {}, platform: "darwin", home: "/Users/me", tmpdir: "/var/folders/x/T", user: "me", uid: 501 };
  const p = agentSocketPlace({ ...at, home: "/Users/" + "x".repeat(60) }).path; // 98 bytes with the file name: fits the socket, not the .lock beside it
  assert.ok(Buffer.byteLength(lockPath(p)) <= 103, p);
});

test("main refuses to listen on, or unlink, a socket that is not ours or is open to others; the bridge does not connect to it", async () => {
  const dir = tmp(), sock = path.join(dir, "s"), logs = [];
  const c = spawn(process.execPath, ["-e", `process.umask(0o022);require("net").createServer().listen(${JSON.stringify(sock)},()=>process.kill(process.pid,"SIGKILL"))`]); // a dead server's socket file, open to others
  await new Promise((r) => c.once("exit", r));
  assert.ok(fs.statSync(sock).mode & 0o077, "the stale file is loose");
  const a = createAgent({ send() {}, settingsFile: path.join(dir, "a.json"), socket: { path: sock, ownDir: null }, table: [], env: {}, log: (m) => logs.push(m) });
  await a.start();
  assert.ok(logs.some((m) => /accessible to others/.test(m)), logs.join("|"));
  assert.ok(!a.listening()); assert.ok(fs.existsSync(sock), "it is not unlinked either");
  assert.equal(lockAge(sock), null, "and no lock stays behind");
  fs.rmSync(dir, { recursive: true });
});

test("main closes a connection whose request line never ends", async () => {
  const dir = tmp(), sock = path.join(dir, "s"), logs = [];
  const a = createAgent({ send() {}, settingsFile: path.join(dir, "a.json"), socket: { path: sock, ownDir: null }, table: [], env: {}, log: (m) => logs.push(m) });
  await a.start();
  const c = net.connect(sock); c.on("error", () => {});
  await new Promise((r) => c.once("connect", r));
  const chunk = Buffer.alloc(256 << 10, 65);
  const closed = new Promise((r) => c.once("close", r));
  for (let i = 0; i < 6 && !c.destroyed; i++) { c.write(chunk); await sleep(10); }
  await closed;
  assert.ok(logs.some((m) => /too long/.test(m)));
  assert.equal(a.connections(), 0);
  await a.stop(); fs.rmSync(dir, { recursive: true });
  assert.equal(MAX_REQUEST_LINE, 1 << 20);
});

// ---- the lock ----
test("lock: exactly one of many concurrent starters wins; release lets the next in", async () => {
  const dir = tmp(), sock = path.join(dir, "s");
  const got = (await Promise.all(Array.from({ length: 8 }, () => acquireLock(sock)))).filter(Boolean);
  assert.equal(got.length, 1);
  assert.equal(await acquireLock(sock), null);
  assert.ok(lockAge(sock) < 2000);
  got[0].release(); got[0].release();
  assert.equal(lockAge(sock), null);
  const again = await acquireLock(sock); assert.ok(again); again.release();
  fs.rmSync(dir, { recursive: true });
});

test("lock: a dead holder's lock is replaced by exactly one of the racers; a live one is respected; a reused pid is told by the silent socket", async () => {
  const dir = tmp(), sock = path.join(dir, "s");
  fs.mkdirSync(lockPath(sock)); fs.writeFileSync(path.join(lockPath(sock), "pid"), String(await deadPid()));
  const got = (await Promise.all(Array.from({ length: 8 }, () => acquireLock(sock)))).filter(Boolean);
  assert.equal(got.length, 1, "one winner takes over the dead lock");
  got[0].release();
  // a live pid (this process) that is old, with a socket that answers: still held; silent: taken for a reused pid
  fs.mkdirSync(lockPath(sock)); fs.writeFileSync(path.join(lockPath(sock), "pid"), String(process.pid));
  const old = new Date(Date.now() - 10 * 60_000); fs.utimesSync(lockPath(sock), old, old);
  assert.equal(await acquireLock(sock, { answers: async () => true }), null);
  const l = await acquireLock(sock, { answers: async () => false }); assert.ok(l); l.release();
  // a lock between mkdir and its pid file is a creator at work
  fs.mkdirSync(lockPath(sock)); assert.equal(await acquireLock(sock), null);
  fs.rmSync(dir, { recursive: true });
});

test("agent.start takes the lock itself when none is given, and stop gives it back; a second agent does not listen", async () => {
  const dir = tmp(), sock = path.join(dir, "s"), logs = [];
  const mk = () => createAgent({ send() {}, settingsFile: path.join(dir, "a.json"), socket: { path: sock, ownDir: null }, table: [], env: {}, log: (m) => logs.push(m) });
  const a = mk(), b = mk();
  await a.start(); await b.start();
  assert.ok(a.listening() && !b.listening());
  assert.ok(logs.some((m) => /another Ghidorita/.test(m)));
  await b.stop(); assert.ok(lockAge(sock) !== null, "b never held it");
  await a.stop(); assert.equal(lockAge(sock), null);
  fs.rmSync(dir, { recursive: true });
});

// ---- handover protocol ----
test("handover: the host answers right away, then done; the app waits for done; concurrent requests share one shutdown", async () => {
  const dir = tmp(), sock = path.join(dir, "s");
  let runs = 0, replied = 0;
  const srv = await serveControl(sock, async () => { runs++; await sleep(100); return { saved: true }; }, () => {}, () => replied++);
  assert.ok(!(fs.statSync(ctlPath(sock)).mode & 0o077), "same permissions as the agent socket");
  const [a, b] = await Promise.all([requestHandover(sock), requestHandover(sock)]);
  assert.deepEqual([a.kind, a.saved, b.kind], ["done", true, "done"]); assert.equal(runs, 1); assert.equal(typeof a.pid, "number");
  await until(() => replied === 2);
  await srv.close();
  assert.equal((await requestHandover(sock)).kind, "none");
  fs.rmSync(dir, { recursive: true });
});

test("handover: a failed save is reported; a hung host times out; garbage is refused", async () => {
  const dir = tmp(), sock = path.join(dir, "s");
  const srv = await serveControl(sock, async () => ({ saved: false, saveError: "disk full" }), () => {});
  const r = await requestHandover(sock); assert.deepEqual([r.kind, r.saved, r.saveError], ["done", false, "disk full"]);
  await srv.close();
  const hung = await serveControl(sock, () => new Promise(() => {}), () => {});
  const t = await requestHandover(sock, { timeoutMs: 150 }); assert.equal(t.kind, "failed"); assert.match(t.error, /did not quit within/);
  const c = net.connect(ctlPath(sock)); let got = ""; c.on("data", (d) => got += d); c.write("nonsense\n");
  await new Promise((r) => c.once("close", r)); assert.match(got, /"ok":false/);
  const big = net.connect(ctlPath(sock)); big.on("error", () => {}); big.write("x".repeat(5000));
  await new Promise((r) => big.once("close", r)); // a line over the cap closes the connection
  await hung.close(); fs.rmSync(dir, { recursive: true });
});

test("handover: refuses a control socket that is not ours or is open to others", async () => {
  const dir = tmp(), sock = path.join(dir, "s");
  process.umask(0o022);
  const evil = net.createServer(); await new Promise((r) => evil.listen(ctlPath(sock), r)); process.umask(0o077);
  const r = await requestHandover(sock); assert.equal(r.kind, "failed"); assert.match(r.error, /accessible to others/);
  await new Promise((r) => evil.close(r)); fs.rmSync(dir, { recursive: true });
});

test("claimSocket: nobody holds it: the app takes the lock at once", async () => {
  const dir = tmp(), sock = path.join(dir, "s");
  const c = await claimSocket({ path: sock, ownDir: null });
  assert.ok(c.lock); assert.equal(c.error, undefined);
  c.lock.release(); fs.rmSync(dir, { recursive: true });
});

test("claimSocket: a host holds the lock: the app asks it to quit and gets the lock once the host let go (and hears a failed save)", async () => {
  const dir = tmp(), sock = path.join(dir, "s");
  const hostLock = await acquireLock(sock); let release = 0;
  const srv = await serveControl(sock, async () => { await sleep(80); hostLock.release(); release++; return { saved: false, saveError: "save failed" }; }, () => {});
  const c = await claimSocket({ path: sock, ownDir: null }, { timeoutMs: 5000 });
  assert.ok(c.lock, JSON.stringify(c)); assert.equal(release, 1); assert.equal(c.saveError, "save failed");
  c.lock.release(); await srv.close(); fs.rmSync(dir, { recursive: true });
});

test("claimSocket: a host that never quits is an error and the app gets no lock (it must not start a sidecar); a live app (no control socket, old lock) is left alone", async () => {
  const dir = tmp(), sock = path.join(dir, "s");
  const hostLock = await acquireLock(sock);
  const srv = await serveControl(sock, () => new Promise(() => {}), () => {});
  const c = await claimSocket({ path: sock, ownDir: null }, { timeoutMs: 300 });
  assert.equal(c.lock, null); assert.match(c.error, /did not quit/);
  await srv.close();
  const old = new Date(Date.now() - 60_000); fs.utimesSync(lockPath(sock), old, old); // an app that has run for a minute: no control socket
  const t = Date.now(), d = await claimSocket({ path: sock, ownDir: null }, { timeoutMs: 5000 });
  assert.equal(d.lock, null); assert.equal(d.error, undefined); assert.ok(Date.now() - t < 1500, "no waiting for a host that is not there");
  hostLock.release(); fs.rmSync(dir, { recursive: true });
});

// ---- the headless executor ----
const SESSION = { sessionId: "s1", programId: "p1", name: "a.out" };
const FN = { name: "main", entry: "0x401000", size: 64, signature: "int main(void)" };
function fakeBackend(getHooks) {
  const stack = []; let saves = 0;
  const ops = {
    functions: { containing: async () => FN, list: async () => [FN] },
    edits: { renameVariable: async (p) => { const r = { undoName: "Rename variable in main" }; stack.push(r.undoName); getHooks().onEdit("renameVariable", p, r); return r; } },
    history: {
      state: async () => ({ canUndo: stack.length > 0, canRedo: false, undoName: stack.at(-1), dirty: stack.length > 0 }),
      undo: async () => { stack.pop(); getHooks().onEdit("undo", {}, {}); return { canUndo: false, canRedo: true, dirty: true }; },
      save: async () => { saves++; stack.length = 0; return { saved: true, undoHistoryCleared: true }; },
    },
    analysis: { status: async () => ({ state: "done", analysis: "done", profile: "full", pct: 100 }) },
  };
  return { stack, saves: () => saves, backend: {
    capabilities: new Set(["variableEditing", "editing", "undo", "analysis"]), program: () => ops, events: { onError() {} },
    lifecycle: { active: async () => null, open: (p) => ({ result: Promise.resolve().then(() => { getHooks().onSessionChanged(SESSION); return SESSION; }) }) },
    connect: async () => {},
  } };
}
const call = (tool, args = {}, client = "claude-code#1") => ({ callId: "c" + Math.random(), tool, args, client, mode: "edit", timeoutSecs: 5 });

test("headless executor: no ui, program follows the session hook, edits are attributed, undo_agent_edit works, the session change clears the log", async () => {
  const replies = [];
  const h = createHeadless({ reply: (r) => replies.push(r) });
  const w = fakeBackend(() => h.hooks);
  await h.bind(w.backend);
  assert.equal(h.program(), null);
  await h.handle(call("status")); assert.match(replies.at(-1).content, /Program: none open/);
  h.hooks.onSessionChanged(SESSION);
  assert.equal(h.program().session, SESSION);
  await h.handle(call("get_view")); assert.equal(replies.at(-1).ok, false); // appOnly tools are not listed headless; if one is called anyway it has no ui to use
  await h.handle(call("rename_variable", { function: "0x401000", variable: "local_10", newName: "len" }));
  assert.equal(replies.at(-1).ok, true, replies.at(-1).error ?? "");
  assert.equal(h.changes.items.length, 1); assert.equal(h.changes.items[0].by, "claude-code#1"); assert.equal(h.changes.items[0].undoName, "Rename variable in main");
  await h.handle(call("undo_agent_edit", {}, "someone-else#2")); assert.match(replies.at(-1).error, /not by you/);
  await h.handle(call("undo_agent_edit")); assert.match(replies.at(-1).content, /Undid/);
  assert.equal(w.stack.length, 0);
  h.hooks.onSessionChanged(null);
  assert.equal(h.program(), null); assert.equal(h.changes.items.length, 0);
});

test("headless executor: list_functions asks the provider (no app list)", async () => {
  const replies = [];
  const h = createHeadless({ reply: (r) => replies.push(r) });
  await h.bind(fakeBackend(() => h.hooks).backend); h.hooks.onSessionChanged(SESSION);
  await h.handle(call("list_functions")); assert.match(replies.at(-1).content, /0x401000.*main/);
});

// ---- the host ----
async function hostRig(o = {}) {
  const dir = tmp(), sock = path.join(dir, "s"), exits = [], logs = [];
  let hooks, stops = 0;
  const w = fakeBackend(() => hooks);
  const provider = { start: async () => 4242, stop: async () => { stops++; return 0; }, kill() {} };
  const host = await startHost({ place: { path: sock, ownDir: null }, settingsFile: path.join(dir, "agent.json"), env: { GHIDORITA_AGENT_MODE: "edit" }, graceMs: 200, provider, launch: {}, token: "t",
    makeBackend: (h) => { hooks = h; return w.backend; }, exit: (c) => exits.push(c), log: (m) => logs.push(m), ...o.opts });
  const clients = [];
  const connect = async (name = "claude-code") => {
    const s = net.connect(sock); await new Promise((r, j) => { s.once("connect", r); s.once("error", j); });
    const c = new Client({ name, version: "1" }); await c.connect(new LineTransport(s, s)); c.sock = s; clients.push(c); return c;
  };
  const text = async (c, name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
  const cleanup = async () => { for (const c of clients) { c.sock.destroy(); } await host?.quit(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { host, sock, dir, exits, logs, w, connect, text, cleanup, stops: () => stops };
}

test("host: two clients share it; it lists no app-only tools; the program opens at start; edits show in status; it waits out the grace period after the last client", async () => {
  const r = await hostRig({ opts: { open: "/x/a.out" } });
  await r.host.started;
  const a = await r.connect("claude-code"), b = await r.connect("codex");
  const names = (await a.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("status") && names.includes("rename_variable")); assert.ok(!names.includes("get_view") && !names.includes("goto"));
  assert.match(await r.text(a, "status"), /Access: edit \(client claude-code#\d+\)[\s\S]*Program: a\.out/);
  assert.match(await r.text(b, "rename_variable", { function: "0x401000", variable: "local_10", newName: "len" }), /Renamed/);
  assert.match(await r.text(a, "status"), /Edits: unsaved/);
  a.sock.destroy(); await sleep(350);
  assert.deepEqual(r.exits, [], "one client is left: no exit");
  b.sock.destroy();
  await until(() => r.exits.length, 2000);
  assert.deepEqual(r.exits, [0]); assert.equal(r.stops(), 1); assert.equal(r.w.saves(), 1, "the edit was saved before the sidecar was stopped");
  assert.equal(lockAge(r.sock), null, "the lock is released at exit"); assert.ok(!fs.existsSync(r.sock));
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test("host: calls during startup are told to wait; with nobody ever connecting it exits after the grace period", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const r = await hostRig({ opts: { provider: { start: async () => { await gate; return 1; }, stop: async () => 0, kill() {} } } });
  const a = await r.connect();
  const res = await a.callTool({ name: "status", arguments: {} });
  assert.equal(res.isError, true); assert.match(res.content[0].text, /still starting/);
  release(); await r.host.started;
  assert.match(await r.text(a, "status"), /Access: edit/);
  a.sock.destroy();
  await until(() => r.exits.length, 2000); assert.deepEqual(r.exits, [0]);
  const r2 = await hostRig({ opts: { graceMs: 100 } }); await r2.host.started;
  await until(() => r2.exits.length, 2000); // nobody came
  fs.rmSync(r.dir, { recursive: true, force: true }); fs.rmSync(r2.dir, { recursive: true, force: true });
});

test("host: the handover. The app asks over the control socket: clients lose the connection, edits are saved, the sidecar ended, the lock is free when it says done; then the host exits", async () => {
  const r = await hostRig({ opts: { open: "/x/a.out", graceMs: 60_000 } });
  await r.host.started;
  const a = await r.connect();
  await r.text(a, "rename_variable", { function: "0x401000", variable: "local_10", newName: "len" });
  const closed = new Promise((res) => a.sock.once("close", res));
  const got = await requestHandover(r.sock);
  assert.equal(got.kind, "done"); assert.equal(got.saved, true); assert.equal(r.stops(), 1); assert.equal(r.w.saves(), 1);
  assert.equal(lockAge(r.sock), null, "the lock was released before done");
  await closed;
  await until(() => r.exits.length); assert.deepEqual(r.exits, [0]);
  const lock = await acquireLock(r.sock); assert.ok(lock, "the app can take over"); lock.release();
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test("host: a second host (or an app) that finds the socket held exits at once and starts nothing", async () => {
  const r = await hostRig(); await r.host.started;
  const exits = [];
  const second = await startHost({ place: { path: r.sock, ownDir: null }, settingsFile: path.join(r.dir, "x.json"), provider: { start: async () => { throw new Error("must not start"); }, stop: async () => 0, kill() {} }, launch: {}, token: "t", exit: (c) => exits.push(c), log() {} });
  assert.equal(second, null); assert.deepEqual(exits, [0]);
  await r.cleanup();
});

test("host: a sidecar that dies ends the host with code 1", async () => {
  let onExit;
  const r = await hostRig({ opts: { provider: { start: async (l, cb) => { onExit = cb; return 1; }, stop: async () => 0, kill() {} } } });
  await r.host.started; onExit("SIGKILL");
  await until(() => r.exits.length); assert.deepEqual(r.exits, [1]);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

// ---- the bridge ----
test("bridge --headless: status launch runs GHIDORITA_APP_CMD with --agent-host and the binary (absolute); without --headless it gets no flag", async () => {
  const dir = tmp(), sock = path.join(dir, "s"), bridge = path.join(dir, "bridge.cjs"), rec = path.join(dir, "rec.txt");
  await build({ entryPoints: [new URL("../src/mcp/bridge.ts", import.meta.url).pathname], outfile: bridge, bundle: true, platform: "node", format: "cjs" });
  fs.writeFileSync(path.join(dir, "rec.sh"), `#!/bin/sh\necho "$@" >> ${rec}\n`, { mode: 0o755 });
  const run = async (args, extraEnv = {}) => {
    const p = spawn(process.execPath, [bridge, ...args], { cwd: dir, env: { ...process.env, GHIDORITA_AGENT_SOCKET: sock, GHIDORITA_RETRY_MS: "50", GHIDORITA_APP_CMD: path.join(dir, "rec.sh"), ...extraEnv }, stdio: ["pipe", "pipe", "ignore"] });
    let buf = ""; p.stdout.on("data", (d) => buf += d);
    const rpc = async (id, method, params) => { p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return JSON.parse(await until(() => buf.split("\n").find((l) => l.includes(`"id":${id},`)))); };
    await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const r = await rpc(2, "tools/call", { name: "status", arguments: { launch: true } });
    p.stdin.end(); await new Promise((r) => p.once("close", r));
    return r.result.content[0].text;
  };
  assert.match(await run(["--headless", "bin/sample.elf"]), /without a window/);
  await until(() => fs.existsSync(rec));
  assert.equal(fs.readFileSync(rec, "utf8").trim(), `--agent-host --open=${path.join(fs.realpathSync(dir), "bin/sample.elf")}`);
  fs.rmSync(rec);
  assert.match(await run(["--headless"]), /without a window/);
  await until(() => fs.existsSync(rec)); assert.equal(fs.readFileSync(rec, "utf8").trim(), "--agent-host");
  fs.rmSync(rec);
  assert.match(await run([]), /Asked Ghidorita to start\./);
  await until(() => fs.existsSync(rec)); assert.equal(fs.readFileSync(rec, "utf8").trim(), "");
  fs.rmSync(dir, { recursive: true });
});

test("bridge: does not connect to a socket that is open to others, and says so in status", async () => {
  const dir = tmp(), sock = path.join(dir, "s"), bridge = path.join(dir, "bridge.cjs");
  await build({ entryPoints: [new URL("../src/mcp/bridge.ts", import.meta.url).pathname], outfile: bridge, bundle: true, platform: "node", format: "cjs" });
  process.umask(0o022);
  let connected = 0;
  const evil = net.createServer(() => connected++); await new Promise((r) => evil.listen(sock, r)); process.umask(0o077);
  const p = spawn(process.execPath, [bridge], { env: { ...process.env, GHIDORITA_AGENT_SOCKET: sock, GHIDORITA_RETRY_MS: "50" }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; p.stdout.on("data", (d) => buf += d);
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  await until(() => buf.includes('"id":1,'));
  await sleep(300);
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } }) + "\n");
  const line = await until(() => buf.split("\n").find((l) => l.includes('"id":2,')));
  assert.match(line, /accessible to others/); assert.equal(connected, 0);
  p.stdin.end(); await new Promise((r) => p.once("close", r));
  await new Promise((r) => evil.close(r)); fs.rmSync(dir, { recursive: true });
});

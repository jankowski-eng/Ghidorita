// The headless host's end-to-end flow (docs/AGENTS_MCP.md "Headless host"), run for real: Electron with no window, two real bridges, then the app takes over.
//   node scripts/agent-autotest-headless.mjs [--stand-in]      (after `npm run build`; the mock provider unless MOCK is set otherwise)
// The orchestrator's AUTOTEST_FLOW=agent calls `runHeadless()` as one more step. It throws on the first failed check and returns a summary.
//   1. bridge A with --headless starts the host (status launch:true); bridge B joins the same host; an edit by A is attributed to A and B cannot undo it
//   2. the last bridge closes: the host exits after its grace period and removes its files
//   3. a new host; then the app starts: it asks the host to quit (the host saves), takes the socket and the projects dir, and both bridges end up on the app, calls working
// The app in step 3 is the real one (it opens a window) unless `standIn` is set: then main's own claim + agent server run in plain Node (no window, no renderer).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what, ms = 60_000) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`); await sleep(100); } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const text = (r) => r.content.map((x) => x.text).join("\n");
const check = (c, m) => { if (!c) throw new Error("FAIL: " + m); };

export async function runHeadless(o = {}) {
  const standIn = !!o.standIn;
  const electron = o.electron ?? createRequire(import.meta.url)("electron");
  const dir = fs.mkdtempSync(path.join("/tmp", "gha-")), sock = path.join(dir, "s"), ud = path.join(dir, "ud"), log = path.join(dir, "host.log");
  const env = { ...process.env, MOCK: process.env.MOCK ?? "1", GHIDORITA_AGENT_SOCKET: sock, GHIDORITA_AGENT_MODE: "edit", GHIDORITA_HOST_GRACE_MS: "2500", GHIDORITA_RETRY_MS: "200", SIDECAR_PROJECTS_DIR: path.join(dir, "projects") };
  delete env.AUTOTEST; delete env.AUTOTEST_FLOW; delete env.ELECTRON_RUN_AS_NODE;
  // what the bridge runs for --headless: the dev Electron with the host flags appended by the bridge (a packaged app uses its own executable)
  const launcher = path.join(dir, "launch.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${electron}" "${appDir}" --user-data-dir="${ud}" "$@" >> "${log}" 2>&1\n`, { mode: 0o755 });
  const bridge = path.join(appDir, "out/mcp/bridge.cjs");
  const kids = [], clients = [], R = { dir };
  const pidOf = () => { try { return Number(fs.readFileSync(path.join(dir, "s.lock", "pid"), "utf8")); } catch { return 0; } };
  const bridgeClient = async (name, args = []) => {
    const c = new Client({ name, version: "1" });
    c.changes = 0; c.setNotificationHandler((await import("@modelcontextprotocol/sdk/types.js")).ToolListChangedNotificationSchema, () => { c.changes++; });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [bridge, ...args], env: { ...env, GHIDORITA_APP_CMD: launcher }, stderr: "inherit" }));
    clients.push(c); return c;
  };
  const call = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }); return { text: text(r), error: !!r.isError }; };
  const hasProgram = async (c) => { const s = await call(c, "status"); return !s.error && /Program: \S/.test(s.text) && !/none open/.test(s.text) ? s.text : null; };
  try {
    // ---- 1: two bridges, one host ----
    const a = await bridgeClient("agent-a", ["--headless", "/bin/ls"]);
    const first = await call(a, "status");
    check(/not running/.test(first.text) && /without a window/.test(first.text), "the headless fallback should offer a windowless launch: " + first.text);
    check(/without a window|Asked Ghidorita/.test((await call(a, "status", { launch: true })).text), "launch");
    const status = await until(() => hasProgram(a), "the host to open /bin/ls");
    check(/Access: edit \(client agent-a#\d+\)/.test(status), "status: " + status);
    const host = pidOf(); R.hostPid = host;
    check(host > 0 && alive(host), "the lock names a live host");
    const names = (await a.listTools()).tools.map((t) => t.name);
    check(!names.includes("get_view") && !names.includes("goto"), "the host lists no window tools: " + names);
    check(names.includes("rename_variable") && names.includes("undo_agent_edit"), "tools: " + names);
    const b = await bridgeClient("agent-b"); // no flag, no launch: it simply finds the socket
    check(await until(() => hasProgram(b), "bridge B to see the program"), "B shares the program");
    check(pidOf() === host, "still one host");

    const list = await call(a, "list_functions", { limit: 40 });
    const VAR = /\b([a-z]{1,3}Var\d+|local_[0-9a-f]+|param_\d+)\b/;
    let entry, old;
    for (const row of list.text.split("\n").filter((l) => /^0x[0-9a-f]+\s/i.test(l))) {
      const e = row.trim().split(/\s+/)[0], d = await call(a, "decompile", { function: e }), m = !d.error && d.text.match(VAR);
      if (m) { entry = e; old = m[1]; break; }
    }
    check(entry, "no function with a variable");
    await call(a, "wait_for_analysis", { timeoutSecs: 60 }); // the program opened with its analysis running; edits wait for it
    const ren = await call(a, "rename_variable", { function: entry, variable: old, newName: "agent_counter" });
    check(!ren.error, ren.text);
    const seen = await call(b, "status");
    check(/Edits: unsaved, last: Rename variable/.test(seen.text), "B sees A's edit: " + seen.text);
    const refused = await call(b, "undo_agent_edit");
    check(refused.error && /agent-a/.test(refused.text), "B must not undo A's edit: " + refused.text);
    check(/agent_counter/.test((await call(b, "decompile", { function: entry })).text), "B reads A's rename");
    R.entry = entry;

    // ---- 2: the last bridge leaves; the host goes after its grace period ----
    await b.close(); await sleep(3500);
    check(alive(host), "one bridge is left: the host stays");
    await a.close();
    await until(() => !alive(host), "the host to exit after the last client", 20_000);
    check(!fs.existsSync(sock) && !fs.existsSync(sock + ".ctl") && !fs.existsSync(sock + ".lock"), "the host removes its socket, control socket and lock: " + fs.readdirSync(dir));
    R.graceExit = true;

    // ---- 3: a host again, then the app takes over ----
    const c1 = await bridgeClient("agent-c", ["--headless", "/bin/ls"]), c2 = await bridgeClient("agent-d", ["--headless"]);
    await call(c1, "status", { launch: true });
    check(await until(() => hasProgram(c1), "the second host"), "second host has the program");
    check(await until(() => hasProgram(c2), "bridge D"), "D joined it");
    const host2 = pidOf(); check(host2 !== host && alive(host2), "a new host");
    const li = await call(c1, "list_functions", { limit: 40 });
    let e2, v2;
    for (const row of li.text.split("\n").filter((l) => /^0x[0-9a-f]+\s/i.test(l))) { const e = row.trim().split(/\s+/)[0], d = await call(c1, "decompile", { function: e }), m = !d.error && d.text.match(VAR); if (m) { e2 = e; v2 = m[1]; break; } }
    await call(c1, "wait_for_analysis", { timeoutSecs: 60 });
    check((await call(c1, "rename_variable", { function: e2, variable: v2, newName: "before_handover" })).text.includes("Renamed"), "edit before the handover");
    const changes0 = c1.changes;

    let app, stop;
    if (standIn) ({ app, stop } = await startStandIn(sock, dir, env)); // a main-process stand-in: no window
    else app = spawn(electron, [appDir, `--user-data-dir=${ud}`], { env, stdio: ["ignore", "ignore", "pipe"], detached: false });
    kids.push(app);
    await until(() => !alive(host2), "the host to quit when the app starts", 150_000);
    const lines = fs.readFileSync(log, "utf8");
    check(/handover: saved=true/.test(lines), "the host logs a confirmed save in its handover (both takeover variants): " + lines.slice(-400));
    // both bridges follow the app (retry, replay of initialize, list_changed), and calls work again
    await until(() => c1.changes > changes0, "bridge C to follow the app", 60_000);
    const onApp = await until(async () => { const s = await call(c2, "status"); return !s.error && /Access: edit/.test(s.text) ? s.text : null; }, "calls through the app", 120_000);
    check(pidOf() === app.pid || standIn, "the lock names the app");
    check(!/starting|not running/.test(onApp), onApp);
    R.takeover = standIn ? "stand-in" : "app"; R.afterTakeover = onApp.split("\n")[1] ?? "";
    app.kill("SIGTERM"); await stop?.();
    await until(() => !alive(app.pid), "the app to stop", 30_000).catch(() => app.kill("SIGKILL"));
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    for (const k of kids) try { k.kill("SIGKILL"); } catch { /* gone */ }
    const p = pidOf(); if (p && alive(p)) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    if (!o.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
  return R;
}

/** The part of the app's startup that matters for a handover, run in Node: claim the socket (the host quits), then main's agent server on it. */
async function startStandIn(sock, dir, env) {
  const { build } = await import("esbuild");
  const file = path.join(dir, "standin.mjs");
  const src = `import { claimSocket } from ${JSON.stringify(path.join(appDir, "src/main/hostControl.ts"))}; import { createAgent } from ${JSON.stringify(path.join(appDir, "src/main/agent.ts"))};
    const place = { path: ${JSON.stringify(sock)}, ownDir: null };
    const claim = await claimSocket(place, { log: console.error });
    if (!claim.lock) { console.error("no lock", claim); process.exit(2); }
    const replies = [];
    const ag = createAgent({ send: (ch, p) => { if (ch === "agent-call") setTimeout(() => ag.reply({ callId: p.callId, ok: true, content: "Access: edit (client stand-in)\\nProgram: none open. Ask the user to open one." }), 10); }, settingsFile: ${JSON.stringify(path.join(dir, "standin.json"))}, socket: place, lock: claim.lock, env: { GHIDORITA_AGENT_MODE: "edit" }, headless: false });
    await ag.start(); ag.setReady(true); console.error("stand-in listening");
    process.on("SIGTERM", () => ag.stop().then(() => { claim.lock.release(); process.exit(0); }));
    setInterval(() => {}, 1000);`;
  const out = path.join(dir, "standin.mjs");
  await build({ stdin: { contents: src, resolveDir: appDir, loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: out, banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, logLevel: "silent" });
  const p = spawn(process.execPath, [out], { env, stdio: ["ignore", "ignore", "inherit"] });
  return { app: p, stop: async () => {} };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHeadless({ standIn: process.argv.includes("--stand-in"), keep: process.argv.includes("--keep") }).then((r) => { console.log(JSON.stringify({ ok: true, ...r })); process.exit(0); }, (e) => { console.error(e.stack ?? e); console.log(JSON.stringify({ ok: false, error: String(e.message ?? e) })); process.exit(1); });
}

// stdio <-> app socket bridge (docs/AGENTS_MCP.md "Bridge"). A byte pipe while the app is there; otherwise it answers for the app and keeps retrying.
// It never launches the app by itself: only the fallback's `status {launch:true}` does. It exits only when stdin ends. `--no-launch` is accepted and ignored.
// `--headless [binary]`: that launch starts the headless host (`Ghidorita --agent-host [--open=<binary>]`, no window) instead of the app.
import net from "node:net";
import path from "node:path";
import { lstatSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { INSTRUCTIONS } from "../agent/instructions";
import { agentSocketPath, socketProblem } from "../agent/socketPath";

const sockPath = agentSocketPath();
const retryMs = Number(process.env.GHIDORITA_RETRY_MS) || 2000;
const HANDOVER_MS = 10_000;
const MAX_PENDING = 10_000;
const headless = process.argv.includes("--headless");
const binary = headless ? process.argv.slice(2).find((a) => !a.startsWith("-")) : undefined; // opened by the host when this bridge is what starts it
const log = (s: string) => process.stderr.write(`ghidorita-mcp: ${s}\n`);

type Msg = { id?: unknown; method?: string; result?: { protocolVersion?: unknown }; error?: unknown; params?: { protocolVersion?: string; name?: string; arguments?: { launch?: unknown } } };
const parse = (b: Buffer): Msg | null => { try { const m = JSON.parse(b.toString()); return m && typeof m === "object" ? m : null; } catch { return null; } };
const hasId = (m: Msg) => m.id !== undefined && m.id !== null;

// The fallback negotiates like the app's SDK Server (the version itself if supported, else the latest), so the app's reply to the replayed initialize matches what the client was told.
// Keep in sync with SUPPORTED_PROTOCOL_VERSIONS of @modelcontextprotocol/sdk (test/agent-bridge.test.mjs checks).
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const MAX_LINE = 64 << 20;
/** Splits a byte stream into lines (newline kept) without touching the bytes. Linear: a chunk is scanned once. A line over MAX_LINE is dropped. */
function framer(onLine: (l: Buffer) => void) {
  let chunks: Buffer[] = [], size = 0, skipping = false;
  return {
    push(d: Buffer) {
      let start = 0;
      for (let i; (i = d.indexOf(10, start)) >= 0; start = i + 1) {
        const tail = d.subarray(start, i + 1);
        if (skipping) { skipping = false; continue; }
        const l = chunks.length ? Buffer.concat([...chunks, tail]) : tail;
        chunks = []; size = 0; onLine(l);
      }
      const rest = d.subarray(start);
      if (rest.length && !skipping) { chunks.push(rest); size += rest.length; if (size > MAX_LINE) { log("dropped a line over 64 MB"); chunks = []; size = 0; skipping = true; } }
    },
    rest: () => Buffer.concat(chunks),
  };
}

let launchedAt = 0;
const shq = (a: string) => "'" + a.replace(/'/g, "'\\''") + "'";
/** What starts the host or the app; null when this platform cannot be asked to. */
function launchCommand(o: { headless: boolean; binary?: string; env: NodeJS.ProcessEnv; platform: string; electron: boolean; execPath: string }): { cmd: string; args: string[]; shell: boolean; env?: NodeJS.ProcessEnv } | null {
  const host = o.headless ? ["--agent-host", ...(o.binary ? [`--open=${path.resolve(o.binary)}`] : [])] : [];
  if (o.env.GHIDORITA_APP_CMD) return { cmd: [o.env.GHIDORITA_APP_CMD, ...host.map(shq)].join(" "), args: [], shell: true };
  // packaged: this bridge runs inside the app's own executable (ELECTRON_RUN_AS_NODE), which can start itself without LaunchServices swallowing the flag
  if (o.headless && o.electron) { const env = { ...o.env }; delete env.ELECTRON_RUN_AS_NODE; return { cmd: o.execPath, args: host, shell: false, env }; }
  if (o.platform === "darwin") return { cmd: "open", args: ["-b", "li.jankowski.ghidorita", ...(host.length ? ["--args", ...host] : [])], shell: false };
  return null;
}
/** whether a launch was attempted; a repeat within 15 s is not another process (a custom command may not be idempotent) */
function startApp(): boolean {
  if (Date.now() - launchedAt < 15_000) return true;
  launchedAt = Date.now();
  const c = launchCommand({ headless, binary, env: process.env, platform: process.platform, electron: !!process.versions.electron, execPath: process.execPath });
  const child = c ? spawn(c.cmd, c.args, { shell: c.shell, detached: true, stdio: "ignore", ...(c.env ? { env: c.env } : {}) }) : null;
  child?.on("error", (e) => log(`could not start Ghidorita: ${e.message}`)).unref();
  return !!child;
}

const HOW = headless ? "Call status with launch: true to start Ghidorita without a window (the tools appear here when it is ready). The user must have Agent > Access turned on in Ghidorita; the headless host has no menu, so they open the app for that (it takes over from the host)."
  : "Call status with launch: true to start it (the tools appear here when it is ready). The user must have Agent > Access turned on in Ghidorita.";
const NOT_RUNNING = `Ghidorita is not running. ${HOW}`;
const STARTED = headless ? "Asked Ghidorita to start without a window. This server switches to it by itself and the tools will appear when it is ready (a minute for a big program); call tools/list again or wait for the list change. Access follows the user's Agent > Access setting."
  : "Asked Ghidorita to start. This server switches to the app by itself and the tools will appear when it is ready; call tools/list again or wait for the list change. The user must have Agent > Access turned on in Ghidorita.";
const NO_LAUNCH = "Ghidorita is not running and cannot be started from here. Ask the user to start it and turn on Agent > Access.";
const INITIALIZED = Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

// "queue": deciding (first connect attempt, or replaying initialize to a fresh connection); client lines wait. "fallback": answering for the app. "pipe": bytes go through.
let phase: "queue" | "fallback" | "pipe" = "queue";
let app: net.Socket | null = null, attempting: net.Socket | null = null;
let queue: Buffer[] = [];
let initLine: Buffer | null = null, initId: unknown, initialized = false, closing = false;
let toldVersion: string | null = null; // the protocolVersion the client was told in its initialize reply (by the fallback, or by the app in the first pipe)
let mismatchLogged = false;
let owesListChanged = false; // the app took over before the client sent notifications/initialized: tell it once it has
let timer: NodeJS.Timeout | undefined;
const pending = new Set<unknown>(); // ids sent to the app and not yet answered
const out = (b: Buffer | string) => process.stdout.write(b);
const send = (id: unknown, r: { result: unknown } | { error: unknown }) => out(JSON.stringify({ jsonrpc: "2.0", id, ...r }) + "\n");
const listChanged = () => out('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n');

/** What the client said that a later connection to the app must be told again (every path that handles a client line calls this). */
function remember(m: Msg, line: Buffer) {
  if (hasId(m) && m.method === "initialize") { initLine = line; initId = m.id; }
  else if (!hasId(m) && m.method === "notifications/initialized") { initialized = true; if (owesListChanged) { owesListChanged = false; listChanged(); } }
}

function answer(line: Buffer) {
  const m = parse(line);
  if (!m) return;
  remember(m, line);
  if (!hasId(m)) return;
  switch (m.method) {
    case "initialize": toldVersion = SUPPORTED_VERSIONS.includes(m.params?.protocolVersion as string) ? (m.params!.protocolVersion as string) : SUPPORTED_VERSIONS[0]; return send(m.id, { result: { protocolVersion: toldVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "ghidorita", version: "0.0.0" }, instructions: `${NOT_RUNNING}\n\n${INSTRUCTIONS}` } });
    case "ping": return send(m.id, { result: {} });
    case "tools/list": return send(m.id, { result: { tools: [{ name: "status", description: "Report whether Ghidorita is running; with launch: true, ask it to start.", inputSchema: { type: "object", properties: { launch: { type: "boolean", description: "Start Ghidorita if it is not running" } } } }] } });
    case "tools/call": {
      if (m.params?.name !== "status") return send(m.id, { error: { code: -32602, message: `Unknown tool: ${m.params?.name}. ${NOT_RUNNING}` } });
      const text = refused ? `Ghidorita's agent socket was not used: ${refused}. Ask the user to fix its owner and permissions (or remove the file).`
        : m.params.arguments?.launch === true ? (startApp() ? STARTED : NO_LAUNCH) : NOT_RUNNING;
      return send(m.id, { result: { content: [{ type: "text", text }] } });
    }
    default: return send(m.id, { error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

function toApp(line: Buffer) {
  const m = parse(line);
  if (m) remember(m, line);
  if (m && hasId(m) && typeof m.method === "string" && pending.size < MAX_PENDING) pending.add(m.id);
  app?.write(line);
}

function startPipe() {
  phase = "pipe";
  const q = queue; queue = [];
  q.forEach(toApp);
}

function onAppLine(line: Buffer) {
  const m = parse(line);
  if (phase === "queue") { // replaying initialize: the client already has the fallback's reply
    if (m && m.id === initId && m.method === undefined && hasId(m)) {
      clearTimeout(timer);
      const theirs = m.result?.protocolVersion;
      if (toldVersion !== null && theirs !== toldVersion) { // the client's session was negotiated at another version: piping it to this app would be a mismatched session
        if (!mismatchLogged) { mismatchLogged = true; log(`the app answers initialize with ${m.error ? "an error" : `protocol version ${String(theirs)}`}, but the client was told ${toldVersion}; staying in the "not running" fallback`); }
        return void app?.destroy(); // close -> lost(): back to the fallback (and the retry); the client keeps its working session
      }
      if (initialized) { app?.write(INITIALIZED); listChanged(); } else owesListChanged = true;
      return startPipe();
    }
  } else if (m && hasId(m) && m.method === undefined) {
    pending.delete(m.id);
    if (toldVersion === null && m.id === initId && typeof m.result?.protocolVersion === "string") toldVersion = m.result.protocolVersion; // the app answered the client's own initialize
  }
  out(line);
}

function lost(s: net.Socket) {
  if (s !== app || closing) return;
  const was = phase;
  app = null; phase = "fallback"; owesListChanged = false; clearTimeout(timer);
  if (was === "pipe") {
    for (const id of pending) send(id, { error: { code: -32000, message: "Ghidorita closed the connection; the call did not complete. Ask the user to start Ghidorita again" } });
    pending.clear();
    if (initialized) listChanged();
  }
  const q = queue; queue = [];
  q.forEach(answer);
  timer = setTimeout(attempt, retryMs);
}

function adopt(s: net.Socket) {
  app = s;
  s.on("error", () => {}).on("close", () => lost(s));
  const fr = framer(onAppLine);
  s.on("data", fr.push);
  if (!initLine) return startPipe();
  phase = "queue";
  s.write(initLine);
  timer = setTimeout(() => s.destroy(), HANDOVER_MS); // an app that never answers initialize
}

let refused = "", warned = "";
/** A socket that is not ours (owner, mode) is not connected to: a path in a shared directory can hold someone else's server. */
function refusal(): string | null {
  const why = socketProblem(sockPath, (p, follow) => { try { return follow ? statSync(p) : lstatSync(p); } catch { return null; } });
  if (why !== (warned || null)) { warned = why ?? ""; if (why) log(`not connecting: ${why}`); }
  return why;
}
function attempt() {
  if (closing) return;
  const bad = refusal();
  if (bad) { refused = bad; if (phase === "queue") { phase = "fallback"; const q = queue; queue = []; q.forEach(answer); } timer = setTimeout(attempt, retryMs); return; }
  refused = "";
  const s = attempting = net.connect(sockPath);
  s.once("connect", () => { attempting = null; s.removeAllListeners("error"); closing ? s.destroy() : adopt(s); });
  s.once("error", () => { // ENOENT, or ECONNREFUSED from a stale socket file
    attempting = null; s.destroy();
    if (phase === "queue") { phase = "fallback"; const q = queue; queue = []; q.forEach(answer); }
    if (!closing) timer = setTimeout(attempt, retryMs);
  });
}

const fr = framer((l) => phase === "pipe" ? toApp(l) : phase === "fallback" ? answer(l) : queue.push(l));
process.stdin.on("data", fr.push).on("end", () => {
  clearTimeout(timer);
  const last = fr.rest(); // a final line without its newline still counts
  if (last.length) { const l = Buffer.concat([last, Buffer.from("\n")]); phase === "pipe" ? toApp(l) : phase === "fallback" ? answer(l) : queue.push(l); }
  if (phase === "queue" && !app) { phase = "fallback"; const q = queue; queue = []; q.forEach(answer); } // deciding when stdin ended: answer what is waiting
  closing = true; attempting?.destroy();
  if (app) app.end(() => app?.destroy());
});
attempt();

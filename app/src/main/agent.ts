import net from "node:net";
import path from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Capability } from "../../../protocol";
import { ACCESS_MODES, modeAllows, type AccessMode, type AgentCall, type AgentCancel, type AgentState, type ToolDef } from "../agent/types";
import { TOOLS } from "../agent/tools/index";
import { visibleTools } from "../agent/access";
import { INSTRUCTIONS } from "../agent/instructions";
import { agentSocketPlace, type SocketPlace } from "../agent/socketPath";

// The MCP server of the app (docs/AGENTS_MCP.md): it owns the access mode and every trust decision, the renderer only executes.
// No electron import: index.ts wires ipcMain, the window and userData in through AgentOpts, so the tests run this in plain Node.

export const REPLY_MAX = 200_000, ERROR_MAX = 4_000, MARGIN_MS = 10_000, NOT_READY = "Ghidorita's window is not ready (starting, reloading or showing an error). Try again in a moment.";
/** Agent calls share the renderer's one sidecar connection (64 outstanding requests): a flood of parallel calls must not stall the UI. Over the limit is an immediate error, never a queue. */
export const MAX_CALLS_PER_CONNECTION = 8, MAX_CALLS_TOTAL = 16;
const HOW_TO_ENABLE = "Agent access is off. Ask the user to choose Agent > Access > Read or Edit in Ghidorita's menu, then call status again.";

export { visibleTools };

export interface AgentOpts {
  /** main -> renderer; must tolerate a missing window */
  send(channel: "agent-call" | "agent-cancel" | "agent-state", payload: AgentCall | AgentCancel | AgentState): void;
  settingsFile: string;
  socket?: SocketPlace;
  version?: string;
  table?: readonly ToolDef[];
  headless?: boolean;
  capabilities?: () => ReadonlySet<Capability> | undefined;
  marginMs?: number;
  env?: NodeJS.ProcessEnv;
  /** a packaged app ignores GHIDORITA_AGENT_MODE: whoever can start the binary must not be able to grant access without the user's menu click */
  ignoreEnvMode?: boolean;
  log?: (msg: string) => void;
}
interface Conn { server: Server; sock: net.Socket; id: string | null; calls: Set<string> } // id: `<client name>#<n>`, set once the client has initialized
interface Pending { conn: Conn; tool: ToolDef; settle(r: ToolResult): void; timer: NodeJS.Timeout }
type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true as const } : {}) });
export const cleanName = (s: unknown): string => (typeof s === "string" ? s.replace(/[\p{C}\p{Z}]+/gu, " ").trim().slice(0, 60).trim() : "") || "agent";
const asMode = (v: unknown): AccessMode | null => (ACCESS_MODES as readonly unknown[]).includes(v) ? (v as AccessMode) : null;

export function loadMode(file: string): AccessMode {
  try { return asMode((JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown } | null)?.mode) ?? "off"; } catch { return "off"; }
}

/** The text Help > Copy Agent Setup puts on the clipboard, with the real command. */
export function setupText(p: { packaged: boolean; resourcesPath: string; appDir: string }): string {
  const [cmd, ...args] = p.packaged ? [path.join(p.resourcesPath, "mcp", "ghidorita-mcp")] : ["node", path.join(p.appDir, "out", "mcp", "bridge.cjs")];
  const q = (s: string) => JSON.stringify(s);
  return [`# Claude Code`, `claude mcp add ghidorita -- ${[cmd, ...args].map(q).join(" ")}`, ``,
    `# Codex: add to ~/.codex/config.toml`, `[mcp_servers.ghidorita]`, `command = ${q(cmd)}`, ...(args.length ? [`args = [${args.map(q).join(", ")}]`] : []),
    `tool_timeout_sec = 300   # a slow tool (decompile, wait_for_analysis) answers within about 270 s; Codex's default of 60 would cut it off`, ``].join("\n");
}

export function createAgent(o: AgentOpts) {
  const log = o.log ?? ((m) => console.error("agent:", m));
  const table = o.table ?? TOOLS, place = o.socket ?? agentSocketPlace(), win32 = process.platform === "win32", margin = o.marginMs ?? MARGIN_MS;
  const envMode = o.ignoreEnvMode ? null : asMode((o.env ?? process.env).GHIDORITA_AGENT_MODE);
  let mode: AccessMode = envMode ?? loadMode(o.settingsFile);
  let caps: ReadonlySet<Capability> | undefined; // the provider's, from the renderer's menu-state; unknown = no gating yet
  let ready = false, seq = 0, connSeq = 0, listener: net.Server | null = null, owned = false;
  const conns = new Set<Conn>(), pending = new Map<string, Pending>(), changed = new Set<() => void>();
  const validators = new WeakMap<ToolDef, (a: unknown) => { valid: boolean; errorMessage?: string }>();
  const ajv = new AjvJsonSchemaValidator();
  const clients = () => [...conns].flatMap((c) => (c.id ? [c.id] : []));
  const state = (): AgentState => ({ mode, clients: clients() });
  const publish = () => { o.send("agent-state", state()); for (const f of changed) f(); };
  const visible = () => visibleTools(mode, { headless: o.headless, capabilities: caps ?? o.capabilities?.() }, table);

  function end(callId: string, r: ToolResult, cancel: boolean) {
    const p = pending.get(callId);
    if (!p) return;
    pending.delete(callId); p.conn.calls.delete(callId); clearTimeout(p.timer);
    p.settle(r);
    if (cancel) try { o.send("agent-cancel", { callId }); } catch { /* the window is gone: nothing to cancel */ }
  }
  const failAll = (why: string) => { for (const id of [...pending.keys()]) end(id, text(why, true), true); };

  function denied(name: string): string | null {
    const t = table.find((x) => x.name === name);
    if (!t) return `Unknown tool "${name}". Call tools/list for the tools available now.`;
    if (visible().includes(t)) return null;
    if (mode === "off") return HOW_TO_ENABLE;
    if (t.appOnly && o.headless) return `"${name}" needs Ghidorita's window and is not available in headless mode.`;
    if (!modeAllows(mode, t.access)) return `Agent access is ${mode}; "${name}" needs ${t.access} mode. The user can change it in the Agent menu (Agent > Access).`;
    if (t.capability && !(caps ?? o.capabilities?.())) return `"${name}" is not available yet: Ghidorita has not reported what its analysis backend supports (it is still starting). Try again in a moment; the tool list changes once it is known.`;
    return `"${name}" is not available: the current backend does not support it.`;
  }

  function call(conn: Conn, name: string, rawArgs: unknown, signal: AbortSignal): Promise<ToolResult> {
    const bad = denied(name);
    if (bad) return Promise.resolve(text(bad, true));
    const t = table.find((x) => x.name === name)!;
    if (mode === "off") return Promise.resolve(text(HOW_TO_ENABLE)); // only `status` is visible in off mode; main answers it itself
    const args = rawArgs ?? {};
    let v = validators.get(t);
    if (!v) validators.set(t, v = ajv.getValidator(t.inputSchema as never));
    const check = v(args);
    if (!check.valid || typeof args !== "object" || Array.isArray(args)) return Promise.resolve(text(`Invalid arguments for ${name}: ${check.errorMessage ?? "expected an object"}`, true));
    if (!ready) return Promise.resolve(text(NOT_READY, true));
    const id = conn.id;
    if (!id) return Promise.resolve(text("Send notifications/initialized after initialize before calling tools.", true));
    if (conn.calls.size >= MAX_CALLS_PER_CONNECTION || pending.size >= MAX_CALLS_TOTAL) return Promise.resolve(text(`Too many calls in flight (at most ${MAX_CALLS_PER_CONNECTION} per connection, ${MAX_CALLS_TOTAL} in all); wait for some to finish, then retry.`, true));
    // a caller-raised timeoutSecs (decompile, xrefs) must not be cut off by the tool's default limit
    const asked = (args as { timeoutSecs?: unknown }).timeoutSecs;
    const secs = Math.max(t.timeoutSecs, typeof asked === "number" ? asked + 30 : 0);
    const callId = `${++seq}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<ToolResult>((settle) => {
      const timer = setTimeout(() => end(callId, text(`${name} timed out after ${secs} s. It was cancelled; retry with a smaller request or a longer timeoutSecs if the tool has one.`, true), true), secs * 1000 + margin);
      pending.set(callId, { conn, tool: t, settle, timer }); conn.calls.add(callId);
      const onAbort = () => end(callId, text("cancelled", true), true);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      o.send("agent-call", { callId, tool: name, args: args as Record<string, unknown>, client: id, mode, timeoutSecs: secs });
    });
  }

  function accept(sock: net.Socket) {
    const server = new Server({ name: "ghidorita", version: o.version ?? "0.0.0" }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS });
    const conn: Conn = { server, sock, id: null, calls: new Set() };
    conns.add(conn);
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: visible().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) }));
    server.setRequestHandler(CallToolRequestSchema, (req, extra) => call(conn, req.params.name, req.params.arguments, extra.signal));
    server.oninitialized = () => { conn.id = `${cleanName(server.getClientVersion()?.name)}#${++connSeq}`; publish(); };
    server.onclose = () => {
      if (!conns.delete(conn)) return;
      for (const id of [...conn.calls]) end(id, text("the agent disconnected", true), true);
      sock.destroy(); publish();
    };
    sock.on("error", () => {});
    sock.on("close", () => { server.close().catch(() => {}); });
    server.connect(new StdioServerTransport(sock, sock)).catch((e) => { log(`connection failed: ${e}`); sock.destroy(); });
  }

  /** "alive": something answers; "stale": a dead socket file; "foreign": not ours to touch */
  const probe = (p: string) => new Promise<"alive" | "stale" | "foreign">((resolve) => {
    const s = net.connect(p), t = setTimeout(() => { s.destroy(); resolve("alive"); }, 1500);
    s.on("connect", () => { clearTimeout(t); s.destroy(); resolve("alive"); });
    s.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(t); resolve(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "stale" : "foreign"); });
  });

  function checkDir(dir: string): boolean {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (win32) return true;
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || (process.getuid && st.uid !== process.getuid())) { log(`not listening: ${dir} is a symlink or not ours`); return false; }
    chmodSync(dir, 0o700);
    if (lstatSync(dir).mode & 0o077) { log(`not listening: ${dir} is accessible to others`); return false; }
    return true;
  }

  async function start(): Promise<void> {
    if (listener) return;
    try {
      if (place.ownDir && !checkDir(place.ownDir)) return;
      if (!win32 && existsSync(place.path)) {
        if (!lstatSync(place.path).isSocket()) { log(`not listening: ${place.path} exists and is not a socket`); return; }
        if (await probe(place.path) !== "stale") { log("not listening: another Ghidorita owns the agent socket"); return; }
        unlinkSync(place.path);
      }
    } catch (e) { log(`not listening: ${e}`); return; }
    const srv = net.createServer(accept);
    const oldMask = win32 ? 0 : process.umask(0o077);
    try {
      await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(place.path, () => { srv.off("error", reject); resolve(); }); });
    } catch (e) {
      log((e as NodeJS.ErrnoException).code === "EADDRINUSE" ? "not listening: another Ghidorita owns the agent socket" : `not listening: ${e}`);
      return;
    } finally { if (!win32) process.umask(oldMask); }
    srv.on("error", (e) => log(`socket error: ${e}`));
    if (!win32) try { chmodSync(place.path, 0o600); } catch (e) { log(`chmod failed: ${e}`); }
    listener = srv; owned = true;
  }

  async function stop(): Promise<void> {
    const srv = listener; listener = null;
    failAll("Ghidorita is quitting");
    for (const c of [...conns]) { c.sock.destroy(); c.server.onclose?.(); }
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
    if (owned && !win32) try { unlinkSync(place.path); } catch { /* net already removed it */ }
    owned = false;
  }

  return {
    start, stop, visibleTools: visible, clients, state, onChange: (f: () => void) => { changed.add(f); },
    mode: () => mode,
    /** the provider's capabilities: a tool that needs one it lacks isn't offered; clients re-list when the set changes */
    setCapabilities(c: ReadonlySet<Capability>) {
      if (caps && caps.size === c.size && [...c].every((x) => caps!.has(x))) return;
      caps = c;
      for (const k of conns) k.server.sendToolListChanged().catch(() => {});
    },
    setMode(m: AccessMode) {
      if (!asMode(m) || m === mode) return;
      mode = m;
      if (!envMode) try { const tmp = o.settingsFile + ".tmp"; mkdirSync(path.dirname(o.settingsFile), { recursive: true }); writeFileSync(tmp, JSON.stringify({ mode })); renameSync(tmp, o.settingsFile); } catch (e) { log(`saving the mode failed: ${e}`); }
      for (const c of conns) c.server.sendToolListChanged().catch(() => {});
      // the kill switch: running calls whose tool the new mode no longer offers are cancelled (the sidecar may still finish a request already sent)
      const offered = new Set(visible());
      for (const [id, p] of [...pending]) if (!offered.has(p.tool)) end(id, text(`Agent access was changed to ${mode}; this call was cancelled.`, true), true);
      publish();
    },
    /** the renderer's "agent-ready"; false (window loading, crashed, closed) fails every pending call */
    setReady(r: boolean) {
      if (r === ready) return;
      ready = r;
      if (r) o.send("agent-state", state()); else failAll("the window reloaded");
    },
    /** the renderer's "agent-reply": validate everything, ignore what isn't pending */
    reply(raw: unknown) {
      const r = raw as { callId?: unknown; ok?: unknown; content?: unknown; error?: unknown } | null;
      if (!r || typeof r !== "object" || typeof r.callId !== "string" || typeof r.ok !== "boolean" || !pending.has(r.callId)) return;
      if (r.ok && typeof r.content === "string") end(r.callId, text(r.content.slice(0, REPLY_MAX)), false);
      else if (!r.ok && typeof r.error === "string") end(r.callId, text(r.error.slice(0, ERROR_MAX), true), false);
    },
    pendingCount: () => pending.size,
  };
}
export type Agent = ReturnType<typeof createAgent>;

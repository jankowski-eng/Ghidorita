// stdio <-> app socket byte pipe (docs/AGENTS_MCP.md "Bridge"). Never parses MCP, except to answer for the app when it isn't there.
import net from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { agentSocketPath } from "../agent/socketPath";

const launch = !process.argv.includes("--no-launch");
const sockPath = agentSocketPath();
const timeoutMs = Number(process.env.GHIDORITA_LAUNCH_TIMEOUT_MS) || 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => process.stderr.write(`ghidorita-mcp: ${s}\n`);

const tryConnect = () => new Promise<net.Socket | null>((res) => {
  const s = net.connect(sockPath);
  s.once("connect", () => { s.removeAllListeners("error"); res(s); });
  s.once("error", () => { s.destroy(); res(null); }); // ENOENT, or ECONNREFUSED from a stale socket file
});

/** whether a launch was attempted */
function startApp(): boolean {
  const cmd = process.env.GHIDORITA_APP_CMD;
  const child = cmd ? spawn(cmd, { shell: true, detached: true, stdio: "ignore" })
    : process.platform === "darwin" ? spawn("open", ["-b", "li.jankowski.ghidorita"], { stdio: "ignore" }) : null;
  child?.on("error", (e) => log(`could not start Ghidorita: ${e.message}`)).unref();
  return !!child;
}

function pipe(s: net.Socket) {
  process.stdin.pipe(s);
  s.pipe(process.stdout, { end: false });
  process.stdin.on("end", () => s.end(() => s.destroy()));
  s.on("error", () => {});
  s.on("close", () => process.exit(0));
}

function fallback(why: string) {
  const text = `${why} Start Ghidorita (or run ghidorita-mcp with --launch), then call status again.`;
  const send = (id: unknown, r: { result: unknown } | { error: unknown }) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...r }) + "\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    let m: { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string } };
    try { m = JSON.parse(line); } catch { return; }
    if (m?.id === undefined || m.id === null) return; // notification
    switch (m.method) {
      case "initialize": return send(m.id, { result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ghidorita", version: "0.0.0" }, instructions: text } });
      case "ping": return send(m.id, { result: {} });
      case "tools/list": return send(m.id, { result: { tools: [{ name: "status", description: "Report whether Ghidorita is running.", inputSchema: { type: "object", properties: {} } }] } });
      case "tools/call": return m.params?.name === "status"
        ? send(m.id, { result: { content: [{ type: "text", text }] } })
        : send(m.id, { error: { code: -32602, message: `Unknown tool: ${m.params?.name}. ${text}` } });
      default: return send(m.id, { error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
  }).on("close", () => process.exit(0));
}

async function main() {
  let s = await tryConnect();
  if (!s && launch && startApp()) {
    log(`starting Ghidorita, waiting for ${sockPath}`);
    for (const end = Date.now() + timeoutMs; !s && Date.now() < end;) { await sleep(250); s = await tryConnect(); }
    if (!s) return fallback(`Ghidorita was started but did not open its agent socket within ${Math.round(timeoutMs / 1000)} s.`);
  }
  if (s) return pipe(s);
  fallback("Ghidorita is not running.");
}
main();

import os from "node:os";
import path from "node:path";

export interface SocketEnv { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; tmpdir: string; user: string; uid: number | null }
export interface SocketPlace {
  /** what to listen on / connect to (a Unix socket path, or a named pipe on Windows) */
  path: string;
  /** a directory main creates (0700) and checks it owns before listening; null when none is ours to create (a pipe, XDG_RUNTIME_DIR, an override) */
  ownDir: string | null;
}

const LIMIT: Partial<Record<NodeJS.Platform, number>> = { darwin: 103, linux: 107 }; // sun_path minus the NUL, in bytes
const here = (): SocketEnv => ({ env: process.env, platform: process.platform, home: os.homedir(), tmpdir: os.tmpdir(), user: os.userInfo().username, uid: process.getuid?.() ?? null });

/**
 * Where the app listens and the bridge connects (docs/AGENTS_MCP.md "Socket and auth"). `GHIDORITA_AGENT_SOCKET` overrides it for both sides.
 * A Unix path over the platform's limit falls back to a per-user directory in `os.tmpdir()` (per-user on macOS).
 * Pure: pass `at` in tests. The bridge runs without Electron, so this uses `os` only.
 */
export function agentSocketPlace(at: SocketEnv = here()): SocketPlace {
  const { env, platform } = at;
  if (env.GHIDORITA_AGENT_SOCKET) return { path: env.GHIDORITA_AGENT_SOCKET, ownDir: null };
  if (platform === "win32") return { path: `\\\\.\\pipe\\ghidorita-agent-${at.user.replace(/[^\w.-]/g, "_")}`, ownDir: null };
  let place: SocketPlace;
  if (platform === "darwin") { const dir = path.join(at.home, "Library", "Application Support", "Ghidorita"); place = { path: path.join(dir, "agent.sock"), ownDir: dir }; }
  else if (env.XDG_RUNTIME_DIR) place = { path: path.join(env.XDG_RUNTIME_DIR, "ghidorita-agent.sock"), ownDir: null };
  else { const dir = path.join(at.home, ".ghidorita"); place = { path: path.join(dir, "agent.sock"), ownDir: dir };  }
  const limit = LIMIT[platform] ?? 103;
  if (Buffer.byteLength(place.path) <= limit) return place;
  const dir = path.join(at.tmpdir, `ghidorita-${at.uid ?? at.user.replace(/[^\w.-]/g, "_")}`);
  return { path: path.join(dir, "agent.sock"), ownDir: dir };
}
export const agentSocketPath = (at?: SocketEnv): string => agentSocketPlace(at).path;

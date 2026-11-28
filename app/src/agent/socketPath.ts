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
  const limit = (LIMIT[platform] ?? 103) - 5; // room for the `.lock` and `.ctl` files next to the socket
  if (Buffer.byteLength(place.path) <= limit) return place;
  const dir = path.join(at.tmpdir, `ghidorita-${at.uid ?? at.user.replace(/[^\w.-]/g, "_")}`);
  return { path: path.join(dir, "agent.sock"), ownDir: dir };
}
export const agentSocketPath = (at?: SocketEnv): string => agentSocketPlace(at).path;

/** The host's control socket (handover) and the ownership lock sit next to the agent socket. */
export const ctlPath = (sock: string): string => sock + ".ctl";
export const lockPath = (sock: string): string => sock + ".lock";

export interface FileStat { mode: number; uid: number; isSocket(): boolean }
/**
 * Why a socket must not be trusted, or null. A path from GHIDORITA_AGENT_SOCKET or XDG_RUNTIME_DIR can sit in a shared directory, where someone else
 * may have planted a socket: it has to be ours (uid) and closed to others (no group/other bits), and its directory must not let others replace it
 * (owned by us or root, and not group/other-writable unless sticky). `stat(p, follow)` returns null for a missing file; Windows pipes (uid null) are not checked here.
 */
export function socketProblem(sock: string, stat: (p: string, follow: boolean) => FileStat | null, uid: number | null = process.getuid?.() ?? null): string | null {
  if (uid === null) return null;
  const s = stat(sock, false);
  if (s) {
    if (!s.isSocket()) return `${sock} exists and is not a socket`;
    if (s.uid !== uid) return `${sock} is not owned by the current user`;
    if (s.mode & 0o077) return `${sock} is accessible to others (mode ${(s.mode & 0o777).toString(8)})`;
  }
  const d = stat(path.dirname(sock), true);
  if (d && ((d.uid !== uid && d.uid !== 0) || ((d.mode & 0o022) && !(d.mode & 0o1000)))) return `the directory of ${sock} is owned by someone else or writable by others`;
  return null;
}

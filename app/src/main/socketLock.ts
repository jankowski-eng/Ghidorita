import net from "node:net";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lockPath } from "../agent/socketPath";

// Who may bind the agent socket (docs/AGENTS_MCP.md "Headless host"). Probe-then-unlink-then-listen is racy: two starters can both see a stale file,
// and the second one unlinks the first one's fresh socket. The lock is a directory next to the socket (mkdir is atomic); whoever holds it may unlink and bind.
// It is held for the life of the process, which is as long as its sidecar can run: so it also keeps two sidecars off the projects dir.
// A dead holder (its pid is gone) is replaced by renaming its lock away; only one racer wins that rename. No electron import: the tests run this in Node.

export interface Lock { release(): void }
/** A holder whose pid is alive but whose socket does not answer for this long is taken for a pid that was reused after a crash (a live holder listens within seconds of the lock, a sidecar start included). */
export const REUSED_PID_MS = 120_000;
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const holderOf = (dir: string): { pid: number | null; ageMs: number } | null => {
  try {
    const ageMs = Date.now() - statSync(dir).mtimeMs;
    try { const pid = Number(readFileSync(path.join(dir, "pid"), "utf8")); return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, ageMs }; } catch { return { pid: null, ageMs }; }
  } catch { return null; }
};
/** age of the current lock in ms, or null when nobody holds it */
export const lockAge = (sock: string): number | null => holderOf(lockPath(sock))?.ageMs ?? null;

/** the lock, or null when a live process holds it. `answers(sock)` says whether something listens on the socket (used only to tell a reused pid from a live holder). Throws when the directory cannot be written. */
export async function acquireLock(sock: string, o: { answers?(sock: string): Promise<boolean>; pid?: number } = {}): Promise<Lock | null> {
  if (process.platform === "win32") return { release() {} }; // a named pipe cannot be bound twice (EADDRINUSE): that is the lock
  const dir = lockPath(sock), pid = o.pid ?? process.pid;
  for (let tries = 0; tries < 4; tries++) {
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const h = holderOf(dir);
      if (h) {
        const live = h.pid === null ? h.ageMs < 5000 : isAlive(h.pid); // no pid yet: its creator is between mkdir and write
        if (live && !(h.ageMs > REUSED_PID_MS && o.answers && !(await o.answers(sock)))) return null;
      }
      const old = `${dir}.old.${pid}`;
      try { renameSync(dir, old); } catch { continue; } // someone else replaced it first: look again
      rmSync(old, { recursive: true, force: true });
      continue;
    }
    writeFileSync(path.join(dir, "pid"), String(pid));
    let held = true;
    return { release() { if (held) { held = false; rmSync(dir, { recursive: true, force: true }); } } };
  }
  return null;
}

import net from "node:net";
import { chmodSync, existsSync, lstatSync, statSync, unlinkSync } from "node:fs";
import { ctlPath, socketProblem, type SocketPlace } from "../agent/socketPath";
import { acquireLock, lockAge, type Lock } from "./socketLock";

// The handover protocol (docs/AGENTS_MCP.md "Headless host"). A second socket `<agent socket>.ctl`, same permissions as the agent socket, newline-delimited JSON, not MCP:
//   app  -> host: {"op":"handover"}
//   host -> app : {"ok":true,"pid":N}                              right away: the host is quitting
//   host -> app : {"done":true,"saved":bool,"saveError"?:string}   once its agent socket is closed, its edits saved and its sidecar exited
// "done" is the app's go-ahead to start its own sidecar on the projects dir.

export interface HandoverResult { saved: boolean; saveError?: string }
const MAX_LINE = 1024;
export const HANDOVER_MAX_MS = 150_000; // the host's sidecar may take 60 s to save, then 60 s more before it is killed
const stat = (p: string, follow: boolean) => { try { return follow ? statSync(p) : lstatSync(p); } catch { return null; } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const probeSocket = (p: string) => new Promise<boolean>((resolve) => {
  const s = net.connect(p), t = setTimeout(() => { s.destroy(); resolve(true); }, 1500);
  s.on("connect", () => { clearTimeout(t); s.destroy(); resolve(true); });
  s.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(t); resolve(e.code !== "ECONNREFUSED" && e.code !== "ENOENT"); });
});

/** The host's side. The caller holds the socket lock, so a file at the path is stale. */
export async function serveControl(sock: string, onHandover: () => Promise<HandoverResult>, log: (m: string) => void, afterReply?: () => void): Promise<{ close(): Promise<void> }> {
  const p = ctlPath(sock), win32 = process.platform === "win32";
  if (!win32 && existsSync(p)) {
    const bad = socketProblem(p, stat);
    if (bad) throw new Error(bad);
    unlinkSync(p);
  }
  let run: Promise<HandoverResult> | null = null;
  const srv = net.createServer((c) => {
    c.on("error", () => {});
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if ((nl < 0 ? buf.length : nl) > MAX_LINE) return void c.destroy(); // a complete line counts too
      if (nl < 0) return; // a request split across data events: wait for its newline
      let req: { op?: unknown } | null = null;
      try { req = JSON.parse(buf.slice(0, nl)); } catch { /* answered below */ }
      buf = "";
      if (req?.op !== "handover") return void c.end(JSON.stringify({ ok: false, error: "unknown request" }) + "\n");
      c.write(JSON.stringify({ ok: true, pid: process.pid }) + "\n");
      run ??= onHandover().catch((e): HandoverResult => ({ saved: false, saveError: String(e?.message ?? e) }));
      void run.then((r) => c.end(JSON.stringify({ done: true, ...r }) + "\n", () => afterReply?.())); // the host may exit once the answer is out
    });
  });
  const oldMask = win32 ? 0 : process.umask(0o077);
  try { await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(p, () => { srv.off("error", reject); resolve(); }); }); }
  finally { if (!win32) process.umask(oldMask); }
  srv.on("error", (e) => log(`control socket error: ${e}`));
  if (!win32) try { chmodSync(p, 0o600); } catch { /* the umask already made it 0600 */ }
  let closing: Promise<void> | null = null; // once: a second call must not unlink a successor's socket at the same path
  return { close: () => closing ??= new Promise<void>((r) => { srv.close(() => r()); if (!win32) try { unlinkSync(p); } catch { /* gone */ } }) };
}

export type HandoverReply = { kind: "none" } | { kind: "done"; saved: boolean; saveError?: string; pid?: number } | { kind: "failed"; error: string };
/** The app's side: ask the host to quit and wait until it says its sidecar is gone. "none": nothing answers on the control socket (no host). */
export function requestHandover(sock: string, o: { timeoutMs?: number } = {}): Promise<HandoverReply> {
  const p = ctlPath(sock);
  if (process.platform !== "win32") {
    if (!existsSync(p)) return Promise.resolve({ kind: "none" });
    const bad = socketProblem(p, stat);
    if (bad) return Promise.resolve({ kind: "failed", error: `refusing to talk to ${p}: ${bad}` });
  }
  return new Promise((resolve) => {
    const c = net.connect(p);
    let buf = "", pid: number | undefined, settled = false;
    const end = (r: HandoverReply) => { if (settled) return; settled = true; clearTimeout(t); c.destroy(); resolve(r); };
    const t = setTimeout(() => end({ kind: "failed", error: `the headless host did not quit within ${Math.round((o.timeoutMs ?? HANDOVER_MAX_MS) / 1000)} s${pid ? ` (pid ${pid})` : ""}` }), o.timeoutMs ?? HANDOVER_MAX_MS);
    c.on("connect", () => c.write(JSON.stringify({ op: "handover" }) + "\n"));
    c.on("error", (e: NodeJS.ErrnoException) => end(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? { kind: "none" } : { kind: "failed", error: String(e) }));
    c.on("data", (d) => {
      buf += d.toString();
      for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
        let m: Record<string, unknown> | null = null;
        try { m = JSON.parse(buf.slice(0, nl)); } catch { /* ignore a garbled line */ }
        buf = buf.slice(nl + 1);
        if (m?.ok === true && typeof m.pid === "number") pid = m.pid;
        else if (m?.ok === false) end({ kind: "failed", error: String(m.error ?? "refused") });
        else if (m?.done === true) end({ kind: "done", saved: m.saved === true, saveError: typeof m.saveError === "string" ? m.saveError.slice(0, 2000) : undefined, pid });
      }
    });
    // the host exited after its ack without a done (killed): its sidecar may still be saving, which the next sidecar start reports as ProjectLocked
    c.on("close", () => end(pid ? { kind: "done", saved: false, saveError: "the headless host ended without confirming its save", pid } : { kind: "none" }));
  });
}

export interface Claim { lock: Lock | null; /** the host's save failed or was not confirmed: agent edits may be lost */ saveError?: string; /** the host did not quit: never start a sidecar */ error?: string }
/**
 * What the app does before it starts its sidecar: take the socket lock, asking a headless host to quit when it holds it.
 * lock null without `error`: a live app (or something else) owns the agent socket; the app runs without one, as before.
 */
export async function claimSocket(place: SocketPlace, o: { log?: (m: string) => void; timeoutMs?: number } = {}): Promise<Claim> {
  const log = o.log ?? (() => {}), deadline = Date.now() + (o.timeoutMs ?? HANDOVER_MAX_MS);
  let saveError: string | undefined;
  for (let quiet = 0; ; ) {
    if (Date.now() > deadline) return { lock: null, saveError, error: "the agent socket stayed locked" };
    let lock: Lock | null;
    try { lock = await acquireLock(place.path, { answers: probeSocket }); } catch (e) { log(`agent socket lock failed: ${e}`); return { lock: null, saveError }; }
    if (lock) return { lock, saveError };
    const r = await requestHandover(place.path, { timeoutMs: Math.max(1000, deadline - Date.now()) });
    if (r.kind === "done") { if (!r.saved && r.saveError) saveError = r.saveError; log(`the headless host (pid ${r.pid}) quit${r.saveError ? `: ${r.saveError}` : ""}`); continue; }
    if (r.kind === "failed") return { lock: null, saveError, error: r.error };
    // nothing answers: an app, or a host that holds the lock but has not opened its control socket yet (it does so within a second of the lock)
    if ((lockAge(place.path) ?? Infinity) > 10_000 || ++quiet > 10 || Date.now() > deadline) return { lock: null, saveError };
    await sleep(300);
  }
}

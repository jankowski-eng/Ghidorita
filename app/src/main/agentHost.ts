import type { ActiveSession } from "../../../protocol";
import type { ApplicationBackend, ProgramOperations } from "../renderer/backend";
import { WebSocketBackend } from "../renderer/rpc";
import { ChangeLog } from "../renderer/changeLog";
import { changeView, createAgentExecutor } from "../agent/host";
import type { AgentReply, ToolDef } from "../agent/types";
import type { SocketPlace } from "../agent/socketPath";
import { createAgent, type Agent } from "./agent";
import { serveControl, probeSocket } from "./hostControl";
import { acquireLock } from "./socketLock";
import type { ProviderLaunch } from "./providers";

// The headless host (docs/AGENTS_MCP.md "Headless host"): the app's agent server with no window. The renderer's job is done by a Node WebSocketBackend and the shared executor.
// This file is the one place outside renderer/main.tsx that may import rpc.ts (test/backend-boundary.test.mjs). No electron import: index.ts wires it in, the tests run it in Node.

type Hooks = NonNullable<ConstructorParameters<typeof WebSocketBackend>[0]>;
export type HostBackend = ApplicationBackend & { connect(port: number, token: string): Promise<void> };

/** The executor and its state for a backend without a UI: the change log (attribution, undo_agent_edit) fed by the backend's hooks, and the active program. */
export function createHeadless(o: { reply(r: AgentReply): void; tools?: readonly ToolDef[] }) {
  const changes = new ChangeLog();
  let backend: ApplicationBackend | null = null, current: { api: ProgramOperations; session: ActiveSession } | null = null;
  const hooks: Hooks = {
    onEdit: (command, params, result) => changes.record(command, params, result),
    onSessionChanged: (s) => { changes.clear(); current = s && backend ? { api: backend.program(s), session: s } : null; },
    onHistory: (undo) => changes.reconcile(undo),
  };
  // no `ui` and no `confirm`: tools that need the window are not listed (visibleTools headless), lifecycle tools have no user program to protect
  const ex = createAgentExecutor({ tools: o.tools, get backend() { return backend!; }, program: () => current, changes: changeView(() => changes.items), host: { agentReply: async (r) => o.reply(r) } });
  return {
    hooks, changes, program: () => current, handle: ex.handle, cancel: ex.cancel, dispose: ex.dispose,
    /** after the backend is connected: adopt the session it already has (none in a fresh sidecar) */
    async bind(b: ApplicationBackend) { backend = b; const s = await b.lifecycle.active(); if (s) hooks.onSessionChanged!(s); },
  };
}

export const GRACE_MS = 30_000;
export const SAVE_MS = 60_000; // the host's own save (the sidecar's save timeout is the same)
export interface HostOpts {
  place: SocketPlace;
  settingsFile: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
  ignoreEnvMode?: boolean;
  /** how long the host stays after its last connection closed (GHIDORITA_HOST_GRACE_MS in index.ts) */
  graceMs?: number;
  saveMs?: number;
  provider: { start(l: ProviderLaunch, onExit: (why: unknown) => void): Promise<number>; stop(): Promise<number>; kill(): void };
  launch: ProviderLaunch;
  token: string;
  /** a program to open at start (`ghidorita-mcp --headless <binary>`) */
  open?: string;
  makeBackend?(hooks: Hooks): HostBackend;
  tools?: readonly ToolDef[];
  /** end the process; called once, after the lock is released */
  exit(code: number): void;
  log?(m: string): void;
}
export interface StopResult { code: number; saved: boolean; saveError?: string }
export interface Host { agent: Agent; stop(): Promise<StopResult>; /** stop, release the lock and exit */ quit(code?: number): Promise<void>; started: Promise<void> }

/** Starts the host; null when another Ghidorita (an app, another host) holds the agent socket: nothing was started and `exit` was called. */
export async function startHost(o: HostOpts): Promise<Host | null> {
  const log = o.log ?? ((m) => console.error("agent-host:", m)), graceMs = o.graceMs ?? GRACE_MS, saveMs = o.saveMs ?? SAVE_MS;
  const got = await acquireLock(o.place.path, { answers: probeSocket });
  if (!got) { log("another Ghidorita owns the agent socket; exiting"); o.exit(0); return null; }
  const lock = got;
  let stopping: Promise<StopResult> | null = null, dead = false, ready = false, grace: NodeJS.Timeout | undefined, finished = false, ctl: { close(): Promise<void> } | undefined;
  const headless = createHeadless({ reply: (r) => agent.reply(r), tools: o.tools });
  const agent: Agent = createAgent({
    send: (ch, p) => { if (ch === "agent-call") void headless.handle(p as never); else if (ch === "agent-cancel") headless.cancel((p as { callId: string }).callId); },
    settingsFile: o.settingsFile, socket: o.place, version: o.version, env: o.env, ignoreEnvMode: o.ignoreEnvMode, headless: true, lock, log, table: o.tools,
  });
  let backend: HostBackend | undefined;

  /** Closes the agent socket (clients fall back to "not running" and follow whoever listens next), saves, and ends the sidecar. The lock stays held until `quit`: the sidecar may still be running. */
  function stop(): Promise<StopResult> {
    return stopping ??= (async () => {
      ready = false; clearTimeout(grace); // closing the connections below calls rearm: not ready, so it arms nothing
      await agent.stop();
      headless.dispose();
      let saved = false, saveError: string | undefined;
      const p = headless.program();
      if (!p) saved = true;
      else if (!dead) { // bounded: a backend that stays connected but stops answering must not keep the sidecar from being stopped (and the lock from going)
        let timer: NodeJS.Timeout | undefined;
        const limit = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`the save was not confirmed within ${saveMs / 1000} s`)), saveMs); });
        try { await Promise.race([(async () => { if ((await p.api.history.state()).dirty) await p.api.history.save(); })(), limit]); saved = true; } catch (e) { saveError = String((e as Error)?.message ?? e); }
        finally { clearTimeout(timer); }
      }
      return { code: await o.provider.stop(), saved, saveError };
    })();
  }
  async function quit(code?: number) {
    if (finished) return;
    const r = await stop();
    finished = true; const closing = ctl?.close().catch(() => {}); lock.release(); await Promise.race([closing, new Promise((r) => setTimeout(r, 1000))]); // the control socket is unlinked before the lock goes
    o.exit(code ?? (r.code === 0 ? 0 : 1));
  }
  const rearm = () => {
    clearTimeout(grace);
    if (ready && !stopping && agent.connections() === 0) grace = setTimeout(() => { log(`no client for ${graceMs} ms; exiting`); void quit(); }, graceMs);
  };
  agent.onChange(rearm);

  const started = (async () => {
    await agent.start(); // listening early: a client that connects while the sidecar boots is told to wait, and a second host sees the lock and the socket
    if (stopping) { await agent.stop(); return; } // shut down while the listener was starting: it must not outlive the lock
    if (!agent.listening()) { log("could not listen on the agent socket (see above)"); return void quit(1); }
    // close() unlinks the control socket at once (before the lock goes, so a successor's is never unlinked) and keeps the app's connection open for the reply
    ctl = await serveControl(o.place.path, async () => { const r = await stop(); void ctl?.close().catch(() => {}); lock.release(); log(`handover: saved=${r.saved}${r.saveError ? ` (${r.saveError})` : ""}, backend exit ${r.code}; quitting`); return { saved: r.saved, saveError: r.saveError }; }, log, () => void quit());
    if (stopping) { await ctl.close().catch(() => {}); return; }
    let port: number;
    try { port = await o.provider.start(o.launch, (why) => { if (stopping) return; dead = true; log(`the analysis backend exited unexpectedly (${why})`); void quit(1); }); }
    catch (e) { log(`backend startup failed: ${e}`); o.provider.kill(); return void quit(1); }
    if (stopping) { o.provider.kill(); return; } // stop() began while the backend was starting
    backend = o.makeBackend ? o.makeBackend(headless.hooks) : new WebSocketBackend(headless.hooks);
    try { await backend.connect(port, o.token); await headless.bind(backend); } catch (e) { log(`could not connect to the backend: ${e}`); return void quit(1); }
    backend.events.onError((m) => log(`backend: ${m}`));
    if (o.open) try { await backend.lifecycle.open(o.open, {}, () => {}).result; } catch (e) { log(`could not open ${o.open}: ${e instanceof Error ? e.message : e}`); }
    if (stopping) return;
    agent.setCapabilities(backend.capabilities);
    agent.setReady(true); ready = true; rearm();
  })().catch((e) => { log(`startup failed: ${e}`); return quit(1); });
  return { agent, stop, quit, started };
}

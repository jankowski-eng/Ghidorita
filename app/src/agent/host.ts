import type { ActiveSession, FunctionInfo } from "../../../protocol";
import type { ApplicationBackend, ProgramOperations } from "../renderer/backend";
import { TOOLS } from "./tools";
import { tagParams } from "./attribution";
import { toToolError } from "./errors";
import { ToolError, type AgentCall, type AgentReply, type AgentState, type AgentUi, type ChangeView, type ToolDef } from "./types";

// The executor shared by the app (renderer/features/agent.ts) and the headless host (main/agentHost.ts): React-free, imports only what src/agent/ may.
/** The change-log fields `changeView` reads (renderer/changeLog.ts `Change` satisfies it). */
export interface ChangeLike { label: string; undone: boolean; saved: boolean; locked?: boolean; by?: string; undoName?: string }

/** The part of `window.host` the executor uses (preload `Host`); absent in the autotest and mock paths. */
export interface AgentHost {
  onAgentCall(cb: (c: AgentCall) => void): () => void;
  onAgentCancel(cb: (c: { callId: string }) => void): () => void;
  onAgentState(cb: (s: AgentState) => void): () => void;
  agentReply(r: AgentReply): Promise<void>;
  agentReady(ready: boolean): Promise<void>;
}
export type ConfirmFn = (message: string, o: { client: string; signal: AbortSignal }) => Promise<boolean>;

/** The newest change that can still be undone (the `undo_agent_edit` guard); `by` is set by the change log for the agent's edits. */
export const changeView = (items: () => readonly ChangeLike[]): ChangeView => ({
  newest() {
    const c = [...items()].reverse().find((x) => !x.undone && !x.saved && !x.locked) as ChangeLike | undefined;
    return c ? { label: c.label, by: c.by, undoName: c.undoName } : null;
  },
});

export interface ExecutorDeps {
  tools?: readonly ToolDef[];
  backend: ApplicationBackend;
  /** the active program (the session's `program()`): operations and session */
  program(): { api: ProgramOperations; session: ActiveSession } | null;
  /** the app's UI (everything in `AgentUi` but `confirm`, which the executor builds from `confirm` below); absent in a headless host, which then has no UI tools and no prompts */
  ui?: Omit<AgentUi, "confirm">;
  /** the app's current function list, or null when it is not trustworthy right now (still loading, or behind a change): the executor then asks the provider */
  functions?(): FunctionInfo[] | null;
  confirm?: ConfirmFn;
  changes: ChangeView;
  host: Pick<AgentHost, "agentReply">;
  /** a call has started (before its tool runs): "Follow agent" navigates to what a read tool targets */
  onCall?(tool: string, args: Record<string, unknown>, client: string): void;
  /** number of calls running, on every change (the status bar's pulse) */
  onBusy?(n: number): void;
}

/** Runs main's tool calls against the active program. React-free; `useAgent` builds one. Holds no timer: main times calls out and cancels them. */
export function createAgentExecutor(d: ExecutorDeps) {
  const tools = d.tools ?? TOOLS;
  const running = new Map<string, AbortController>();
  let writes: Promise<unknown> = Promise.resolve(); // edits run one at a time: guards that read the change log (undo_agent_edit) must not interleave with another edit
  const reply = (r: AgentReply) => { try { d.host.agentReply(r).catch(() => {}); } catch { /* the window is going away */ } };

  async function handle(call: AgentCall): Promise<void> {
    const { callId, client, mode } = call;
    if (running.has(callId)) return; // a repeated id would otherwise get two replies
    const ac = new AbortController();
    running.set(callId, ac); d.onBusy?.(running.size);
    const bound = d.program()?.session.sessionId ?? null; // the program this call was made against: an edit that waited its turn must not run against a different one
    try {
      const tool = tools.find((t) => t.name === call.tool);
      if (!tool) throw new Error(`Unknown tool ${call.tool}.`);
      try { d.onCall?.(call.tool, call.args, client); } catch { /* an observer must not fail the call */ }
      const exec = () => {
        if (ac.signal.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
        const p = d.program();
        if ((p?.session.sessionId ?? null) !== bound) throw new ToolError("The user opened, replaced or closed the program while this call waited; nothing was done. Call status to see what is open, then retry.");
        return tool.handler({
        ops: p?.api ?? null, session: p?.session ?? null, backend: d.backend,
        functions: async () => { if (!p) throw new ToolError("No program is open. Ask the user to open one in Ghidorita (call status to see what is open)."); return d.functions?.() ?? p.api.functions.list(); },
        ui: d.ui && d.confirm ? { ...d.ui, confirm: (m) => d.confirm!(m, { client, signal: ac.signal }) } : undefined,
        changes: d.changes, signal: ac.signal, client, mode, tag: (x) => tagParams(x, client),
        }, call.args);
      };
      const content = await (tool.access === "edit" || tool.access === "full" ? (writes = writes.then(exec, exec) as Promise<string>) : exec());
      reply({ callId, ok: true, content });
    } catch (e) {
      reply({ callId, ok: false, error: toToolError(e).message });
    } finally { running.delete(callId); d.onBusy?.(running.size); }
  }
  const cancel = (callId: string) => running.get(callId)?.abort();
  const dispose = () => { for (const ac of running.values()) ac.abort(); };

  /** Register the listeners, then announce readiness. Returns the cleanup: not ready, in-flight calls aborted. */
  function listen(host: AgentHost, onState: (s: AgentState) => void): () => void {
    const offs = [host.onAgentCall((c) => { void handle(c); }), host.onAgentCancel((c) => cancel(c.callId)), host.onAgentState(onState)];
    void host.agentReady(true).catch(() => {});
    return () => { for (const f of offs) f(); dispose(); void host.agentReady(false).catch(() => {}); };
  }
  return { handle, cancel, dispose, listen };
}

import { useEffect, useRef } from "react";
import type { ActiveSession, Address, FunctionInfo, Token } from "../../../../protocol";
import { TOOLS } from "../../agent/tools";
import { agentName, tagParams } from "../../agent/attribution";
import { toToolError } from "../../agent/errors";
import { ToolError, type AccessMode, type AgentCall, type AgentReply, type AgentState, type AgentUi, type AgentView, type ChangeView, type ToolDef } from "../../agent/types";
import type { ApplicationBackend, ProgramOperations } from "../backend";
import type { Change } from "../changeLog";
import { changeLog } from "../changeLog";
import { tokenAt } from "../editActions";
import type { Source } from "../nav";
import { createStore } from "../store/createStore";
import { useSession } from "../store/session";
import type { Views } from "../store/views";
import type { TabsApi } from "../useTabs";

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
export const changeView = (items: () => readonly Change[]): ChangeView => ({
  newest() {
    const c = [...items()].reverse().find((x) => !x.undone && !x.saved && !x.locked) as (Change & { by?: string }) | undefined;
    return c ? { label: c.label, by: c.by, undoName: c.undoName } : null;
  },
});

export interface ExecutorDeps {
  tools?: readonly ToolDef[];
  backend: ApplicationBackend;
  /** the active program (the session's `program()`): operations and session */
  program(): { api: ProgramOperations; session: ActiveSession } | null;
  ui: Pick<AgentUi, "view" | "goto">;
  /** the app's current function list, or null when it is not trustworthy right now (still loading, or behind a change): the executor then asks the provider */
  functions?(): FunctionInfo[] | null;
  confirm: ConfirmFn;
  changes: ChangeView;
  host: Pick<AgentHost, "agentReply">;
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
    try {
      const tool = tools.find((t) => t.name === call.tool);
      if (!tool) throw new Error(`Unknown tool ${call.tool}.`);
      const exec = () => {
        if (ac.signal.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
        const p = d.program();
        return tool.handler({
        ops: p?.api ?? null, session: p?.session ?? null, backend: d.backend,
        functions: async () => { if (!p) throw new ToolError("No program is open. Ask the user to open one in Ghidorita (call status to see what is open)."); return d.functions?.() ?? p.api.functions.list(); },
        ui: { view: d.ui.view, goto: d.ui.goto, confirm: (m) => d.confirm(m, { client, signal: ac.signal }) },
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

// ---- AgentUi ----
export interface ViewDeps {
  views: { getState(): Views };
  refs: { listingRow: { current: (() => { address: Address; label?: string; mnemonic: string; operands: string } | undefined) | null }; editor: { current: any }; lastPane: { current: "listing" | "decompiler" } };
  /** the active decompiler tab: its entry and result */
  decompiler(): { entry: Address; text: string; tokens: Token[] } | null;
}
/** What the user is looking at. The cursor is the shared `cursorAt`; the text under it is the decompiler token or the listing row, whichever pane had the focus last. */
export function agentView(d: ViewDeps): AgentView {
  const v = d.views.getState(), tab = d.decompiler(), ed = d.refs.editor.current;
  let under: string | null = null, selection: string | null = null;
  if (d.refs.lastPane.current === "decompiler" && tab && ed) {
    const pos = ed.getPosition?.();
    const tok = pos ? tokenAt(tab.tokens, pos.lineNumber, pos.column) : undefined;
    if (tok) under = (tab.text.split("\n")[tok.line] ?? "").slice(tok.colStart, tok.colEnd) || null;
    const sel = ed.getSelection?.();
    if (sel && !sel.isEmpty?.()) selection = ed.getModel?.()?.getValueInRange(sel) || null;
  } else {
    const row = d.refs.listingRow.current?.();
    if (row) under = [row.address, row.label, row.mnemonic, row.operands].filter(Boolean).join(" ");
  }
  return { address: v.cursorAt ?? v.nav.current?.address ?? null, function: v.fn ? { name: v.fn.name, entry: v.fn.entry } : null, tab: tab?.entry ?? null, under, selection };
}

/**
 * `AgentUi.confirm` as the Confirm dialog in the views store. Questions queue (one dialog at a time, oldest first); another open dialog
 * (edit, form) does not block it: it is rendered last and so on top. False when declined, aborted (call cancelled or timed out) or the program is replaced.
 */
export function createConfirmer(views: { getState(): Views; dispatch(a: { type: "set"; patch: Partial<Views> }): void }, onReset: (f: () => void) => () => void): ConfirmFn {
  const queue: NonNullable<Views["agentAsk"]>[] = [];
  const show = () => { if (views.getState().agentAsk !== (queue[0] ?? null)) views.dispatch({ type: "set", patch: { agentAsk: queue[0] ?? null } }); };
  onReset(() => { for (const a of [...queue]) a.answer(false); });
  return (message, { client, signal }) => new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const ask = { client, message, answer: (ok: boolean) => {
      const i = queue.indexOf(ask);
      if (i < 0) return;
      queue.splice(i, 1); signal.removeEventListener("abort", abort); resolve(ok); show();
    } };
    const abort = () => ask.answer(false);
    signal.addEventListener("abort", abort);
    queue.push(ask); show();
  });
}

// ---- status bar ----
export const agentStatus = createStore<{ state: AgentState; busy: number }, { state?: AgentState; busy?: number }>((s, a) => ({ ...s, ...a }), { state: { mode: "off", clients: [] }, busy: 0 });
/** The status bar's badge: null when no client is connected (the mode alone shows nothing). */
export function agentBadge(state: AgentState, busy: number): { label: string; pulsing: boolean } | null {
  return state.clients.length ? { label: `Agent: ${state.clients.map((id) => agentName(id, state.clients)).join(", ")}`, pulsing: busy > 0 } : null;
}

/**
 * The app's function list for `ctx.functions()`: the store's, while it is trustworthy. A change that renames, creates or deletes functions (or is broad) makes it stale until
 * its refetch lands (a new array), and while the program is still being read it is not there yet: `list()` is null then and the executor asks the provider.
 */
export function trackFunctions(s: { store: { getState(): { program: unknown; map: unknown; reading: boolean; funcs: FunctionInfo[] } }; onChanged(f: (p: { ranges: unknown; kinds: readonly string[] }) => void): () => void }) {
  let behind: FunctionInfo[] | null = null;
  const dispose = s.onChanged((p) => { if (!p.ranges || !p.kinds.length || p.kinds.some((k) => k === "symbol" || k === "function" || k === "other")) behind = s.store.getState().funcs; });
  return { dispose, list: (): FunctionInfo[] | null => { const st = s.store.getState(); return st.program && st.map && !st.reading && st.funcs !== behind ? st.funcs : null; } };
}

/** Wires the executor to the app: the active program, the views, navigation through `go` (source "agent"), the Confirm dialog. Handlers are registered once and read the latest closures. */
export function useAgent(tabs: TabsApi, go: (a: Address, s: Source) => Promise<void>) {
  const s = useSession();
  const latest = useRef({ tabs, go }); latest.current = { tabs, go };
  useEffect(() => {
    const host = (window as any).host as Partial<AgentHost> | undefined;
    if (!host?.onAgentCall || !host.onAgentCancel || !host.onAgentState || !host.agentReady || !host.agentReply) return;
    const fns = trackFunctions(s);
    const ex = createAgentExecutor({
      backend: s.backend, program: () => s.program(), functions: fns.list, changes: changeView(() => changeLog.items), host: host as AgentHost,
      ui: {
        view: async () => agentView({ views: s.views, refs: s.refs, decompiler: () => {
          const { tabs: t } = latest.current, tab = t.state.tabs.find((x) => x.id === t.state.active), d = tab && t.data[tab.id];
          return tab && d ? { entry: tab.entry, text: d.text, tokens: d.tokens } : null;
        } }),
        goto: (a) => latest.current.go(a, "agent"),
      },
      confirm: createConfirmer(s.views, s.onReset), onBusy: (busy) => agentStatus.dispatch({ busy }),
    });
    const off = ex.listen(host as AgentHost, (state) => agentStatus.dispatch({ state }));
    return () => { off(); fns.dispose(); agentStatus.dispatch({ state: { mode: "off" as AccessMode, clients: [] }, busy: 0 }); };
  }, []); // eslint-disable-line
}

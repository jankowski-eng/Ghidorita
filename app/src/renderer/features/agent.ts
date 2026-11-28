import { useEffect, useRef } from "react";
import type { Address, FunctionInfo, Token } from "../../../../protocol";
import { agentName } from "../../agent/attribution";
import { changeView, createAgentExecutor, type AgentHost, type ConfirmFn } from "../../agent/host";
import { ToolError, type AccessMode, type AgentState, type AgentView } from "../../agent/types";
import { followAgent, followingAgent } from "./agentFollow";
import { changeLog } from "../changeLog";
import { tokenAt } from "../editActions";
import type { Source } from "../nav";
import { createStore } from "../store/createStore";
import { useSession } from "../store/session";
import type { Views } from "../store/views";
import type { TabsApi } from "../useTabs";

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
    const follow = followAgent(s, (a) => latest.current.go(a, "agent"));
    const ex = createAgentExecutor({
      backend: s.backend, program: () => s.program(), functions: fns.list, changes: changeView(() => changeLog.items), host: host as AgentHost,
      ui: {
        view: async () => agentView({ views: s.views, refs: s.refs, decompiler: () => {
          const { tabs: t } = latest.current, tab = t.state.tabs.find((x) => x.id === t.state.active), d = tab && t.data[tab.id];
          return tab && d ? { entry: tab.entry, text: d.text, tokens: d.tokens } : null;
        } }),
        goto: (a) => latest.current.go(a, "agent"),
        // s.open and s.closeProgram swallow their failures (the window shows them), so the outcome is read back from the store
        openProgram: async (t, signal) => {
          const before = s.program()?.session.sessionId, onAbort = () => s.cancelOpen();
          signal?.addEventListener("abort", onAbort, { once: true });
          try {
            if (signal?.aborted) throw new ToolError("cancelled before it started");
            if ("path" in t) await s.open(t.path, {}, undefined, "background");
            else {
              const entry = (await s.backend.projects.list()).find((e) => e.programId === t.programId);
              if (!entry) throw new ToolError("That stored program no longer exists.");
              await s.open(entry.name, {}, entry, "background");
            }
          } finally { signal?.removeEventListener("abort", onAbort); }
          const now = s.program()?.session;
          if (!now || now.sessionId === before || ("programId" in t && now.programId !== t.programId)) throw new ToolError("The program did not open (the old one is still open, or none). The user can see why in the window; call status.");
        },
        closeProgram: async () => {
          await s.closeProgram();
          if (s.program()) throw new ToolError("The program is still open: it could not be saved and closed, or the window is busy. The user can see why in the window.");
        },
        highlight: async (h) => s.views.dispatch({ type: "set", patch: { agentHl: h } }),
        clearHighlight: async () => s.views.dispatch({ type: "set", patch: { agentHl: null } }),
      },
      onCall: (tool, args) => { if (followingAgent()) follow(tool, args); },
      confirm: createConfirmer(s.views, s.onReset), onBusy: (busy) => agentStatus.dispatch({ busy }),
    });
    const off = ex.listen(host as AgentHost, (state) => agentStatus.dispatch({ state }));
    return () => { off(); fns.dispose(); follow.cancel(); agentStatus.dispatch({ state: { mode: "off" as AccessMode, clients: [] }, busy: 0 }); };
  }, []); // eslint-disable-line
}

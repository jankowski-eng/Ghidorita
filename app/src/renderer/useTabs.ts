import { useRef, useState } from "react";
import { ErrorCode, type Address, type Token } from "../../../protocol";
import { rpc } from "./client";
import { RpcError } from "./backend";
import { decompileJobs } from "./decompileJobs";
import { emptyTabs, openFunction, pinTab, activateTab, closeTab, droppedIds, type Tabs } from "./tabs";

export interface TabData { status: "loading" | "ready" | "error"; text: string; tokens: Token[]; error?: string }

/**
 * Decompiler tabs + per-tab results. A tab decompiles once; switching back reuses the stored result.
 * Closing or replacing a tab cancels its in-flight decompile; results are applied only if that tab id is still open.
 */
export function useTabs(onError: (e: unknown) => void, onDecompiled: (ms: number) => void) {
  const [, bump] = useState(0);
  const tabsRef = useRef<Tabs>(emptyTabs);
  const dataRef = useRef<Record<number, TabData>>({});
  const jobs = useRef(decompileJobs(rpc));

  const set = (next: Tabs) => {
    for (const id of droppedIds(tabsRef.current, next)) {
      jobs.current.drop(id);
      delete dataRef.current[id];
    }
    tabsRef.current = next;
    bump((n) => n + 1);
  };
  const setData = (id: number, d: TabData) => { dataRef.current = { ...dataRef.current, [id]: d }; bump((n) => n + 1); };

  const load = async (id: number, entry: Address, force = false) => {
    const cur = dataRef.current[id];
    if (cur && cur.status !== "error" && !force) return;
    // a forced reload keeps showing the old text until the new one arrives
    if (!(force && cur?.status === "ready")) setData(id, { status: "loading", text: "", tokens: [] });
    const t0 = performance.now();
    const job = jobs.current.start(id, entry);
    try {
      const r = await job.result;
      if (!tabsRef.current.tabs.some((t) => t.id === id) || !job.current()) return; // closed or superseded
      setData(id, { status: "ready", text: r.text, tokens: r.tokens });
      onDecompiled(Math.round(performance.now() - t0));
    } catch (e) {
      if (!tabsRef.current.tabs.some((t) => t.id === id) || !job.current() || (e instanceof RpcError && e.code === ErrorCode.Cancelled)) return;
      setData(id, { status: "error", text: "", tokens: [], error: e instanceof Error ? e.message : String(e) });
      onError(e);
    } finally { job.done(); }
  };

  const show = (entry: Address, pin = false): Promise<void> => {
    const next = openFunction(tabsRef.current, entry, pin);
    set(next);
    const t = next.tabs.find((x) => x.id === next.active)!;
    return load(t.id, t.entry);
  };
  const activate = (id: number): Address | null => {
    const next = activateTab(tabsRef.current, id);
    set(next);
    const t = next.tabs.find((x) => x.id === id);
    if (t) void load(t.id, t.entry); // retries a failed tab
    return t?.entry ?? null;
  };
  return {
    state: tabsRef.current, data: dataRef.current, show, activate,
    pin: (id: number) => set(pinTab(tabsRef.current, id)),
    /** closes a tab; returns the entry of the tab that became active, if any */
    close: (id: number): Address | null => { const next = closeTab(tabsRef.current, id); set(next); return next.tabs.find((x) => x.id === next.active)?.entry ?? null; },
    closeActive: (): Address | null => { const a = tabsRef.current.active; return a === null ? null : (() => { const next = closeTab(tabsRef.current, a); set(next); return next.tabs.find((x) => x.id === next.active)?.entry ?? null; })(); },
    /** re-decompile a tab in place (after program_changed) */
    reload: (id: number) => { const t = tabsRef.current.tabs.find((x) => x.id === id); if (t) void load(id, t.entry, true); },
    reset: () => set({ ...emptyTabs, nextId: tabsRef.current.nextId }),
  };
}

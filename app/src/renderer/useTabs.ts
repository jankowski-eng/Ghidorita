import { useRef, useState } from "react";
import { ErrorCode, type Address, type Token } from "../../../protocol";
import { rpc } from "./client";
import { RpcError } from "./backend";
import { decompileJobs } from "./decompileJobs";
import { emptyTabs, openFunction, pinTab, activateTab, closeTab, droppedIds, isLarge, LONG_TIMEOUT_SECS, testTimeout, type Tabs } from "./tabs";

/** "large": not started, waiting for "Decompile anyway" (size warning). error + code Timeout/Cancelled also offer "Decompile anyway". long: running with the long timeout (cancellable). */
export interface TabData { status: "loading" | "ready" | "error" | "large"; text: string; tokens: Token[]; error?: string; code?: number; size?: number; long?: boolean }
export const canForce = (d: TabData) => d.status === "large" || (d.status === "error" && (d.code === -32003 || d.code === -32002));

/**
 * Decompiler tabs + per-tab results. A tab decompiles once; switching back reuses the stored result.
 * Closing or replacing a tab cancels its in-flight decompile; results are applied only if that tab id is still open.
 */
export function useTabs(onError: (e: unknown) => void, onDecompiled: (ms: number) => void, sizeOf: (entry: Address) => number) {
  const [, bump] = useState(0);
  const tabsRef = useRef<Tabs>(emptyTabs);
  const dataRef = useRef<Record<number, TabData>>({});
  const jobs = useRef(decompileJobs(rpc));
  const anyway = useRef(new Set<number>());       // tabs the user confirmed ("Decompile anyway"): long timeout, no size warning

  const set = (next: Tabs) => {
    for (const id of droppedIds(tabsRef.current, next)) {
      jobs.current.drop(id);
      delete dataRef.current[id];
      anyway.current.delete(id);
    }
    tabsRef.current = next;
    bump((n) => n + 1);
  };
  const setData = (id: number, d: TabData) => { dataRef.current = { ...dataRef.current, [id]: d }; bump((n) => n + 1); };

  const load = async (id: number, entry: Address, force = false, confirm = false) => {
    const cur = dataRef.current[id];
    if (cur && cur.status !== "error" && !force) return;
    if (confirm) anyway.current.add(id);
    const long = anyway.current.has(id);
    const size = sizeOf(entry);
    if (isLarge(size) && !long) { jobs.current.drop(id); setData(id, { status: "large", text: "", tokens: [], size }); return; } // never start a huge decompile on its own
    // a forced reload keeps showing the old text until the new one arrives
    if (!(force && cur?.status === "ready")) setData(id, { status: "loading", text: "", tokens: [], long });
    const t0 = performance.now();
    const job = jobs.current.start(id, entry, long ? LONG_TIMEOUT_SECS : testTimeout.secs);
    try {
      const r = await job.result;
      if (!tabsRef.current.tabs.some((t) => t.id === id) || !job.current()) return; // closed or superseded
      setData(id, { status: "ready", text: r.text, tokens: r.tokens });
      onDecompiled(Math.round(performance.now() - t0));
    } catch (e) {
      if (!tabsRef.current.tabs.some((t) => t.id === id) || !job.current() || (e instanceof RpcError && e.code === ErrorCode.Cancelled)) return;
      setData(id, { status: "error", text: "", tokens: [], error: e instanceof Error ? e.message : String(e), code: e instanceof RpcError ? e.code : undefined });
      if (!(e instanceof RpcError && e.code === ErrorCode.Timeout)) onError(e); // a timeout is shown in the pane with its "Decompile anyway" button
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
    /** "Decompile anyway": long timeout, no size warning for this tab from now on */
    decompileAnyway: (id: number) => { const t = tabsRef.current.tabs.find((x) => x.id === id); if (t) void load(id, t.entry, true, true); },
    /** user cancel of a running decompile: the tab falls back to its "Decompile anyway" state */
    cancel: (id: number) => {
      jobs.current.drop(id);
      setData(id, { status: "error", text: "", tokens: [], error: "Decompile cancelled.", code: ErrorCode.Cancelled });
    },
    reload: (id: number) => { const t = tabsRef.current.tabs.find((x) => x.id === id); if (t) void load(id, t.entry, true); },
    reset: () => set({ ...emptyTabs, nextId: tabsRef.current.nextId }),
  };
}

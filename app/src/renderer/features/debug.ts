import { useEffect, useRef } from "react";
import type { Address } from "../../../../protocol";
import { firstAddress, lineStarts, parseTarget } from "../debug";
import { shownDebug } from "../store/program";
import { useProgram, useSession } from "../store/session";
import type { TabsApi } from "../useTabs";
import type { Navigation } from "./navigation";
import { focusKind } from "./editing";

/** The debugger's side of the UI: jump to every stop, and the two things the Debug menu needs from the panes (where F9 puts a breakpoint, the attach dialog). */
export function useDebug(nav: Navigation, tabs: TabsApi) {
  const s = useSession();
  const { views, refs, store } = s;
  const state = useProgram((p) => p.debug?.state), stop = useProgram((p) => p.debug?.stop), at = useProgram((p) => p.debugAt);
  const was = useRef<string>("detached");
  useEffect(() => { // every stop (and every step through the history) moves the panes to its address
    const d = shownDebug(store.getState());
    if (!d) return;
    if (d.state === "stopped" && d.address) {
      if (was.current === "detached" && !views.getState().dock) views.dispatch({ type: "set", patch: { dock: "registers" } }); // the first stop of a run shows the registers
      void nav.go(d.address, "debug");
    }
    was.current = store.getState().debug?.state ?? "detached";
  }, [state, stop, at]); // eslint-disable-line
  useEffect(() => { // the variables of the function at a new stop (best effort: a function without a decompile or readable memory shows none)
    const d = store.getState().debug, current = s.program();
    if (!current || !d || d.state !== "stopped" || !d.address) return;
    const address = d.address, n = d.stop;
    void (async () => {
      const f = await current.lookup.containing(address);
      if (!f) return;
      const r = await current.api.debug.values({ entry: f.entry }).result;
      if (s.program() === current) store.dispatch({ type: "debugValues", stop: n, entry: f.entry, items: r.items });
    })().catch(() => {});
  }, [stop]); // eslint-disable-line

  /** The first address of the listing cursor row or of the decompiler cursor line, whichever pane has the cursor. */
  const breakpointAddress = (): Address | null => {
    const kind = focusKind(document.activeElement), pane = kind === "listing" || kind === "decompiler" ? kind : refs.lastPane.current;
    if (pane === "listing") return refs.listingRow.current?.()?.address ?? null;
    const tab = tabs.state.tabs.find((t) => t.id === tabs.state.active), d = tab ? tabs.data[tab.id] : undefined, pos = refs.editor.current?.getPosition();
    return d && pos ? firstAddress(d.tokens, pos.lineNumber - 1) : null;
  };
  const attachDialog = () => {
    const current = s.program();
    if (!current || store.getState().debug?.state === "stopped" || store.getState().debug?.state === "running") return;
    views.dispatch({ type: "set", patch: { formDlg: { title: "Attach to QEMU", submit: "Attach", fields: [{ key: "target", label: "gdbstub address (host:port)", initial: "localhost:1234" }, { key: "offset", label: "Load offset (hex, runtime address minus program address)", initial: "0x0" }],
      go: async (v) => { await current.api.debug.attach({ ...parseTarget(v.target), offset: v.offset.trim() || "0x0" }); } } } });
  };
  /** F7 / F10 / Shift+F10: one statement over calls, into a call, or out of the function (the decompiler's line mapping gives the statement starts); one instruction where there are no lines. */
  const stepStatement = async (mode: "statement" | "into" | "out" = "statement") => {
    const current = s.program(), d = store.getState().debug;
    if (!current || !d || d.state !== "stopped" || !d.address) return void s.debugAction("step");
    if (mode === "out") return void s.debugAction("step", undefined, { mode });
    let starts: Address[] = [];
    try {
      const f = await current.lookup.containing(d.address);
      const tab = f && tabs.state.tabs.find((t) => t.entry === f.entry), data = tab ? tabs.data[tab.id] : undefined;
      if (f && s.caps.has("decompile")) starts = lineStarts(data?.status === "ready" ? data.tokens : (await current.api.decompiler.decompile({ entry: f.entry }).result).tokens);
    } catch (e) { s.fail(e); return; }
    if (!starts.length) { s.flash("No decompiler lines here: stepped one instruction."); return void s.debugAction("step"); }
    await s.debugAction("step", undefined, { mode, boundaries: starts });
  };
  return { breakpointAddress, attachDialog, stepStatement };
}
export type DebugFeature = ReturnType<typeof useDebug>;

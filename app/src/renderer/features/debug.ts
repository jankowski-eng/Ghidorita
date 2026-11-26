import { useEffect, useRef } from "react";
import type { Address } from "../../../../protocol";
import { firstAddress, parseTarget } from "../debug";
import { useProgram, useSession } from "../store/session";
import type { TabsApi } from "../useTabs";
import type { Navigation } from "./navigation";
import { focusKind } from "./editing";

/** The debugger's side of the UI: jump to every stop, and the two things the Debug menu needs from the panes (where F9 puts a breakpoint, the attach dialog). */
export function useDebug(nav: Navigation, tabs: TabsApi) {
  const s = useSession();
  const { views, refs, store } = s;
  const state = useProgram((p) => p.debug?.state), stop = useProgram((p) => p.debug?.stop);
  const was = useRef<string>("detached");
  useEffect(() => {
    const d = store.getState().debug;
    if (!d) return;
    if (d.state === "stopped" && d.address) {
      if (was.current === "detached" && !views.getState().dock) views.dispatch({ type: "set", patch: { dock: "registers" } }); // the first stop of a run shows the registers
      void nav.go(d.address, "debug");
    }
    was.current = d.state;
  }, [state, stop]); // eslint-disable-line

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
    views.dispatch({ type: "set", patch: { formDlg: { title: "Attach to QEMU", submit: "Attach", fields: [{ key: "target", label: "gdbstub address (host:port)", initial: "localhost:1234" }],
      go: async (v) => { await current.api.debug.attach(parseTarget(v.target)); } } } });
  };
  return { breakpointAddress, attachDialog };
}
export type DebugFeature = ReturnType<typeof useDebug>;

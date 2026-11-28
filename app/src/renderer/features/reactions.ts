import { useEffect, useRef } from "react";
import { analysisRunning } from "../analysis";
import { onProgramChanged } from "../changes";
import { useSession } from "../store/session";
import { clearTrail } from "../store/views";
import type { TabsApi } from "../useTabs";

/** What the views do when the program changes (program_changed: edits, undo, redo) or is replaced: the one place that wires changes.ts to the tabs, listing, xrefs and function list. */
export function useProgramReactions(tabs: TabsApi) {
  const session = useSession();
  const { views, store } = session;
  const latest = useRef(tabs); latest.current = tabs;
  useEffect(() => session.onReset(() => latest.current.reset()), []); // eslint-disable-line
  useEffect(() => session.onChanged((p, current) => {
    // the trail's token positions and the agent's decompiler line numbers belong to the text they were computed for
    if (p.kinds.length) views.dispatch({ type: "set", patch: (v) => ({ ...clearTrail(v), ...(v.agentHl?.lines.length ? { agentHl: { ...v.agentHl, lines: [] } } : {}) }) });
    const isCurrent = () => store.getState().program === current;
    onProgramChanged(p, {
      refetchFunctions: () => session.refreshFunctions(current),
      tabs: () => isCurrent() ? latest.current.state.tabs : [],
      reloadTab: (id) => { if (isCurrent()) latest.current.reload(id); },
      refreshListing: (ranges) => isCurrent() && views.dispatch({ type: "set", patch: (v) => ({ listingChange: { n: v.listingChange.n + 1, ranges } }) }),
      currentFunctions: () => store.getState().funcs,
      setUndo: (u) => { if (isCurrent()) store.dispatch({ type: "undo", u }); },
      refreshXrefs: () => isCurrent() && views.dispatch({ type: "set", patch: (v) => ({ xrefVersion: v.xrefVersion + 1 }) }),
    }, analysisRunning(store.getState().analysis)).catch((e) => { if (isCurrent()) session.fail(e); });
  }), []); // eslint-disable-line
}

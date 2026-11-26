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
    if (p.kinds.length) views.dispatch({ type: "set", patch: clearTrail }); // the slice's token positions belong to the text it was computed for
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

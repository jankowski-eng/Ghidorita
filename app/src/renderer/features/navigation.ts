import { useEffect, useRef } from "react";
import type { Address } from "../../../../protocol";
import { push, goBack, goForward, type Loc, type Source } from "../nav";
import type { FuncAt } from "../symbols";
import { useSession, useViews } from "../store/session";
import type { TabsApi as Tabs } from "../useTabs";

/**
 * Navigation: the history (Back/Forward), the scroll request for the listing, the function under the cursor and the decompiler tab that follows it.
 * Every navigation ends in `applyLoc`; only the newest one may open a tab (`goSeq`), so a slow get_function_at can't override a later click.
 */
export function useNavigation(tabs: Tabs) {
  const session = useSession();
  const { views, caps, store } = session;
  const goSeq = useRef(0);
  const nav = useViews((v) => v.nav);
  const fn = useViews((v) => v.fn);
  useEffect(() => session.onReset(() => { ++goSeq.current; }), []); // eslint-disable-line

  const containingFunction = (address: Address) => store.getState().program?.lookup.containing(address) ?? Promise.resolve(null);
  const applyLoc = async (loc: Loc, viaHistory: boolean, seq: number): Promise<void> => {
    views.dispatch({ type: "set", patch: { cursorAt: loc.address } });
    if (viaHistory || loc.source !== "listing") views.dispatch({ type: "set", patch: (v) => ({ scrollReq: { address: loc.address, n: v.scrollReq.n + 1 } }) });
    let f: FuncAt | null = null;
    let err: unknown = null;
    try { f = await containingFunction(loc.address); } catch (e) { err = e; }
    if (seq !== goSeq.current) return;
    if (err) session.fail(err);
    views.dispatch({ type: "set", patch: { fn: f } });
    if (f && caps.has("decompile")) await tabs.show(f.entry);
  };
  const go = async (address: Address, source: Source) => {
    if (session.blocked() || !store.getState().program) return;
    const seq = ++goSeq.current;
    const loc: Loc = { address, source }, cur = views.getState().nav.current;
    // reading in the listing must not flood the history: clicks within one function replace the current entry
    let sameFn = false;
    if (cur?.source === "listing" && source === "listing") {
      try { const [a, b] = await Promise.all([containingFunction(cur.address), containingFunction(address)]); sameFn = !!a && a.entry === b?.entry; } catch { /* treat as different */ }
      if (seq !== goSeq.current) return;
    }
    const now = views.getState().nav;
    views.dispatch({ type: "set", patch: { nav: sameFn ? { ...now, current: loc } : push(now, loc) } });
    await applyLoc(loc, false, seq);
  };
  const goTab = (entry: Address | null) => { if (entry) void go(entry, "functions"); }; // keep list/status/listing in step with the visible tab
  const step = (move: typeof goBack) => {
    const now = views.getState().nav, n = move(now);
    if (n !== now && !session.blocked()) { views.dispatch({ type: "set", patch: { nav: n } }); void applyLoc(n.current!, true, ++goSeq.current); }
  };
  const back = () => step(goBack);
  const forward = () => step(goForward);

  // Monaco token click -> navigate
  const clickAt = (line1: number, col1: number) => {
    const d = tabs.data[tabs.state.active ?? -1];
    const t = d?.tokens.find((t) => t.targetFunction && t.line + 1 === line1 && col1 >= t.colStart + 1 && col1 < t.colEnd + 1);
    if (t?.targetFunction) void go(t.targetFunction, "decompiler");
  };
  return { nav, fn, go, goTab, back, forward, clickAt, containingFunction };
}
export type Navigation = ReturnType<typeof useNavigation>;

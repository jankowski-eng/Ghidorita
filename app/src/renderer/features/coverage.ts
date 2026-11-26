import { coverage, Coverage } from "../coverage";
import type { Session } from "../store/session";

/** Coverage runs are module state (coverage.ts); these actions load one, clear them and tell the listing, map and decompiler to repaint. */
export function coverageActions(s: Session) {
  const changed = () => {
    s.views.dispatch({ type: "set", patch: (v) => ({ covVersion: v.covVersion + 1 }) });
    const a = s.refs.topAddr.current; // the listing refetches its visible rows to repaint the coverage bar
    if (a) s.views.dispatch({ type: "set", patch: (v) => ({ scrollReq: { address: a, n: v.scrollReq.n + 1, refresh: true } }) });
  };
  const load = async (path: string) => {
    const current = s.program();
    if (!current || s.blocked()) return;
    try {
      const { ranges } = await current.api.coverage.load({ path });
      if (s.program() !== current) return;
      const run = coverage.add(path.split(/[\\/]/).pop() || path, new Coverage(ranges));
      s.flash(`Coverage "${run.name}" loaded: ${run.cov.size} range${run.cov.size === 1 ? "" : "s"}${coverage.b === run.id ? ` as run B, compared with A (only A solid, only B hatched, both green)` : " (green bar in the listing)"}; Coverage window to name and compare runs`);
      changed();
    } catch (e) { s.fail(e); }
  };
  const pick = async () => { const p = await window.host.pickFile(); if (p) void load(p); };
  return { changed, load, pick, clear: () => { coverage.clear(); changed(); } };
}
export type CoverageActions = ReturnType<typeof coverageActions>;

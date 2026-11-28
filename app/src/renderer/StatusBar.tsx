import { useEffect, useState } from "react";
import type { AnalysisState, Capability, DebugState } from "../../../protocol";
import { KEYS, hintLine, showKey, type HintView } from "../keys";
import { isMac } from "./platform";
import { debugLabel } from "./debug";
import { agentBadge, agentStatus } from "./features/agent";
import { useStore } from "./store/createStore";
import { ACTION_LABEL, analysisAction, analysisLabel, type AnalysisAction } from "./analysis";

const viewOf = (el: Element | null): HintView => (el?.closest(".graph") ? "graph" : el?.closest(".lbox") ? "listing" : el?.closest(".monaco-editor") ? "decompiler" : "other");

/** "Agent: <client>" while an MCP client is connected, pulsing while a call runs; a click opens the Agent menu (the kill switch). */
function AgentBadge() {
  const state = useStore(agentStatus, (s) => s.state), busy = useStore(agentStatus, (s) => s.busy); // stable values: a fresh object from the selector would re-render forever
  const badge = agentBadge(state, busy);
  if (!badge) return null;
  return <span> | <button className={"agent" + (badge.pulsing ? " pulse" : "")} aria-label={`${badge.label}. Open the Agent menu`} title="Agent access: click for the menu" onClick={() => void (window as any).host?.agentMenu?.()}>{badge.label}</button></span>;
}

export type Stats = { listingMs?: number; decompileMs?: number };

export function StatusBar({ address, func, bytes, funcs, stats, error, dirty, saving, flash, analysis, onAnalysis, debug, debugNote, trail, back, forward, onBack, onForward, caps }: {
  caps: ReadonlySet<Capability>;
  address: string | null; func: string | null; bytes: number; funcs: number; stats: Stats; error: string; dirty: boolean; saving: boolean; flash: string; analysis: AnalysisState | null; onAnalysis: (a: AnalysisAction) => void; debug: DebugState | null; debugNote?: string; trail?: string;
  back: string[]; forward: string[]; onBack: () => void; onForward: () => void; // history addresses, nearest first
}) {
  const backKey = showKey(KEYS["nav-back"], isMac), forwardKey = showKey(KEYS["nav-forward"], isMac);
  const tip = (l: string[]) => l.slice(0, 8).join("\n");
  const [view, setView] = useState<HintView>("other");
  useEffect(() => {
    const f = () => setView(viewOf(document.activeElement));
    document.addEventListener("focusin", f); document.addEventListener("focusout", f);
    return () => { document.removeEventListener("focusin", f); document.removeEventListener("focusout", f); };
  }, []);
  const hint = hintLine(view, caps, isMac);
  const action = analysisAction(analysis), label = analysisLabel(analysis);
  return (
    <div className="status">
      <div className="stl">
      <span className="hist">
        <button onClick={onBack} disabled={!back.length} aria-label="Back" title={back.length ? `Back (${backKey})\n${tip(back)}` : `Back (${backKey})`}>←{back.length || ""}</button>
        <button onClick={onForward} disabled={!forward.length} aria-label="Forward" title={forward.length ? `Forward (${forwardKey})\n${tip(forward)}` : `Forward (${forwardKey})`}>{forward.length || ""}→</button>
      </span>
      <span>{address ?? "-"} {func ? `in ${func}` : address ? "(no function)" : ""} | bytes: {bytes} | funcs: {funcs} | last listing page: {stats.listingMs ?? "-"} ms | last decompile: {stats.decompileMs ?? "-"} ms</span>
      {(label || action) && <span role="status" aria-label="Analysis" className={analysis?.state === "failed" ? "err" : ""}> | {label} {action && <button aria-label={ACTION_LABEL[action]} onClick={() => onAnalysis(action)}>{action === "cancel" ? "Cancel" : action === "resume" ? "Resume" : "Run full analysis"}</button>}</span>}
      {debug && <span role="status" aria-label="Debugger" className={debug.state === "detached" && debug.error ? "err" : ""}> | Debugger: {debugLabel(debug)}{debugNote}</span>}
      <span role="status" aria-label="Save state">{saving ? " | Saving…" : dirty ? " | ● unsaved changes" : ""}</span>{flash && <span role="status"> | {flash}</span>}{trail && <span role="status" aria-label="Value trail"> | {trail}</span>}
      <AgentBadge />
      {error && <span className="err" role="alert"> | {error}</span>}
      </div>
      <span className="keyhint" title={hint} aria-label="Keys">{hint}</span>
    </div>
  );
}

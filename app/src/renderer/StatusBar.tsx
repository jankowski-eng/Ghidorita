import { useEffect, useState } from "react";
import type { AnalysisState, Capability, DebugState } from "../../../protocol";
import { hintLine, type HintView } from "../keys";
import { isMac } from "./platform";
import { debugLabel } from "./debug";
import { ACTION_LABEL, analysisAction, analysisLabel, type AnalysisAction } from "./analysis";

const viewOf = (el: Element | null): HintView => (el?.closest(".graph") ? "graph" : el?.closest(".lbox") ? "listing" : el?.closest(".monaco-editor") ? "decompiler" : "other");

export type Stats = { listingMs?: number; decompileMs?: number };

export function StatusBar({ address, func, bytes, funcs, stats, error, dirty, saving, flash, analysis, onAnalysis, debug, debugNote, back, forward, onBack, onForward, caps }: {
  caps: ReadonlySet<Capability>;
  address: string | null; func: string | null; bytes: number; funcs: number; stats: Stats; error: string; dirty: boolean; saving: boolean; flash: string; analysis: AnalysisState | null; onAnalysis: (a: AnalysisAction) => void; debug: DebugState | null; debugNote?: string;
  back: string[]; forward: string[]; onBack: () => void; onForward: () => void; // history addresses, nearest first
}) {
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
        <button onClick={onBack} disabled={!back.length} aria-label="Back" title={back.length ? `Back (Cmd+[)\n${tip(back)}` : "Back (Cmd+[)"}>←{back.length || ""}</button>
        <button onClick={onForward} disabled={!forward.length} aria-label="Forward" title={forward.length ? `Forward (Cmd+])\n${tip(forward)}` : "Forward (Cmd+])"}>{forward.length || ""}→</button>
      </span>
      <span>{address ?? "-"} {func ? `in ${func}` : address ? "(no function)" : ""} | bytes: {bytes} | funcs: {funcs} | last listing page: {stats.listingMs ?? "-"} ms | last decompile: {stats.decompileMs ?? "-"} ms</span>
      {(label || action) && <span role="status" aria-label="Analysis" className={analysis?.state === "failed" ? "err" : ""}> | {label} {action && <button aria-label={ACTION_LABEL[action]} onClick={() => onAnalysis(action)}>{action === "cancel" ? "Cancel" : action === "resume" ? "Resume" : "Run full analysis"}</button>}</span>}
      {debug && <span role="status" aria-label="Debugger" className={debug.state === "detached" && debug.error ? "err" : ""}> | Debugger: {debugLabel(debug)}{debugNote}</span>}
      <span role="status" aria-label="Save state">{saving ? " | Saving…" : dirty ? " | ● unsaved changes" : ""}</span>{flash && <span role="status"> | {flash}</span>}
      {error && <span className="err" role="alert"> | {error}</span>}
      </div>
      <span className="keyhint" title={hint} aria-label="Keys">{hint}</span>
    </div>
  );
}

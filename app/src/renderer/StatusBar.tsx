import type { AnalysisState, DebugState } from "../../../protocol";
import { debugLabel } from "./debug";
import { ACTION_LABEL, analysisAction, analysisLabel, type AnalysisAction } from "./analysis";

export type Stats = { listingMs?: number; decompileMs?: number };

export function StatusBar({ address, func, bytes, funcs, stats, error, dirty, saving, flash, analysis, onAnalysis, debug, back, forward, onBack, onForward }: {
  address: string | null; func: string | null; bytes: number; funcs: number; stats: Stats; error: string; dirty: boolean; saving: boolean; flash: string; analysis: AnalysisState | null; onAnalysis: (a: AnalysisAction) => void; debug: DebugState | null;
  back: string[]; forward: string[]; onBack: () => void; onForward: () => void; // history addresses, nearest first
}) {
  const tip = (l: string[]) => l.slice(0, 8).join("\n");
  const action = analysisAction(analysis), label = analysisLabel(analysis);
  return (
    <div className="status">
      <span className="hist">
        <button onClick={onBack} disabled={!back.length} aria-label="Back" title={back.length ? `Back (Cmd+[)\n${tip(back)}` : "Back (Cmd+[)"}>←{back.length || ""}</button>
        <button onClick={onForward} disabled={!forward.length} aria-label="Forward" title={forward.length ? `Forward (Cmd+])\n${tip(forward)}` : "Forward (Cmd+])"}>{forward.length || ""}→</button>
      </span>
      <span>{address ?? "-"} {func ? `in ${func}` : address ? "(no function)" : ""} | bytes: {bytes} | funcs: {funcs} | last listing page: {stats.listingMs ?? "-"} ms | last decompile: {stats.decompileMs ?? "-"} ms</span>
      {(label || action) && <span role="status" aria-label="Analysis" className={analysis?.state === "failed" ? "err" : ""}> | {label} {action && <button aria-label={ACTION_LABEL[action]} onClick={() => onAnalysis(action)}>{action === "cancel" ? "Cancel" : action === "resume" ? "Resume" : "Run full analysis"}</button>}</span>}
      {debug && <span role="status" aria-label="Debugger" className={debug.state === "detached" && debug.error ? "err" : ""}> | Debugger: {debugLabel(debug)}</span>}
      <span role="status" aria-label="Save state">{saving ? " | Saving…" : dirty ? " | ● unsaved changes" : ""}</span>{flash && <span role="status"> | {flash}</span>}
      {error && <span className="err" role="alert"> | {error}</span>}
    </div>
  );
}

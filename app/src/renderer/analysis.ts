import type { AnalysisState } from "../../../protocol";

export type AnalysisAction = "cancel" | "resume" | "full";

export const analysisRunning = (s: AnalysisState | null | undefined): boolean => s?.state === "running";

/** The status bar text of the analysis (empty = nothing to say). pct -1 = Ghidra knows no total, `done` = analyzer starts seen. */
export function analysisLabel(s: AnalysisState | null | undefined): string {
  if (!s) return "";
  if (s.state === "running") return `Analyzing${s.analyzer ? ": " + s.analyzer : ""} · ${s.done} done${s.pct >= 0 ? ` · ${s.pct}%` : ""}`;
  if (s.state === "failed") return `Analysis failed${s.error ? ": " + s.error : ""}`;
  if (s.analysis === "partial") return s.state === "cancelled" ? "Analysis cancelled (partial)" : "Analysis incomplete";
  if (s.analysis === "none") return "Not analyzed";
  return s.profile === "fast" ? "Fast analysis done" : "";
}

/** The one button next to it: Cancel while running, Resume for an interrupted analysis, Run full analysis on a finished fast program. */
export function analysisAction(s: AnalysisState | null | undefined): AnalysisAction | null {
  if (!s) return null;
  if (s.state === "running") return "cancel";
  if (s.analysis === "partial" || s.analysis === "none") return "resume";
  return s.analysis === "done" && s.profile === "fast" ? "full" : null;
}

export const ACTION_LABEL: Record<AnalysisAction, string> = { cancel: "Cancel analysis", resume: "Resume analysis", full: "Run full analysis" };

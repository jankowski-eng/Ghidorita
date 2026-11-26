import { fmtSize } from "./format";
import type { ProgramEntry } from "../../../protocol";
import { optionsSummary } from "./openOptions";


/** Start pane: the programs already in the project. Click/Enter opens one, Delete asks first. */
export function Welcome({ programs, loading, error, onOpen, onDelete, onFull }: {
  programs: ProgramEntry[]; loading: boolean; error: string; onOpen: (e: ProgramEntry) => void; onDelete: (e: ProgramEntry) => void; onFull: (e: ProgramEntry) => void;
}) {
  return (
    <div className="welcome" role="region" aria-label="Programs in project">
      <div className="title">Programs in this project</div>
      {error && <div className="err" role="alert">{error}</div>}
      {loading && <div className="msg" role="status">Loading…</div>}
      {!loading && !error && !programs.length && <div className="msg">No programs yet.</div>}
      <ul>
        {programs.map((p0) => { const p = { ...p0, analysis: p0.analysis ?? (p0.analyzed ? "done" : "none") }; return (
          <li key={p.programId} className="prog">
            <button className="open" aria-label={`Open ${p.name}`} onClick={() => onOpen(p0)}>
              <b>{p.name}</b>
              <span className="meta">{p.sourcePath ?? "(source path unknown)"}</span>
              <span className="meta">{fmtSize(p.sizeBytes)} · {p.analysis === "done" ? (p.analysisProfile === "fast" ? "analyzed (fast)" : "analyzed") : p.analysis === "partial" ? "analysis incomplete" : "not analyzed"} · {p.lastOpened ? "opened " + new Date(p.lastOpened).toLocaleString() : "never opened"} · {optionsSummary(p.options)}</span>
            </button>
            {p.analysis === "partial" && <button aria-label={`Resume analysis of ${p.name}`} onClick={() => onOpen(p0)}>Resume analysis</button>}
            {p.analysis === "done" && p.analysisProfile === "fast" && <button aria-label={`Run full analysis of ${p.name}`} onClick={() => onFull(p0)}>Run full analysis</button>}
            <button aria-label={`Delete ${p.name}`} onClick={() => onDelete(p0)}>Delete</button>
          </li>
        ); })}
      </ul>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useRestoreFocus } from "./hooks";

export type Progress = { phase: string; pct: number; message: string; analyzer?: string; done?: number };

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Shown while open_binary runs. The bar is only determinate when the sidecar gives a pct (never an invented overall one). */
export function OpenDialog({ path, progress, startedAt, cancelling, onCancel }: {
  path: string; progress: Progress | null; startedAt: number; cancelling: boolean; onCancel: () => void;
}) {
  useRestoreFocus();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const p = progress ?? { phase: "import", pct: -1, message: "starting" };
  const det = p.pct >= 0;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Opening binary" onKeyDown={(e) => { if (e.key === "Escape" && !cancelling) onCancel(); }}>
      <div className="card">
        <div className="title">Opening {path.split("/").pop()}</div>
        <div>Phase: <b>{p.phase}</b></div>
        {p.analyzer && <div>Analyzer: {p.analyzer}</div>}
        <div role="status">{p.message}</div>
        <div className={"bar2" + (det ? "" : " indet")} role="progressbar" aria-label={p.analyzer ? `Progress of ${p.analyzer}` : "Progress of current step"} aria-valuenow={det ? p.pct : undefined} aria-valuemin={0} aria-valuemax={100}>
          <div style={det ? { width: `${p.pct}%` } : undefined} />
        </div>
        <div className="meta">{p.done !== undefined && <span>analyzer runs done: {p.done} · </span>}elapsed {fmt(Math.max(0, Math.floor((now - startedAt) / 1000)))}</div>
        <button autoFocus onClick={onCancel} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel"}</button>
      </div>
    </div>
  );
}

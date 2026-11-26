export function Toolbar({ path, setPath, onPick, onOpen, onBack, onForward, onGoto, canBack, canForward, canGoto }: {
  path: string; setPath: (p: string) => void; onPick: () => void; onOpen: () => void;
  onBack: () => void; onForward: () => void; onGoto: () => void; canBack: boolean; canForward: boolean; canGoto: boolean;
}) {
  return (
    <div className="bar">
      <button onClick={onPick}>Open binary…</button>
      <input type="text" aria-label="Binary path" placeholder="or type a path and press Enter" value={path} onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && path && onOpen()} />
      <button onClick={onBack} disabled={!canBack} aria-label="Back" title="Back (Cmd+[)">← Back</button>
      <button onClick={onForward} disabled={!canForward} aria-label="Forward" title="Forward (Cmd+])">Forward →</button>
      <button onClick={onGoto} disabled={!canGoto} aria-label="Go to address" title="Go to address (Cmd+G)">Go to…</button>
    </div>
  );
}

export type Progress = { phase: string; pct: number; message: string };

export function ProgressBar({ progress }: { progress: Progress }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={progress.pct < 0 ? undefined : progress.pct} aria-label="Progress">
      <div style={{ width: progress.pct < 0 ? "100%" : `${progress.pct}%`, opacity: progress.pct < 0 ? 0.4 : 1 }} />
      <span>{progress.phase}: {progress.message}{progress.pct >= 0 ? ` (${progress.pct}%)` : ""}</span>
    </div>
  );
}

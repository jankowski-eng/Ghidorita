export function Toolbar({ path, setPath, onPick, onOpen, onBack, canBack }: {
  path: string; setPath: (p: string) => void; onPick: () => void; onOpen: () => void; onBack: () => void; canBack: boolean;
}) {
  return (
    <div className="bar">
      <button onClick={onPick}>Open binary…</button>
      <input type="text" placeholder="or type a path and press Enter" value={path} onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && path && onOpen()} />
      <button onClick={onBack} disabled={!canBack}>← Back</button>
    </div>
  );
}

export type Progress = { phase: string; pct: number; message: string };

export function ProgressBar({ progress }: { progress: Progress }) {
  return (
    <div className="progress">
      <div style={{ width: progress.pct < 0 ? "100%" : `${progress.pct}%`, opacity: progress.pct < 0 ? 0.4 : 1 }} />
      <span>{progress.phase}: {progress.message}{progress.pct >= 0 ? ` (${progress.pct}%)` : ""}</span>
    </div>
  );
}

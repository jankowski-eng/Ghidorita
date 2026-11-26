export function Toolbar({ path, setPath, onPick, onOpen, onBack, onForward, onGoto, onSearch, canBack, canForward, canGoto, busy }: {
  path: string; setPath: (p: string) => void; onPick: () => void; onOpen: () => void;
  onBack: () => void; onForward: () => void; onGoto: () => void; onSearch: () => void; canBack: boolean; canForward: boolean; canGoto: boolean; busy: boolean;
}) {
  return (
    <div className="bar">
      <button onClick={onPick} disabled={busy}>Open binary…</button>
      <input type="text" aria-label="Binary path" disabled={busy} placeholder="or type a path and press Enter" value={path} onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && path && onOpen()} />
      <button onClick={onBack} disabled={!canBack || busy} aria-label="Back" title="Back (Cmd+[)">← Back</button>
      <button onClick={onForward} disabled={!canForward || busy} aria-label="Forward" title="Forward (Cmd+])">Forward →</button>
      <button onClick={onSearch} disabled={!canGoto || busy} aria-label="Search symbols" title="Search symbols (Cmd+Shift+O)">Search…</button>
      <button onClick={onGoto} disabled={!canGoto || busy} aria-label="Go to address" title="Go to address (Cmd+G)">Go to…</button>
    </div>
  );
}

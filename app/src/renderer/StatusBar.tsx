export type Stats = { listingMs?: number; decompileMs?: number };

export function StatusBar({ address, func, bytes, funcs, stats, error, dirty, saving, flash, back, forward, onBack, onForward }: {
  address: string | null; func: string | null; bytes: number; funcs: number; stats: Stats; error: string; dirty: boolean; saving: boolean; flash: string;
  back: string[]; forward: string[]; onBack: () => void; onForward: () => void; // history addresses, nearest first
}) {
  const tip = (l: string[]) => l.slice(0, 8).join("\n");
  return (
    <div className="status">
      <span className="hist">
        <button onClick={onBack} disabled={!back.length} aria-label="Back" title={back.length ? `Back (Cmd+[)\n${tip(back)}` : "Back (Cmd+[)"}>←{back.length || ""}</button>
        <button onClick={onForward} disabled={!forward.length} aria-label="Forward" title={forward.length ? `Forward (Cmd+])\n${tip(forward)}` : "Forward (Cmd+])"}>{forward.length || ""}→</button>
      </span>
      <span>{address ?? "-"} {func ? `in ${func}` : address ? "(no function)" : ""} | bytes: {bytes} | funcs: {funcs} | last listing page: {stats.listingMs ?? "-"} ms | last decompile: {stats.decompileMs ?? "-"} ms</span>
      <span role="status" aria-label="Save state">{saving ? " | Saving…" : dirty ? " | ● unsaved changes" : ""}</span>{flash && <span role="status"> | {flash}</span>}
      {error && <span className="err" role="alert"> | {error}</span>}
    </div>
  );
}

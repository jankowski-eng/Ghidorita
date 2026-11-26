export type Stats = { listingMs?: number; decompileMs?: number };

export function StatusBar({ address, func, bytes, funcs, stats, error, dirty, saving, flash }: {
  address: string | null; func: string | null; bytes: number; funcs: number; stats: Stats; error: string; dirty: boolean; saving: boolean; flash: string;
}) {
  return (
    <div className="status">
      <span>{address ?? "-"} {func ? `in ${func}` : address ? "(no function)" : ""} | bytes: {bytes} | funcs: {funcs} | last listing page: {stats.listingMs ?? "-"} ms | last decompile: {stats.decompileMs ?? "-"} ms</span>
      <span role="status" aria-label="Save state">{saving ? " | Saving…" : dirty ? " | ● unsaved changes" : ""}</span>{flash && <span role="status"> | {flash}</span>}
      {error && <span className="err" role="alert"> | {error}</span>}
    </div>
  );
}

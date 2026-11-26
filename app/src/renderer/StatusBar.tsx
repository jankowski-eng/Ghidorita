export type Stats = { listingMs?: number; decompileMs?: number };

export function StatusBar({ selected, bytes, funcs, stats, error }: {
  selected: string | null; bytes: number; funcs: number; stats: Stats; error: string;
}) {
  return (
    <div className="status">
      <span>selected: {selected ?? "-"} | bytes: {bytes} | funcs: {funcs} | last listing page: {stats.listingMs ?? "-"} ms | last decompile: {stats.decompileMs ?? "-"} ms</span>
      {error && <span className="err"> | {error}</span>}
    </div>
  );
}

export type Stats = { listingMs?: number; decompileMs?: number };

export function StatusBar({ address, func, bytes, funcs, stats, error }: {
  address: string | null; func: string | null; bytes: number; funcs: number; stats: Stats; error: string;
}) {
  return (
    <div className="status">
      <span>{address ?? "-"} {func ? `in ${func}` : address ? "(no function)" : ""} | bytes: {bytes} | funcs: {funcs} | last listing page: {stats.listingMs ?? "-"} ms | last decompile: {stats.decompileMs ?? "-"} ms</span>
      {error && <span className="err" role="alert"> | {error}</span>}
    </div>
  );
}

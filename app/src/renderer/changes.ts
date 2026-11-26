import type { Address, FunctionInfo, Notifications } from "../../../protocol";

type Params = Notifications["program_changed"];

/** Ids of tabs whose function [entry, entry+size) overlaps a changed range (end inclusive); all tabs when ranges is null. */
export function affectedTabs(ranges: Params["ranges"], tabs: { id: number; entry: Address }[], funcs: FunctionInfo[]): number[] {
  if (!ranges) return tabs.map((t) => t.id);
  const size = new Map(funcs.map((f) => [f.entry, f.size]));
  return tabs.filter((t) => {
    const s = BigInt(t.entry), e = s + BigInt(Math.max(size.get(t.entry) ?? 1, 1)) - 1n;
    return ranges.some((r) => BigInt(r.start) <= e && BigInt(r.end) >= s);
  }).map((t) => t.id);
}

export interface ChangeDeps {
  refetchFunctions(): Promise<FunctionInfo[]>;
  tabs(): { id: number; entry: Address }[];
  reloadTab(id: number): void;
  refreshListing(): void;
  refreshXrefs(): void;
}

/**
 * The one place that reacts to program_changed. For now the UI cannot edit, so every change refetches the
 * function list, the overlapping open tabs, the listing around the top row and the xrefs. Editing (#5) extends this
 * by using `kinds` / `undo` to narrow or add work.
 */
export async function onProgramChanged(p: Params, d: ChangeDeps): Promise<void> {
  const funcs = await d.refetchFunctions();
  for (const id of affectedTabs(p.ranges, d.tabs(), funcs)) d.reloadTab(id);
  d.refreshListing();
  d.refreshXrefs();
}

import type { Address, FunctionInfo } from "../../../protocol";
import { offIn, parseAddr } from "./address";

import type { ProgramChange as Params } from "./backend";

/** Ids of tabs whose function [entry, entry+size) overlaps a changed range (end inclusive); all tabs when ranges is null. */
export function affectedTabs(ranges: Params["ranges"], tabs: { id: number; entry: Address }[], funcs: FunctionInfo[]): number[] {
  if (!ranges) return tabs.map((t) => t.id);
  const size = new Map(funcs.map((f) => [f.entry, f.size]));
  return tabs.filter((t) => {
    const p = parseAddr(t.entry);
    if (!p) return false;
    const e = p.off + BigInt(Math.max(size.get(t.entry) ?? 1, 1)) - 1n;
    return ranges.some((r) => { const a = offIn(r.start, p.space), b = offIn(r.end, p.space); return a !== null && b !== null && a <= e && b >= p.off; });
  }).map((t) => t.id);
}

/** Kinds that can rename things shown in other functions (callers show a callee's name): every open tab is stale then. */
export const nameAffecting = (kinds: Params["kinds"]) => kinds.some((k) => k === "symbol" || k === "function" || k === "type" || k === "other");

/**
 * Can the function list (name, entry, size) have changed? A renamed function fires only a symbol event, so a symbol change counts when its range
 * covers a known entry (any space) or has no range. Type, data, comment and code edits never rename a function.
 */
export function functionsMayChange(p: Params, funcs: FunctionInfo[]): boolean {
  if (p.kinds.some((k) => k === "function" || k === "other")) return true;
  if (!p.kinds.includes("symbol")) return false;
  if (!p.ranges) return true;
  return p.ranges.some((r) => {
    const ps = parseAddr(r.start), e = parseAddr(r.end);
    if (!ps || !e) return true;
    return funcs.some((f) => { const o = offIn(f.entry, ps.space); return o !== null && o >= ps.off && o <= e.off; });
  });
}

export interface ChangeDeps {
  refetchFunctions(): Promise<FunctionInfo[]>;
  currentFunctions(): FunctionInfo[];
  tabs(): { id: number; entry: Address }[];
  reloadTab(id: number): void;
  refreshListing(ranges: Params["ranges"]): void; // null = refetch from the top row (type edits and other address-less changes)
  refreshXrefs(): void;
  setUndo(u: Params["undo"]): void;
}

/**
 * The one place that reacts to program_changed (edits, undo, redo). Undo state first (menu labels, dirty marker), then:
 * the function list only when names/functions can have changed, tabs (all of them for name-affecting kinds, else those
 * overlapping the ranges), the listing and the xrefs. Views keep their place: tabs re-decompile in place (the editor maps scroll/cursor onto
 * the new text); the listing refetches only its buffered rows that intersect the ranges (all from the top row when a type changed) and keeps
 * its row cursor.
 */
export async function onProgramChanged(p: Params, d: ChangeDeps): Promise<void> {
  d.setUndo(p.undo);
  const broad = nameAffecting(p.kinds);
  const funcs = broad && functionsMayChange(p, d.currentFunctions()) ? await d.refetchFunctions() : d.currentFunctions();
  const open = d.tabs();
  for (const id of broad ? open.map((t) => t.id) : affectedTabs(p.ranges, open, funcs)) d.reloadTab(id);
  d.refreshListing(p.kinds.includes("type") ? null : p.ranges);
  d.refreshXrefs();
}

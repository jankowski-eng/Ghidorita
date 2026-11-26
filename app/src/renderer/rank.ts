import type { Address, SymbolKind } from "../../../protocol";

/** A command-bar candidate. `refs`: places that reference it; `group` only on the empty bar's suggestions. */
export interface Cand { kind: SymbolKind | "string"; name: string; address: Address; refs?: number; group?: "entry" | "import" | "function"; used?: string }
export interface Ranked extends Cand { why: string }

const places = (n: number) => `used in ${n.toLocaleString()} place${n === 1 ? "" : "s"}`;
export const why = (c: Cand): string => (c.group === "entry" ? "entry point" : c.refs ? places(c.refs) : "");

// usefulness tier when nothing is typed: the entry point, then strings and imports, then other functions, then the rest
const tier = (c: Cand) => (c.group === "entry" ? 0 : c.kind === "string" || c.group === "import" ? 1 : c.kind === "function" ? 2 : 3);

/**
 * Orders candidates by usefulness: with a typed name, exact then prefix (case-insensitive) matches first; inside each class (and for an empty or
 * short query) the entry point, then strings and imports, then functions, each by reference count, most used first. Stable otherwise.
 */
export function rank(q: string, cands: Cand[]): Ranked[] {
  const t = q.trim().toLowerCase();
  const m = (c: Cand) => (t && c.kind !== "string" ? (c.name.toLowerCase() === t ? 0 : c.name.toLowerCase().startsWith(t) ? 1 : 2) : 2);
  return cands.map((c, i) => ({ c, i })).sort((a, b) => m(a.c) - m(b.c) || tier(a.c) - tier(b.c) || (b.c.refs ?? 0) - (a.c.refs ?? 0) || a.i - b.i).map(({ c }) => ({ ...c, why: why(c) }));
}

/** Whether a string is worth suggesting as a lead on the empty bar: not a source-file path (`__FILE__` in asserts and logs, referenced
 * from everywhere) and not a very short bare word (`main` as a `__func__`), both of which otherwise outrank every real lead by use count. */
export const isLeadString = (v: string) => !/^\S*\/[^\s/]+\.(c|cc|cpp|cxx|h|hh|hpp|m|mm|swift|rs|go|java|kt|py)$/i.test(v) && !/^\w{1,4}$/.test(v);

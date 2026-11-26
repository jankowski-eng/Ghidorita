import type { Address, FunctionInfo } from "../../../protocol";

/** Functions sorted by entry, for binary search. */
export class FuncIndex {
  readonly sorted: { f: FunctionInfo; start: bigint }[];
  constructor(funcs: FunctionInfo[]) {
    this.sorted = funcs.map((f) => ({ f, start: BigInt(f.entry) })).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }
}

/**
 * The function whose [entry, entry+size) contains the address, or null.
 * shortcut: client-side over list_functions (non-contiguous bodies and size-0 thunks only match at the entry);
 * swap for the get_function_at RPC when it is wired in. This is the only place that decides it.
 */
export function containingFunction(idx: FuncIndex, address: Address): FunctionInfo | null {
  let a: bigint;
  try { a = BigInt(address); } catch { return null; }
  const s = idx.sorted;
  let lo = 0, hi = s.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].start <= a) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i < 0) return null;
  const { f, start } = s[i];
  return a - start < BigInt(Math.max(f.size, 1)) ? f : null;
}

/**
 * Function by exact name, else unique-or-first prefix match (case-insensitive fallback), or null.
 * shortcut: linear client-side scan over list_functions; swap for the search_symbols RPC when it is wired in.
 * This is the only place that resolves names for go-to.
 */
export function findFunctionByName(funcs: FunctionInfo[], query: string): FunctionInfo | null {
  const q = query.toLowerCase();
  return funcs.find((f) => f.name === query) ?? funcs.find((f) => f.name.toLowerCase() === q)
    ?? funcs.find((f) => f.name.startsWith(query)) ?? funcs.find((f) => f.name.toLowerCase().startsWith(q)) ?? null;
}

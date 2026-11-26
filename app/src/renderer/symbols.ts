import type { Address, SymbolHit } from "../../../protocol";
import { rpc } from "./client";
import { offIn, parseAddr } from "./address";

export type FuncAt = { name: string; entry: Address; size: number; signature: string };

// One-entry cache: listing clicks within the same function must not cost an RPC each. Cleared on open and program_changed.
let last: (FuncAt & { start: bigint; space: string }) | null = null;
let gen = 0;
export const clearFunctionCache = () => { last = null; gen++; };

/** The function containing `address`, or null. */
export async function containingFunction(address: Address): Promise<FuncAt | null> {
  const p = parseAddr(address);
  if (!p) return null;
  if (last) { const a = offIn(address, last.space); if (a !== null && a >= last.start && a - last.start < BigInt(Math.max(last.size, 1))) return last; }
  const g = gen;
  const f = await rpc.call("get_function_at", { address });
  const fp = f && parseAddr(f.entry);
  if (g === gen) last = f && fp ? { ...f, start: fp.off, space: fp.space } : null;
  return f;
}

export const searchSymbols = (query: string, limit = 100): Promise<SymbolHit[]> => rpc.call("search_symbols", { query, limit });

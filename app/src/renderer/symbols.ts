import type { Address, SymbolHit } from "../../../protocol";
import { rpc } from "./client";

export type FuncAt = { name: string; entry: Address; size: number; signature: string };

// One-entry cache: listing clicks within the same function must not cost an RPC each. Cleared on open and program_changed.
let last: (FuncAt & { start: bigint }) | null = null;
export const clearFunctionCache = () => { last = null; };

/** The function containing `address`, or null. */
export async function containingFunction(address: Address): Promise<FuncAt | null> {
  let a: bigint;
  try { a = BigInt(address); } catch { return null; }
  if (last && a >= last.start && a - last.start < BigInt(Math.max(last.size, 1))) return last;
  const f = await rpc.call("get_function_at", { address });
  last = f ? { ...f, start: BigInt(f.entry) } : null;
  return f;
}

export const searchSymbols = (query: string, limit = 100): Promise<SymbolHit[]> => rpc.call("search_symbols", { query, limit });

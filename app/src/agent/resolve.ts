import type { Address, SymbolHit } from "../../../protocol";
import type { ProgramOperations } from "../renderer/backend";
import { addressOf } from "../renderer/parseGoto";
import { ToolError } from "./types";

type Ops = Pick<ProgramOperations, "searches" | "functions">;
export interface ResolvedFunction { name: string; entry: Address; size: number; signature: string }

const BARE_HEX = /^[0-9a-f]{1,16}$/i;
const MAX_LISTED = 8;
const show = (h: SymbolHit) => `${h.name} @${h.address} (${h.kind})`;
const distinct = (hits: SymbolHit[]) => [...new Map(hits.map((h) => [h.address, h])).values()];
const ambiguous = (input: string, hits: SymbolHit[]) =>
  new ToolError(`"${input}" is ambiguous: ${hits.slice(0, MAX_LISTED).map(show).join("; ")}${hits.length > MAX_LISTED ? `; … ${hits.length - MAX_LISTED} more` : ""}. Pass one of the addresses.`);

/**
 * Names or addresses. In order: "0x401000" and "code:1000" are addresses; else a symbol named exactly so (then ignoring case); else bare hex ("401000");
 * else a near miss is an error that suggests the candidates. Never a silent guess: several symbols at different addresses is an error that lists them.
 * `functionsOnly` prefers function symbols when the name matches any (what `resolveFunction` wants).
 */
export async function resolveAddress(input: string, ops: Pick<ProgramOperations, "searches">, signal?: AbortSignal, functionsOnly = false): Promise<Address> {
  const s = String(input ?? "").trim();
  if (!s) throw new ToolError("Give an address or a symbol name.");
  if (/^0x/i.test(s)) { const a = addressOf(s); if (a) return a; throw new ToolError(`Not an address: ${s}. Use 0x401000, code:1000 or a symbol name.`); }
  const job = ops.searches.searchSymbols({ query: s, limit: 50 });
  const onAbort = () => job.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  let hits: SymbolHit[];
  try { hits = await job.result; } finally { signal?.removeEventListener("abort", onAbort); }
  hits = hits.filter((h) => !!h.address);
  const level = (match: (n: string) => boolean) => {
    const all = distinct(hits.filter((h) => match(h.name)));
    const fns = all.filter((h) => h.kind === "function");
    return functionsOnly && fns.length ? fns : all;
  };
  const lower = s.toLowerCase();
  for (const found of [level((n) => n === s), level((n) => n.toLowerCase() === lower)]) {
    if (found.length === 1) return found[0].address;
    if (found.length > 1) throw ambiguous(s, found);
  }
  if (BARE_HEX.test(s)) return "0x" + BigInt("0x" + s).toString(16);
  const q = addressOf(s);
  if (q) return q;
  const near = level((n) => n.toLowerCase().startsWith(lower));
  throw new ToolError(near.length ? `No symbol named "${s}". Did you mean: ${near.slice(0, MAX_LISTED).map(show).join("; ")}?` : `No symbol named "${s}". Use search to find it.`);
}

/** The function a name or address stands for: a name resolves to that function, an address to the function containing it. */
export async function resolveFunction(input: string, ops: Ops, signal?: AbortSignal): Promise<ResolvedFunction> {
  const address = await resolveAddress(input, ops, signal, true);
  const f = await ops.functions.containing({ address });
  if (!f) throw new ToolError(`No function contains ${address}. Use create_function there first, or disassemble to look at the code.`);
  return f;
}

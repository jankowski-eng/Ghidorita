import type { Address, SymbolHit } from "../../../protocol";
import { isFailure, type Job, type ProgramOperations } from "../renderer/backend";
import { addressOf } from "../renderer/parseGoto";
import { esc } from "./format";
import { ToolError } from "./types";

type Ops = Pick<ProgramOperations, "searches" | "functions">;
export interface ResolvedFunction { name: string; entry: Address; size: number; signature: string }

const BARE_HEX = /^[0-9a-f]{1,16}$/i;
const MAX_LISTED = 8;
const show = (h: SymbolHit) => `${esc(h.name, 80)} @${h.address} (${h.kind})`;
const distinct = (hits: SymbolHit[]) => [...new Map(hits.map((h) => [h.address, h])).values()];
const ambiguous = (input: string, hits: SymbolHit[]) =>
  new ToolError(`"${input}" is ambiguous: ${hits.slice(0, MAX_LISTED).map(show).join("; ")}${hits.length > MAX_LISTED ? `; … ${hits.length - MAX_LISTED} more` : ""}. Pass one of the addresses.`);

const SEARCH_LIMIT = 500;
/** Runs a scan job, cancelling it when the call is cancelled. */
async function run<T>(job: Job<T>, signal?: AbortSignal): Promise<T> {
  const onAbort = () => job.cancel();
  if (signal?.aborted) onAbort(); // already cancelled: the listener would never fire
  signal?.addEventListener("abort", onAbort, { once: true });
  try { return await job.result; } finally { signal?.removeEventListener("abort", onAbort); }
}

/**
 * Names or addresses. In order: "0x401000" and "code:1000" are addresses; else the symbols named exactly so (the provider's name index when it has `exactSymbolSearch`:
 * every one of them, however many others contain the text); else, with the substring search, a symbol named so ignoring case; else bare hex ("401000", five or more digits);
 * else a near miss is an error that suggests the candidates. Never a silent guess: several symbols at different addresses is an error that lists them, and a name that
 * matches more symbols than the substring search can return is an error too (it could hide a second symbol of that name).
 * `functionsOnly` prefers function symbols when the name matches any (what `resolveFunction` wants).
 */
export async function resolveAddress(input: string, ops: Pick<ProgramOperations, "searches">, signal?: AbortSignal, functionsOnly = false): Promise<Address> {
  const s = String(input ?? "").trim();
  if (!s) throw new ToolError("Give an address or a symbol name.");
  if (/^0x/i.test(s)) { const a = addressOf(s); if (a) return a; throw new ToolError(`Not an address: ${s}. Use 0x401000, code:1000 or a symbol name.`); }
  const prefer = (all: SymbolHit[]) => { const fns = all.filter((h) => h.kind === "function"); return functionsOnly && fns.length ? fns : all; };
  let exact: SymbolHit[] | null = null; // null: the provider has no exact lookup
  try { exact = distinct((await run(ops.searches.searchSymbols({ query: s, limit: SEARCH_LIMIT, exact: true }), signal)).filter((h) => !!h.address)); } catch (e) { if (!isFailure(e, "unsupported")) throw e; }
  if (exact) { const found = prefer(exact); if (found.length === 1) return found[0].address; if (found.length > 1) throw ambiguous(s, found); }
  const hits = (await run(ops.searches.searchSymbols({ query: s, limit: SEARCH_LIMIT }), signal)).filter((h) => !!h.address);
  const truncated = hits.length >= SEARCH_LIMIT; // the substring search stops there, in the provider's order: what is missing could be the name, or a second symbol of it
  const level = (match: (n: string) => boolean) => prefer(distinct(hits.filter((h) => match(h.name))));
  const lower = s.toLowerCase();
  if (!truncated) for (const found of [exact ? [] : level((n) => n === s), level((n) => n.toLowerCase() === lower)]) {
    if (found.length === 1) return found[0].address;
    if (found.length > 1) throw ambiguous(s, found);
  }
  // a short bare-hex word ("bad", "cafe") is far more likely a mistyped name than an address: never guess it
  if (BARE_HEX.test(s) && s.length >= 5) return "0x" + BigInt("0x" + s).toString(16);
  const q = addressOf(s);
  if (q) return q;
  if (truncated) throw new ToolError(`"${esc(s, 80)}" is contained in ${SEARCH_LIMIT} or more symbol names, too many to resolve by name${exact ? " (and no symbol is named exactly that; names are case-sensitive here)" : ""}. Pass an address, or the exact name.`);
  const near = level((n) => n.toLowerCase().startsWith(lower));
  const hint = BARE_HEX.test(s) ? ` If you meant the address, write 0x${s}.` : "";
  throw new ToolError(hint ? `No symbol named "${esc(s, 80)}".${hint}` : near.length ? `No symbol named "${esc(s, 80)}". Did you mean: ${near.slice(0, MAX_LISTED).map(show).join("; ")}?` : `No symbol named "${esc(s, 80)}". Use search to find it.`);
}

/** The function a name or address stands for: a name resolves to that function, an address to the function containing it. */
export async function resolveFunction(input: string, ops: Ops, signal?: AbortSignal): Promise<ResolvedFunction> {
  const address = await resolveAddress(input, ops, signal, true);
  const f = await ops.functions.containing({ address });
  if (!f) throw new ToolError(`No function contains ${address}. Use create_function there first, or disassemble to look at the code.`);
  return f;
}

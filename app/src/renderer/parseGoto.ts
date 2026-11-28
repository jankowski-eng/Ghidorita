import type { Address, SymbolHit } from "../../../protocol";
import { fmtAddr, parseAddr } from "./address";

export type GotoResult = { address: Address } | { error: string };
export type Search = (query: string) => Promise<SymbolHit[]>;

const HEX = /^(0x)?[0-9a-f]{1,16}$/i;
const QUAL = /^[^:\s]+::?[0-9a-f]{1,16}$/i; // "code:1000", "OVL1::1000" (see protocol.md); "std::add" matches too, so a symbol of that name wins first
const qual = (s: string): GotoResult => { const p = parseAddr(s)!; return { address: fmtAddr(p.space, p.off) }; };
const MAX = (1n << 64n) - 1n;
const norm = (h: string): GotoResult => { const v = BigInt(/^0x/i.test(h) ? h : "0x" + h); return v > MAX ? { error: "address out of range" } : { address: "0x" + v.toString(16) }; };

/** Best hit for a typed name: exact, then exact ignoring case, then prefix; functions first, then the sidecar's order. */
export function pickHit(hits: SymbolHit[], query: string): SymbolHit | null {
  const q = query.toLowerCase();
  const rank = (h: SymbolHit) => {
    const n = h.name.toLowerCase();
    const m = h.name === query ? 0 : n === q ? 1 : n.startsWith(q) ? 2 : -1;
    return m < 0 ? -1 : m * 2 + (h.kind === "function" ? 0 : 1);
  };
  let best: SymbolHit | null = null, br = Infinity;
  for (const h of hits) { const r = rank(h); if (r >= 0 && r < br) { best = h; br = r; } }
  return best;
}

/** Go-to input: 0x-hex; else (with `exact`, the provider's exact-name lookup) a symbol whose name is exactly the input; else a symbol whose name is exactly the input among the substring hits (so "add" stays a name); else bare hex or a space-qualified address; else the best name match. */
export async function resolveGoto(input: string, search: Search, exact?: Search): Promise<GotoResult> {
  const s = input.trim();
  if (!s) return { error: "enter an address or symbol name" };
  if (/^0x/i.test(s)) return HEX.test(s) ? norm(s) : { error: `not an address: ${s}` };
  const named = exact ? await exact(s) : []; // the provider's name index: found however many other names contain the text (the substring search below stops after its limit)
  if (named.length) return { address: named[0].address };
  const hits = await search(s);
  const exactHit = hits.find((h) => h.name === s);
  if (exactHit) return { address: exactHit.address };
  if (HEX.test(s)) return norm(s);
  if (QUAL.test(s)) return qual(s);
  const h = pickHit(hits, s);
  return h ? { address: h.address } : { error: `no symbol named ${s}` };
}

/** Sync address check for the command bar: "0x..." or a space-qualified address; bare hex stays a name search (it may be a symbol). */
export const addressOf = (input: string): Address | null => {
  const s = input.trim();
  if (/^0x/i.test(s)) { if (!HEX.test(s)) return null; const r = norm(s); return "address" in r ? r.address : null; }
  if (!QUAL.test(s)) return null;
  const r = qual(s);
  return "address" in r ? r.address : null;
};

import type { Address, SymbolHit } from "../../../protocol";

export type GotoResult = { address: Address } | { error: string };
export type Search = (query: string) => Promise<SymbolHit[]>;

const HEX = /^(0x)?[0-9a-f]{1,16}$/i;
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

/** Go-to input: 0x-hex; else a symbol whose name is exactly the input (so "add" stays a name); else bare hex; else the best name match. */
export async function resolveGoto(input: string, search: Search): Promise<GotoResult> {
  const s = input.trim();
  if (!s) return { error: "enter an address or symbol name" };
  if (/^0x/i.test(s)) return HEX.test(s) ? norm(s) : { error: `not an address: ${s}` };
  const hits = await search(s);
  const exact = hits.find((h) => h.name === s);
  if (exact) return { address: exact.address };
  if (HEX.test(s)) return norm(s);
  const h = pickHit(hits, s);
  return h ? { address: h.address } : { error: `no symbol named ${s}` };
}

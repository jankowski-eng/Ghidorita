import type { FunctionInfo } from "../../../protocol";
import type { AddrMap } from "./addrmap";

export interface Span { pos: number; len: number } // byte position in the AddrMap (gaps between ranges are not counted) and length

/** Function bodies as spans of the map; a function outside every range (other space, bad size) maps to a zero-length span and is dropped. */
export const funcSpans = (map: AddrMap, funcs: FunctionInfo[]): Span[] =>
  funcs.map((f) => ({ pos: map.posOf(f.entry), len: Math.max(f.size, 1) })).filter((s) => s.pos < map.total);

/** Fraction (0..1) of each of `n` equal slices of the map that the spans cover. Spans may overlap; the result is capped at 1. */
export function fill(total: number, spans: Span[], n: number): Float32Array {
  const out = new Float32Array(n);
  if (total <= 0 || n <= 0) return out;
  const w = total / n;
  for (const s of spans) {
    const a = Math.max(0, s.pos), z = Math.min(total, s.pos + s.len);
    if (z <= a) continue;
    for (let i = Math.floor(a / w); i <= Math.min(n - 1, Math.floor((z - 1) / w)); i++) out[i] += (Math.min(z, (i + 1) * w) - Math.max(a, i * w)) / w;
  }
  for (let i = 0; i < n; i++) if (out[i] > 1) out[i] = 1;
  return out;
}

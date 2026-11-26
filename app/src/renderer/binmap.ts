import type { FunctionInfo } from "../../../protocol";
import type { AddrMap } from "./addrmap";
import type { Coverage } from "./coverage";

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

/** Executed ranges as map spans. shortcut: default space only (coverage files name no other), a range across a gap between loaded ranges counts the gap too. */
export const coverageSpans = (map: AddrMap, cov: Coverage): Span[] =>
  cov.spans().map(([lo, hi]) => ({ pos: map.pos(lo), len: Number(hi - lo + 1n) })).filter((s) => s.pos < map.total);

/** Tooltip text for map position `pos`: its address and the function containing it, else the loaded range. `sorted` = funcSpans-like entries by pos. shortcut: nested/overlapping bodies resolve to the last one starting before pos. */
export function describeAt(map: AddrMap, funcs: FunctionInfo[], pos: number): string {
  const p = Math.max(0, Math.min(Math.floor(pos), map.total - 1)), addr = map.addr(p);
  const f = funcs.filter((x) => { const s = map.posOf(x.entry); return s <= p && p < s + Math.max(x.size, 1) && s < map.total; }).pop();
  if (f) return `${addr} · ${f.name}`;
  let i = map.cum.length - 1; while (i > 0 && map.cum[i] > p) i--;
  return `${addr} · no function (range ${map.ranges[i].start}, ${map.ranges[i].size} B)`;
}

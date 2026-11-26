import type { Address, AddrRange } from "../../../protocol";
import { fmtAddr, parseAddr } from "./address";

/**
 * Scroll position <-> address, over cumulative range sizes (the idea of Ghidra's AddressIndexMap, without rows).
 * Ranges keep the sidecar's order (spaces in Ghidra's space order, ascending inside a space); a space's rank is its first appearance.
 */
export class AddrMap {
  readonly spaces: string[];  // space prefix per range ("" = default space)
  readonly starts: bigint[];
  readonly cum: number[]; // cum[i] = bytes before range i
  readonly total: number;
  private readonly rank = new Map<string, number>();
  constructor(readonly ranges: AddrRange[]) {
    const ps = ranges.map((r) => parseAddr(r.start)!);
    this.spaces = ps.map((p) => p.space);
    this.starts = ps.map((p) => p.off);
    this.spaces.forEach((s) => { if (!this.rank.has(s)) this.rank.set(s, this.rank.size); });
    let c = 0;
    this.cum = ranges.map((r) => { const v = c; c += r.size; return v; });
    this.total = c; // shortcut: bytes as JS numbers, exact below 2^53 (9 PB), fine
  }
  /** byte position of an address string; a gap maps to the start of the next range, past the end to the last byte, an unknown space to 0 */
  posOf(address: Address): number {
    const p = parseAddr(address);
    return p ? this.pos(p.off, p.space) : 0;
  }
  /** same, for an offset in a space ("" = default space) */
  pos(a: bigint, space = ""): number {
    const r = this.rank.get(space);
    if (r === undefined) return 0;
    const before = (i: number) => { const ri = this.rank.get(this.spaces[i])!; return ri < r || (ri === r && this.starts[i] <= a); }; // range i starts at or before a
    let lo = 0, hi = this.starts.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (before(m)) { i = m; lo = m + 1; } else hi = m - 1; }
    if (i < 0) return 0;
    if (this.spaces[i] === space) {
      const off = Number(a - this.starts[i]);
      if (off < this.ranges[i].size) return this.cum[i] + off;
    }
    return i + 1 < this.starts.length ? this.cum[i + 1] : Math.max(0, this.total - 1);
  }
  addr(pos: number): Address {
    pos = Math.max(0, Math.min(Math.floor(pos), this.total - 1));
    let lo = 0, hi = this.cum.length - 1, i = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.cum[m] <= pos) { i = m; lo = m + 1; } else hi = m - 1; }
    return fmtAddr(this.spaces[i], this.starts[i] + BigInt(pos - this.cum[i]));
  }
}

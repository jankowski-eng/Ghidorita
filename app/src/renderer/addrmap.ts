import type { Address, AddrRange } from "../../../protocol";

/** Scroll position <-> address, over cumulative range sizes (the idea of Ghidra's AddressIndexMap, without rows). */
export class AddrMap {
  readonly starts: bigint[];
  readonly cum: number[]; // cum[i] = bytes before range i
  readonly total: number;
  constructor(readonly ranges: AddrRange[]) {
    this.starts = ranges.map((r) => BigInt(r.start));
    let c = 0;
    this.cum = ranges.map((r) => { const v = c; c += r.size; return v; });
    this.total = c; // shortcut: bytes as JS numbers, exact below 2^53 (9 PB), fine
  }
  /** byte position of an address; a gap maps to the start of the next range, past the end to the last byte */
  pos(a: bigint): number {
    let lo = 0, hi = this.starts.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.starts[m] <= a) { i = m; lo = m + 1; } else hi = m - 1; }
    if (i < 0) return 0;
    const off = Number(a - this.starts[i]);
    if (off < this.ranges[i].size) return this.cum[i] + off;
    return i + 1 < this.starts.length ? this.cum[i + 1] : Math.max(0, this.total - 1);
  }
  addr(pos: number): Address {
    pos = Math.max(0, Math.min(Math.floor(pos), this.total - 1));
    let lo = 0, hi = this.cum.length - 1, i = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.cum[m] <= pos) { i = m; lo = m + 1; } else hi = m - 1; }
    return "0x" + (this.starts[i] + BigInt(pos - this.cum[i])).toString(16);
  }
}

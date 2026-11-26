import type { Address } from "../../../protocol";

type Range = { start: Address; end: Address };

/** Executed address ranges (end inclusive), merged and sorted; `has` asks whether a code unit overlaps any of them. */
export class Coverage {
  private lo: bigint[] = [];
  private hi: bigint[] = [];
  constructor(ranges: Range[]) {
    const r = ranges.map((x) => [BigInt(x.start), BigInt(x.end)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [s, e] of r) {
      const n = this.lo.length - 1;
      if (n >= 0 && s <= this.hi[n] + 1n) { if (e > this.hi[n]) this.hi[n] = e; } else { this.lo.push(s); this.hi.push(e); }
    }
  }
  get size() { return this.lo.length; }
  has(address: Address, length: number): boolean {
    if (!address.startsWith("0x")) return false; // shortcut: coverage files name default-space addresses only (load_coverage), other spaces are never covered; upgrade with qualified ranges
    const a = BigInt(address), z = a + BigInt(Math.max(length, 1)) - 1n;
    let i = 0, j = this.lo.length; // last range starting at or before z
    while (i < j) { const m = (i + j) >> 1; if (this.lo[m] <= z) i = m + 1; else j = m; }
    return i > 0 && this.hi[i - 1] >= a;
  }
}

/** The loaded coverage (one set per session; cleared when a program opens or closes). Listing reads it at render time. */
export const coverage: { current: Coverage | null } = { current: null };

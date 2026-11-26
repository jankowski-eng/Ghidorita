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
  /** The merged ranges, inclusive ends, sorted. */
  spans(): [bigint, bigint][] { return this.lo.map((l, i) => [l, this.hi[i]]); }
  bytes(): bigint { return this.lo.reduce((n, l, i) => n + (this.hi[i] - l + 1n), 0n); }
  has(address: Address, length: number): boolean {
    if (!address.startsWith("0x")) return false; // shortcut: coverage files name default-space addresses only (load_coverage), other spaces are never covered; upgrade with qualified ranges
    const a = BigInt(address), z = a + BigInt(Math.max(length, 1)) - 1n;
    let i = 0, j = this.lo.length; // last range starting at or before z
    while (i < j) { const m = (i + j) >> 1; if (this.lo[m] <= z) i = m + 1; else j = m; }
    return i > 0 && this.hi[i - 1] >= a;
  }
}

/** Bytes in both sets, by a sweep over their merged ranges. */
export function sharedBytes(a: Coverage, b: Coverage): bigint {
  const x = a.spans(), y = b.spans();
  let i = 0, j = 0, n = 0n;
  while (i < x.length && j < y.length) {
    const lo = x[i][0] > y[j][0] ? x[i][0] : y[j][0], hi = x[i][1] < y[j][1] ? x[i][1] : y[j][1];
    if (hi >= lo) n += hi - lo + 1n;
    if (x[i][1] < y[j][1]) i++; else j++;
  }
  return n;
}

type Spans = [bigint, bigint][];
/** Sorted, merged inclusive spans in both `x` and `y` (intersect) or in `x` but not `y` (subtract). */
export function intersectSpans(x: Spans, y: Spans): Spans {
  const out: Spans = [];
  for (let i = 0, j = 0; i < x.length && j < y.length;) {
    const lo = x[i][0] > y[j][0] ? x[i][0] : y[j][0], hi = x[i][1] < y[j][1] ? x[i][1] : y[j][1];
    if (hi >= lo) out.push([lo, hi]);
    if (x[i][1] < y[j][1]) i++; else j++;
  }
  return out;
}
export function subtractSpans(x: Spans, y: Spans): Spans {
  const out: Spans = [];
  let j = 0;
  for (const [a, b] of x) {
    let lo = a;
    while (j < y.length && y[j][1] < lo) j++;
    for (let k = j; k < y.length && y[k][0] <= b; k++) { if (y[k][0] > lo) out.push([lo, y[k][0] - 1n]); lo = y[k][1] + 1n; if (lo > b) break; }
    if (lo <= b) out.push([lo, b]);
  }
  return out;
}

export interface Run { id: number; name: string; cov: Coverage }

/**
 * Named coverage runs. Up to two are shown at once: A alone tints what A executed (green); A and B together tint what both executed (green),
 * only A (orange) and only B (blue), which is the difference between two runs. One set per program; cleared when a program opens or closes.
 */
export class CoverageRuns {
  runs: Run[] = [];
  a: number | null = null;
  b: number | null = null;
  private next = 1;
  add(name: string, cov: Coverage): Run {
    const r = { id: this.next++, name, cov };
    this.runs.push(r);
    if (this.a === null) this.a = r.id; else if (this.b === null) this.b = r.id; else this.a = r.id; // first run A, second B (the comparison shows at once), later ones replace A
    return r;
  }
  get(id: number | null): Run | undefined { return id === null ? undefined : this.runs.find((r) => r.id === id); }
  remove(id: number) { this.runs = this.runs.filter((r) => r.id !== id); if (this.a === id) this.a = null; if (this.b === id) this.b = null; }
  rename(id: number, name: string) { const r = this.get(id); if (r && name.trim()) r.name = name.trim(); }
  /** Show run `id` (or none) as A or B; the same run is never both. */
  select(slot: "a" | "b", id: number | null) {
    this[slot] = id;
    const other = slot === "a" ? "b" : "a";
    if (id !== null && this[other] === id) this[other] = null;
  }
  clear() { this.runs = []; this.a = this.b = null; }
  get shown(): boolean { return this.a !== null || this.b !== null; }
  /** The listing's row class for a code unit: "" (nothing), " cov" (covered; with two runs: by both), " cov-a" (only A), " cov-b" (only B). */
  mark(address: Address, length: number): string { return this.markAny([address], length); }
  /** Same for several addresses at once (a decompiler line): covered in a run when any of them is. */
  markAny(addresses: Address[], length = 1): string {
    const ca = this.get(this.a), cb = this.get(this.b);
    const ina = !!ca && addresses.some((x) => ca.cov.has(x, length)), inb = !!cb && addresses.some((x) => cb.cov.has(x, length));
    if (ca && cb) return ina && inb ? " cov" : ina ? " cov-a" : inb ? " cov-b" : "";
    return ina || inb ? " cov" : "";
  }
  /** Functions (any overlap with the body counts) reached only in A and only in B; null unless two runs are shown. */
  funcDiff<F extends { entry: Address; size: number }>(funcs: F[]): { onlyA: F[]; onlyB: F[] } | null {
    const ca = this.get(this.a), cb = this.get(this.b);
    if (!ca || !cb) return null;
    const hit = (c: Coverage, f: F) => c.has(f.entry, f.size);
    return { onlyA: funcs.filter((f) => hit(ca.cov, f) && !hit(cb.cov, f)), onlyB: funcs.filter((f) => hit(cb.cov, f) && !hit(ca.cov, f)) };
  }
  /** Bytes only in A, only in B and in both; null unless two runs are shown. */
  diff(): { onlyA: bigint; onlyB: bigint; both: bigint } | null {
    const ca = this.get(this.a), cb = this.get(this.b);
    if (!ca || !cb) return null;
    const both = sharedBytes(ca.cov, cb.cov);
    return { onlyA: ca.cov.bytes() - both, onlyB: cb.cov.bytes() - both, both };
  }
}

export const coverage = new CoverageRuns();

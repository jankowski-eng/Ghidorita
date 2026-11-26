import type { Address, AddrRange } from "../../../protocol";
import { fmtAddr, parseAddr } from "./address";

/** Bytes per row of the hex view. */
export const ROW = 16;
const N = BigInt(ROW);

/**
 * The hex view's rows over the mapped (loaded + initialized) ranges: a "data" segment is one range cut into aligned rows (the first and last
 * row may be partly outside it), a "gap" segment is one row standing for the unmapped bytes between two ranges of the same space.
 * `lo`..`hi` is the mapped byte range [lo, hi) (a gap's own span), `base` the address of the segment's first row, `row` its first row index.
 */
export interface HexSeg { kind: "data" | "gap"; space: string; lo: bigint; hi: bigint; base: bigint; row: number; rows: number }
export interface HexLayout { segs: HexSeg[]; rows: number }

export function hexLayout(ranges: AddrRange[]): HexLayout {
  const segs: HexSeg[] = [];
  let rows = 0, prev: { space: string; hi: bigint } | null = null;
  for (const r of ranges) {
    const p = parseAddr(r.start);
    if (!p || r.size < 1) continue;
    const lo = p.off, hi = p.off + BigInt(r.size);
    if (prev && prev.space === p.space && prev.hi < lo) segs.push({ kind: "gap", space: p.space, lo: prev.hi, hi: lo, base: prev.hi, row: rows++, rows: 1 });
    const base = lo - (lo % N), n = Number((hi - base + N - 1n) / N);
    segs.push({ kind: "data", space: p.space, lo, hi, base, row: rows, rows: n });
    rows += n;
    prev = { space: p.space, hi };
  }
  return { segs, rows };
}

/** The segment that holds row index `row` (binary search); null past the end. */
export function segAt(l: HexLayout, row: number): HexSeg | null {
  let lo = 0, hi = l.segs.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, s = l.segs[m];
    if (row < s.row) hi = m - 1; else if (row >= s.row + s.rows) lo = m + 1; else return s;
  }
  return null;
}

/** The row an address is on (a data row, or the gap row for an unmapped byte between two ranges); null when it is in none. */
export function rowOf(l: HexLayout, space: string, off: bigint): number | null {
  for (const s of l.segs) if (s.space === space && off >= s.lo && off < s.hi) return s.kind === "gap" ? s.row : s.row + Number((off - s.base) / N);
  return null;
}

export interface HexLine {
  address: Address;        // of the row's first byte (16-aligned)
  base: bigint; space: string;
  cells: string[];         // two characters each: "48"; "  " outside the mapped range, "··" still loading, "??" could not be read
  ascii: string;           // one character per cell
  gap?: string;            // a gap row: the text replacing the bytes
}
const hex2 = (v: number) => (v < 16 ? "0" : "") + v.toString(16);
const spanText = (s: HexSeg) => `${fmtAddr(s.space, s.lo)} – ${fmtAddr(s.space, s.hi - 1n)}`;

/**
 * Row `k` of segment `s`. `read(offset)` gives a byte, `undefined` while it is being fetched and `null` when it could not be read.
 * Unmapped or uninitialised bytes are never asked for: they show as blanks (partial rows) or as a gap row, not as errors.
 */
export function formatRow(s: HexSeg, k: number, read: (off: bigint) => number | null | undefined): HexLine {
  if (s.kind === "gap") {
    const size = s.hi - s.lo;
    return { address: fmtAddr(s.space, s.lo), base: s.lo, space: s.space, cells: [], ascii: "", gap: `${spanText(s)} unmapped (${size} byte${size === 1n ? "" : "s"})` };
  }
  const base = s.base + BigInt(k) * N, cells: string[] = [];
  let ascii = "";
  for (let i = 0; i < ROW; i++) {
    const o = base + BigInt(i);
    if (o < s.lo || o >= s.hi) { cells.push("  "); ascii += " "; continue; }
    const v = read(o);
    if (v === undefined) { cells.push("··"); ascii += " "; }
    else if (v === null) { cells.push("??"); ascii += "?"; }
    else { cells.push(hex2(v)); ascii += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : "."; }
  }
  return { address: fmtAddr(s.space, base), base, space: s.space, cells, ascii };
}

/** "48 8b 05" -> [0x48, 0x8b, 0x05]; null when it is not that many hex bytes. */
export function parseHex(text: string, count: number): number[] | null {
  const parts = text.split(" ");
  if (parts.length !== count) return null;
  const out = parts.map((p) => (/^[0-9a-f]{2}$/i.test(p) ? parseInt(p, 16) : -1));
  return out.includes(-1) ? null : out;
}

/** The mapped byte `delta` bytes from `off` (a step over a gap or into another range lands on the nearest mapped byte in that direction); null at the ends. */
export function stepByte(l: HexLayout, space: string, off: bigint, delta: number): { space: string; off: bigint } | null {
  const data = l.segs.filter((s) => s.kind === "data");
  const i = data.findIndex((s) => s.space === space && off >= s.lo && off < s.hi);
  if (i < 0) return null;
  const want = off + BigInt(delta), s = data[i];
  if (want >= s.lo && want < s.hi) return { space, off: want };
  if (delta > 0) { const n = data.slice(i + 1).find((x) => x.space === space && x.hi > want); return n ? { space, off: n.lo > want ? n.lo : want } : off === s.hi - 1n ? null : { space, off: s.hi - 1n }; }
  const p = [...data.slice(0, i)].reverse().find((x) => x.space === space && x.lo <= want);
  return p ? { space, off: p.hi - 1n < want ? p.hi - 1n : want } : off === s.lo ? null : { space, off: s.lo };
}

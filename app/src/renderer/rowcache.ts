import type { Address, ListingRow } from "../../../protocol";
import { addrAdd, intersects, parseAddr, type Parsed } from "./address";

export type Range = { start: Address; end: Address };
const parsed = new WeakMap<ListingRow, Parsed>();
/** parsed start address of a row (cached: rows are immutable once fetched) */
export const rowAt = (r: ListingRow): Parsed => { let p = parsed.get(r); if (!p) { p = parseAddr(r.address)!; parsed.set(r, p); } return p; };

/** Index of the row whose code unit contains the address (a unit is at least 1 byte), or -1. */
export function indexAt(rows: ListingRow[], a: Parsed): number {
  return rows.findIndex((r) => { const p = rowAt(r); return p.space === a.space && a.off >= p.off && a.off < p.off + BigInt(Math.max(r.length, 1)); });
}

export interface Run { rows: ListingRow[]; atStart: boolean; atEnd: boolean }

/**
 * Contiguous runs of rows kept besides the active one (a jump back into a run shown earlier needs no fetch). LRU, each run is
 * trimmed by the caller. Runs that overlap a newly stored one are dropped (the new data is newer).
 * shortcut: runs are never merged when they grow into each other (the overlap check drops the older one), upgrade if flinging back and
 * forth between two nearby places shows up as refetches.
 */
export class RunCache {
  runs: Run[] = [];
  constructor(readonly max = 4) {}
  /** Remove and return the run holding the address, if any. */
  take(a: Parsed): Run | null {
    const i = this.runs.findIndex((r) => indexAt(r.rows, a) >= 0);
    return i < 0 ? null : this.runs.splice(i, 1)[0];
  }
  put(run: Run): void {
    if (!run.rows.length) return;
    const first = rowAt(run.rows[0]), last = rowAt(run.rows[run.rows.length - 1]);
    this.runs = this.runs.filter((o) => indexAt(o.rows, first) < 0 && indexAt(o.rows, last) < 0 && indexAt(run.rows, rowAt(o.rows[0])) < 0);
    this.runs.unshift(run);
    if (this.runs.length > this.max) this.runs.length = this.max;
  }
  /** Drop runs with a row in the changed ranges (null = everything). */
  invalidate(ranges: Range[] | null): void {
    this.runs = ranges ? this.runs.filter((r) => !r.rows.some((x) => intersects(rowAt(x), x.length, ranges))) : [];
  }
}

export type Fetch = (address: Address, count: number) => Promise<ListingRow[]>;
const SLACK = 8, MAX_FETCH = 2000;

/**
 * Refetch the buffered rows that intersect the changed ranges, in place. Returns null when no row intersects (nothing to do), else the new rows
 * and whether the end of the listing is now in the buffer. Rows are refetched forward from the first affected one until the new rows cover the
 * old affected span; the old rows behind are kept when they continue exactly where the new rows end (else dropped, the caller's prefetch refills
 * the buffer). Units can split or merge (clear/define data), so counts differ from the old ones.
 * shortcut: rows outside the ranges that merely show an affected row's data (xref counts of a call's target) are not refetched, upgrade by
 * also invalidating the targets of the changed references.
 */
export async function spliceRows(rows: ListingRow[], ranges: Range[], fetch: Fetch, atEnd = false): Promise<{ rows: ListingRow[]; atEnd: boolean } | null> {
  let i = -1, j = -1;
  rows.forEach((r, k) => { if (intersects(rowAt(r), r.length, ranges)) { if (i < 0) i = k; j = k; } });
  if (i < 0) return null;
  const bound = rowAt(rows[j]), boundEnd = bound.off + BigInt(Math.max(rows[j].length, 1));
  const out: ListingRow[] = [];
  let addr = rows[i].address, end = false, reached = false;
  while (!reached && !end && out.length < MAX_FETCH) {
    const ask = Math.min(1000, Math.max(16, j - i + 1 - out.length + SLACK));
    const batch = await fetch(addr, ask);
    for (const r of batch) {
      out.push(r);
      const p = rowAt(r);
      if (p.space === bound.space && p.off + BigInt(Math.max(r.length, 1)) >= boundEnd) { reached = true; break; }
    }
    if (batch.length < ask) end = true; // the sidecar ran out of rows: the listing ends here
    if (batch.length) addr = addrAdd(batch[batch.length - 1].address, batch[batch.length - 1].length);
    else end = true;
  }
  const before = rows.slice(0, i);
  if (!reached) return { rows: [...before, ...out], atEnd: end };
  const last = out[out.length - 1], lp = rowAt(last), next = lp.off + BigInt(Math.max(last.length, 1));
  const tail = rows.slice(j + 1);
  const keep = tail.length > 0 && rowAt(tail[0]).space === lp.space && rowAt(tail[0]).off === next;
  if (!tail.length) return { rows: [...before, ...out], atEnd: atEnd || end };
  return keep ? { rows: [...before, ...out, ...tail], atEnd } : { rows: [...before, ...out], atEnd: false };
}

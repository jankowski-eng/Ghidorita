import type { Address, PcodeResult } from "../../../protocol";
import { parseAddr } from "./address";

export type PcodeMode = "raw" | "high";
export interface PcodeLine { text: string; address?: Address; head?: boolean } // head: an instruction or block header line

/** The lines of the pane: raw = each instruction's address and text, its ops indented below; high = ops in block order under a block header, each with its instruction's address. */
export function pcodeLines(r: PcodeResult, mode: PcodeMode): PcodeLine[] {
  const out: PcodeLine[] = [];
  if (mode === "raw") {
    for (const i of r.raw) {
      out.push({ text: `${i.address}  ${i.asm}`, address: i.address, head: true });
      for (const o of i.ops) out.push({ text: "    " + o, address: i.address });
    }
  } else {
    let block = -1;
    for (const o of r.high) {
      if (o.block !== block) { block = o.block; out.push({ text: `block ${block}`, head: true }); }
      out.push({ text: `${o.address}  ${o.text}`, address: o.address });
    }
  }
  return out;
}

/** Indices of the lines that belong to the instruction the cursor is on: those of the greatest line address at or below it in the same space (none when there is none). */
export function linesAt(lines: PcodeLine[], cursor: Address | null): number[] {
  const c = cursor ? parseAddr(cursor) : null;
  if (!c) return [];
  let best: bigint | null = null;
  const seen = lines.map((l) => (l.address ? parseAddr(l.address) : null));
  for (const p of seen) if (p && p.space === c.space && p.off <= c.off && (best === null || p.off > best)) best = p.off;
  if (best === null) return [];
  return seen.flatMap((p, i) => (p && p.space === c.space && p.off === best ? [i] : []));
}

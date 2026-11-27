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

/**
 * Indices of the lines of the instruction the cursor is on: the one of `instrs` (address and length) that contains the cursor, and only lines with
 * exactly that address count, so data after the function, holes in its body and instructions the decompiler optimised away mark nothing.
 * An instruction without a length counts as one byte.
 */
export function linesAt(lines: PcodeLine[], cursor: Address | null, instrs: { address: Address; length?: number }[]): number[] {
  const c = cursor ? parseAddr(cursor) : null;
  if (!c) return [];
  let best: bigint | null = null;
  for (const i of instrs) { const p = parseAddr(i.address); if (p && p.space === c.space && p.off <= c.off && c.off < p.off + BigInt(Math.max(1, i.length ?? 1))) best = p.off; }
  if (best === null) return [];
  return lines.flatMap((l, i) => { const p = l.address ? parseAddr(l.address) : null; return p && p.space === c.space && p.off === best ? [i] : []; });
}

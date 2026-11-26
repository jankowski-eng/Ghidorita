import type { Address } from "../../../protocol";

/** An address split into its space prefix ("" = default space, "code:" / "OVL1::" otherwise, as sent) and its unsigned offset. */
export interface Parsed { space: string; off: bigint }

const MAX = (1n << 64n) - 1n;

/** protocol.md: "0x401000" | "<space>:<hex>" | "<space>::<hex>"; null when it is none of these or the offset exceeds 64 bits. */
export function parseAddr(a: string): Parsed | null {
  const m = /^(?:(0x)|(.+?:))([0-9a-f]{1,16})$/i.exec(a.trim());
  if (!m) return null;
  return { space: m[1] ? "" : m[2], off: BigInt("0x" + m[3]) };
}

export const fmtAddr = (space: string, off: bigint): Address => (space ? space : "0x") + off.toString(16);

/** a + n bytes in the same space (not wrapping past 2^64: clamps). */
export function addrAdd(a: Address, n: number | bigint): Address {
  const p = parseAddr(a)!;
  const v = p.off + BigInt(n);
  return fmtAddr(p.space, v > MAX ? MAX : v);
}

/** Does the code unit [a, a+length) intersect any of the (inclusive) change ranges? Different spaces never intersect. */
export function intersects(a: Parsed, length: number, ranges: { start: Address; end: Address }[]): boolean {
  const e = a.off + BigInt(Math.max(length, 1)) - 1n;
  return ranges.some((r) => {
    const s = parseAddr(r.start), t = parseAddr(r.end);
    return !!s && !!t && s.space === a.space && s.off <= e && t.off >= a.off;
  });
}

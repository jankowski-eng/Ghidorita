import type { Address, DebugState, Token } from "../../../protocol";

/** The debugger state the store keeps: the provider's state plus the registers that differ from the previous stop. */
export type DebugView = DebugState & { changed: Record<string, string> }; // changed: register -> its value at the stop before

const num = (a: Address) => (a.startsWith("0x") ? BigInt(a) : null); // shortcut: only the default space is mapped (the coverage tint does the same); upgrade with qualified stop addresses

/** The registers whose value differs from the last stop (`last`: name -> value; empty before the first stop), with that earlier value. */
export const changedRegs = (last: Record<string, string>, regs: { name: string; value: string }[]) => Object.fromEntries(regs.filter((r) => last[r.name] !== undefined && last[r.name] !== r.value).map((r) => [r.name, last[r.name]]));
export const regValues = (regs: { name: string; value: string }[]) => Object.fromEntries(regs.map((r) => [r.name, r.value]));

/**
 * The decompiler line (0-based) for a stop address: the line of the token at exactly that address, else of the nearest mapped address
 * before it (the same token addresses the coverage tint uses); before the first mapped address (the prologue) the first mapped line.
 * Null when the function maps no address at all.
 */
export function lineForAddress(tokens: Token[], pc: Address): number | null {
  const p = num(pc);
  if (p === null) return null;
  let best: { a: bigint; line: number } | null = null, first: { a: bigint; line: number } | null = null;
  for (const t of tokens) {
    const a = t.address ? num(t.address) : null;
    if (a !== null && (!first || a < first.a || (a === first.a && t.line < first.line))) first = { a, line: t.line };
    if (a === null || a > p) continue;
    if (!best || a > best.a || (a === best.a && t.line < best.line)) best = { a, line: t.line };
  }
  return (best ?? first)?.line ?? null;
}

/** The first (lowest) address mapped to a decompiler line (0-based): where F9 puts the breakpoint. */
export function firstAddress(tokens: Token[], line: number): Address | null {
  let best: { a: bigint; s: Address } | null = null;
  for (const t of tokens) {
    const a = t.line === line && t.address ? num(t.address) : null;
    if (a !== null && (!best || a < best.a)) best = { a, s: t.address! };
  }
  return best ? best.s : null;
}

export function debugLabel(d: DebugState | null): string {
  if (!d) return "";
  if (d.state === "stopped") return `stopped at ${d.address}`;
  return d.state === "running" ? "running" : d.error ? `detached (${d.error})` : "detached";
}

/** True when the function (entry, size) holds `pc`; a body with gaps counts as its span. */
export function inFunction(f: { entry: Address; size: number }, pc: Address): boolean {
  const e = num(f.entry), p = num(pc);
  return e !== null && p !== null && p >= e && p < e + BigInt(Math.max(f.size, 1));
}

/** The decompiler lines (0-based) whose first address has a breakpoint. */
export function bpLines(tokens: Token[], bps: Address[]): number[] {
  if (!bps.length) return [];
  const want = new Set(bps.map(num).filter((a) => a !== null).map(String)), first = new Map<number, bigint>();
  for (const t of tokens) { const a = t.address ? num(t.address) : null; if (a !== null && (!first.has(t.line) || a < first.get(t.line)!)) first.set(t.line, a); }
  return [...first].filter(([, a]) => want.has(String(a))).map(([l]) => l).sort((x, y) => x - y);
}

/** "host:port", "host" or ":port" -> the attach parameters (defaults: localhost, 1234). */
export function parseTarget(text: string): { host: string; port: number } {
  const m = /^\s*(.*?)(?::(\d+))?\s*$/.exec(text) ?? [];
  return { host: m[1] || "localhost", port: m[2] ? Number(m[2]) : 1234 };
}

/** The first (lowest) address of every decompiler line that maps one, sorted and unique: where a statement starts (what a statement step runs to). */
export function lineStarts(tokens: Token[]): Address[] {
  const first = new Map<number, { a: bigint; s: Address }>();
  for (const t of tokens) { const a = t.address ? num(t.address) : null; if (a !== null && (!first.has(t.line) || a < first.get(t.line)!.a)) first.set(t.line, { a, s: t.address! }); }
  const seen = new Set<bigint>();
  return [...first.values()].filter((v) => !seen.has(v.a) && !!seen.add(v.a)).sort((x, y) => (x.a < y.a ? -1 : 1)).map((v) => v.s);
}

/** The instructions behind a decompiler line: from its first address (or the stop, if it is earlier: the prologue) up to the next statement start. */
export function statementRange(tokens: Token[], line: number, pc: Address): { start: Address; end: Address } | null {
  const mine = firstAddress(tokens, line), p = num(pc), m = mine ? num(mine) : null;
  if (m === null || p === null) return null;
  const next = lineStarts(tokens).map((s) => num(s)!).find((a) => a > m);
  return { start: "0x" + (p < m ? p : m).toString(16), end: "0x" + ((next ?? m + 1n) - 1n).toString(16) };
}

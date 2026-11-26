import type { Address, FunctionInfo } from "../../../protocol";
import { findFunctionByName } from "./funcs";

export type GotoResult = { address: Address } | { error: string };

const HEX = /^(0x)?[0-9a-f]{1,16}$/i;
const MAX = (1n << 64n) - 1n;
const norm = (h: string): GotoResult => { const v = BigInt(h.startsWith("0x") || h.startsWith("0X") ? h : "0x" + h); return v > MAX ? { error: "address out of range" } : { address: "0x" + v.toString(16) }; };

/** Go-to input: 0x-hex, else a function name, else bare hex (so "main" and "add" stay names), else a name prefix. */
export function parseGoto(input: string, funcs: FunctionInfo[]): GotoResult {
  const s = input.trim();
  if (!s) return { error: "enter an address or function name" };
  if (/^0x/i.test(s)) return HEX.test(s) ? norm(s) : { error: `not an address: ${s}` };
  const exact = funcs.find((f) => f.name === s);
  if (exact) return { address: exact.entry };
  if (HEX.test(s)) return norm(s);
  const f = findFunctionByName(funcs, s);
  return f ? { address: f.entry } : { error: `no function named ${s}` };
}

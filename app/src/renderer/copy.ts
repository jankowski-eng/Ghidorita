import type { Address, Token } from "../../../protocol";

/** `get_bytes` / a listing row spell bytes as lowercase hex separated by spaces: "48 8b 05". */
export const BYTES_MAX = 64 * 1024;

/** The bytes as a C array: `unsigned char bytes[] = { 0x48, 0x8b };`, 12 per line once it does not fit on one. */
export function cArray(hex: string, name = "bytes"): string {
  const b = hex.trim() ? hex.trim().split(/\s+/).map((x) => "0x" + x.toLowerCase()) : [];
  if (b.length <= 12) return `unsigned char ${name}[] = { ${b.join(", ")} };`;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i += 12) lines.push("  " + b.slice(i, i + 12).join(", "));
  return `unsigned char ${name}[] = {\n${lines.join(",\n")}\n};`;
}

/**
 * The address a decompiler cursor stands for: a call target's function, a global's address, the token's own instruction, else the first address on
 * its line, else the function's entry.
 */
export function addressAtCursor(tok: Token | undefined, tokens: Token[], line0: number, entry: Address): Address {
  return tok?.targetFunction ?? tok?.varAddress ?? tok?.address ?? tokens.find((t) => t.line === line0 && t.address)?.address ?? entry;
}

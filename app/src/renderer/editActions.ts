import type { Address, ListingRow, Token } from "../../../protocol";
import { parseAddr } from "./address";

export type EditAction = "rename" | "retype" | "comment" | "createFunction" | "defineData" | "defineArray" | "definePointer" | "repeatData" | "createStruct" | "bookmark" | "autoStruct" | "clear" | "signature" | "undo" | "redo" | "save";
export type Focus = "listing" | "decompiler" | "input" | "other";
export interface KeyLike { key: string; code?: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }

/**
 * Ghidra's default bindings. Plain letters only fire in the listing (the decompiler registers its own via Monaco's action API);
 * never inside a text input. Ctrl+L is Cmd+L on macOS in Ghidra too; we accept either modifier.
 * Undo/redo/save are NOT routed here: the menu owns them (see undoRoute).
 */
export function listingKey(e: KeyLike): EditAction | null {
  if (e.alt) return null;
  const mod = !!(e.meta || e.ctrl), k = e.key.toLowerCase();
  if (mod) return k === "l" && !e.shift ? "retype" : null;
  if (e.shift) return e.code === "BracketLeft" ? "createStruct" : null; // Shift+[
  return ({ l: "rename", ";": "comment", f: "createFunction", t: "defineData", "[": "defineArray", p: "definePointer", y: "repeatData", c: "clear" } as Record<string, EditAction>)[k] ?? null;
}

/** Cmd+Z in a text input is the input's own undo; anywhere else it is the program's. */
export const undoRoute = (focus: Focus): "text" | "program" => (focus === "input" ? "text" : "program");

export type TokenEdit =
  | { kind: "variable"; name: string }
  | { kind: "symbol"; address: Address; current: string }
  | null;

/** What L does on a decompiler token (Ghidra: local/param -> rename variable; function name or call target -> rename function; label -> rename label). */
export function renameTarget(tok: Token | undefined, text: string, fn: { entry: Address; name: string } | null): TokenEdit {
  if (!tok) return null;
  if ((tok.kind === "variable" || tok.kind === "param") && tok.varName) return { kind: "variable", name: tok.varName };
  if (tok.kind === "function") {
    if (tok.targetFunction) return { kind: "symbol", address: tok.targetFunction, current: text };
    if (fn && text === fn.name) return { kind: "symbol", address: fn.entry, current: fn.name };
    return null;
  }
  if (tok.kind === "label" && tok.address) return { kind: "symbol", address: tok.address, current: text };
  return null;
}
export const retypeTarget = (tok: Token | undefined): string | null =>
  tok && (tok.kind === "variable" || tok.kind === "param") && tok.varName ? tok.varName : null;
/** Edit Signature applies on the function's own name token (not on a call). */
export const isOwnName = (tok: Token | undefined, text: string, fn: { name: string } | null) =>
  !!tok && !!fn && tok.kind === "function" && !tok.targetFunction && text === fn.name;

/** What "show references" targets: an address, or a program variable of a function (found by the name the decompiler shows). */
export type XrefTarget = { type: "address"; address: Address; label: string } | { type: "variable"; entry: Address; name: string; label: string };

/**
 * X on a decompiler token. A global (token has varAddress) -> references to its address; other variable/param -> its program variable (xrefs_to_variable),
 * or, when the program has none (iVar1, register temporaries), its uses in the function (variable_uses);
 * a call target or the function's own name -> the function; a label -> its address. Anything else has no target.
 */
export function xrefTargetOf(tok: Token | undefined, text: string, fn: { entry: Address; name: string } | null): XrefTarget | null {
  if (!tok) return null;
  if ((tok.kind === "variable" || tok.kind === "param") && tok.varName && tok.varAddress) return { type: "address", address: tok.varAddress, label: tok.varName };
  if ((tok.kind === "variable" || tok.kind === "param") && tok.varName && fn) return { type: "variable", entry: fn.entry, name: tok.varName, label: tok.varName };
  if (tok.kind === "function") {
    if (tok.targetFunction) return { type: "address", address: tok.targetFunction, label: text };
    if (fn && text === fn.name) return { type: "address", address: fn.entry, label: fn.name };
    return null;
  }
  if (tok.kind === "label" && tok.address) return { type: "address", address: tok.address, label: text };
  return null;
}

/** The token covering a 1-based Monaco position (colEnd exclusive, so a cursor right after the token still hits it). */
export function tokenAt(tokens: Token[], line1: number, col1: number): Token | undefined {
  return tokens.find((t) => t.line + 1 === line1 && col1 >= t.colStart + 1 && col1 <= t.colEnd + 1 && t.kind !== "default");
}

export interface Pos { line: number; col: number } // 1-based
/**
 * Map a position from oldText to newText: common-prefix lines keep their place, common-suffix lines shift by the length delta,
 * a position inside the changed block keeps its offset in the block (clamped). Column kept when the line text is unchanged.
 */
export function mapPos(oldText: string, newText: string, p: Pos): Pos {
  const a = oldText.split("\n"), b = newText.split("\n");
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const i = p.line - 1;
  let j: number;
  if (i < pre) j = i; else if (i >= a.length - suf) j = i + (b.length - a.length); else j = Math.min(b.length - suf - 1, pre + (i - pre));
  j = Math.max(0, Math.min(b.length - 1, j));
  const same = a[i] === b[j];
  return { line: j + 1, col: Math.max(1, Math.min(same ? p.col : Math.min(p.col, b[j].length + 1), b[j].length + 1)) };
}

/**
 * Define Array (`[`): the element type is the data type at the cursor row (`byte` for an undefined byte; null = the row is code), the default element
 * count is the cursor row plus the undefined, unlabelled bytes right after it, in whole elements. `rows[0]` is the cursor row, the rest follow it in the listing.
 */
export function arrayPlan(rows: ListingRow[]): { elem: string; count: number } | null {
  const row = rows[0], p0 = row && parseAddr(row.address);
  if (!row?.dataType || !p0) return null;
  const len = Math.max(row.length, 1);
  let bytes = len, end = p0.off + BigInt(len);
  for (const r of rows.slice(1)) {
    const p = parseAddr(r.address);
    if (r.dataType !== "undefined" || r.label || !p || p.space !== p0.space || p.off !== end) break;
    bytes += r.length; end += BigInt(r.length);
  }
  return { elem: row.dataType === "undefined" ? "byte" : row.dataType, count: Math.max(1, Math.floor(bytes / len)) };
}

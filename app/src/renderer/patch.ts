import type { AssembledInstruction } from "../../../protocol";

const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;

/** The line the patch dialog shows for an assembled instruction; `ok` = applying it is allowed with the current "overwrite following" choice. */
export function patchPreview(a: AssembledInstruction, overwrite: boolean): { message: string; ok: boolean } {
  const head = `${a.bytes} (${n(a.length, "byte")}) replaces ${a.oldBytes}`;
  if (a.length > a.oldLength) {
    const eat = `${n(a.overwrites, "following instruction")}`;
    return overwrite ? { message: `${head}; also overwrites ${eat}`, ok: true }
      : { message: `${head}: longer than the ${a.oldLength}-byte instruction. Tick the box to also overwrite ${eat}.`, ok: false };
  }
  return { message: a.length < a.oldLength ? `${head}; ${n(a.oldLength - a.length, "byte")} of the old instruction stay` : head, ok: true };
}

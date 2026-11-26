import type { SymbolSource } from "../../../protocol";

/** Where a name came from, in the order a reverse engineer trusts it: a person's own name is confirmed, everything else is still a guess or the file's word. */
export const CONFIRMED: SymbolSource = "user";
/** "Not yet renamed": any function whose name was not set by a person (default FUN_xxxx, analysis guess, or imported from the file). */
export const notRenamed = (source: SymbolSource | undefined): boolean => source !== CONFIRMED;

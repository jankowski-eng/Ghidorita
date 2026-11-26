/** Plain-words versions of the decompiler's warnings. Unknown ones show as Ghidra wrote them (without the "WARNING:" prefix). */
const PLAIN: [RegExp, string][] = [
  [/Subroutine does not return/i, "A called function never returns, so the code after the call is dropped."],
  [/Unknown calling convention/i, "The calling convention is unknown: parameters and the return value may be wrong."],
  [/Could not recover jumptable/i, "A switch table could not be recovered: the jump is shown as a call."],
  [/Treating indirect jump as call/i, "An indirect jump is shown as a call."],
  [/bad instruction|encountered bad instruction/i, "Invalid instruction bytes: the code is cut at that point."],
  [/Removing unreachable block/i, "Code that can never run was removed."],
  [/Unable to track spacebase/i, "The stack could not be followed fully: local variables may be wrong."],
];
export const plainWarning = (w: string): string => {
  const t = w.replace(/^WARNING( \([a-z]+\))?:\s*/i, "");
  return PLAIN.find(([re]) => re.test(t))?.[1] ?? t;
};

/** Names the decompiler invents for values it cannot name, explained once when a warning mentions them. */
const PREFIXES: [RegExp, string][] = [
  [/\bin_/, "in_…: a register or stack value the function reads that its caller set."],
  [/\bunaff_/, "unaff_…: a register the function uses but never sets (the caller's value)."],
  [/\bextraout_/, "extraout_…: a value a called function returns beyond what its signature says."],
];
export const prefixNotes = (ws: string[]): string[] => PREFIXES.filter(([re]) => ws.some((w) => re.test(w))).map(([, s]) => s);

import type { Address, CallGraphNode, FunctionInfo } from "../../../protocol";

/** What a call-graph node says under its name: who named it, and with coverage loaded whether the shown runs reached it ("never ran" = 0×). */
export function nodeInfo(n: CallGraphNode, f: FunctionInfo | undefined, cov: { shown: boolean; mark(a: Address, length: number): string }) {
  const named = f?.source === "user";
  if (n.kind === "import") return { named, sub: "import", cov: "", ran: undefined };
  const mark = cov.shown && f ? cov.mark(n.entry, Math.max(1, f.size)) : "";
  const ran = cov.shown && f ? mark !== "" : undefined;
  const runs = ran === undefined ? "" : !ran ? "never ran" : mark === " cov-a" ? "ran in A only" : mark === " cov-b" ? "ran in B only" : "ran";
  return { named, sub: [named ? "named by you" : "", runs].filter(Boolean).join(" · "), cov: mark, ran };
}

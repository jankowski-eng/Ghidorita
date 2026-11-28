import type { Address, Token, TrailToken } from "../../../../protocol";
import type { AgentHighlight } from "../../agent/types";

/** The agent's highlight as the value trail's own inputs (so it looks the same): listing rows (`addrs`) and decompiler tokens/lines of the active tab (`tokens`, all "forward"). */
export function agentMarks(hl: AgentHighlight | null, entry: Address | null, text: string, tokens: readonly Token[]): { tokens: TrailToken[]; addrs: Set<Address> } {
  const addrs = new Set<Address>(hl?.addresses ?? []), out: TrailToken[] = [];
  if (!hl || !entry) return { tokens: out, addrs };
  if (addrs.size) for (const t of tokens) if (t.address && addrs.has(t.address)) out.push({ line: t.line, colStart: t.colStart, colEnd: t.colEnd, dir: "forward" });
  const lines = text.split("\n");
  for (const r of hl.lines) if (r.entry === entry)
    for (let l = Math.max(1, r.from); l <= Math.min(r.to, lines.length); l++) if (lines[l - 1].length) out.push({ line: l - 1, colStart: 0, colEnd: lines[l - 1].length, dir: "forward" });
  return { tokens: out, addrs };
}

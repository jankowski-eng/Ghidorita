import { esc } from "../format";
import type { ToolDef } from "../types";

const HOW_TO_ENABLE = "Agent access is off. Ask the user to choose Agent > Access > Read or Edit in Ghidorita's menu.";

export const status: ToolDef<Record<string, never>> = {
  name: "status",
  description: "Call this first. Shows the access mode, the open program (name, analysis state, unsaved edits) and what the provider supports.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  access: "off",
  timeoutSecs: 15,
  async handler(ctx) {
    if (ctx.mode === "off") return HOW_TO_ENABLE;
    const lines = [`Access: ${ctx.mode} (client ${ctx.client})`];
    if (!ctx.ops || !ctx.session) lines.push("Program: none open. Ask the user to open one.");
    else {
      const [undo, analysis] = await Promise.all([ctx.ops.history.state(), ctx.backend.capabilities.has("analysis") ? ctx.ops.analysis.status() : null]);
      lines.push(`Program: ${esc(ctx.session.name, 120)} (id ${esc(ctx.session.programId, 60)})`);
      if (analysis) lines.push(`Analysis: ${analysis.state}${analysis.state === "running" ? ` ${analysis.pct}% (${analysis.analyzer})` : ""}, recorded ${analysis.analysis}, profile ${analysis.profile}`);
      lines.push(`Edits: ${undo.dirty ? "unsaved" : "saved"}${undo.canUndo ? `, last: ${esc(undo.undoName ?? "yes", 120)}` : ""}`);
    }
    lines.push(`Capabilities: ${[...ctx.backend.capabilities].sort().join(", ")}`);
    return lines.join("\n");
  },
};

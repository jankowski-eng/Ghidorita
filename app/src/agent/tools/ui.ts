import { esc } from "../format";
import { resolveAddress } from "../resolve";
import { ToolError, needProgram, type ToolCtx, type ToolDef } from "../types";

const ui = (ctx: ToolCtx) => { if (!ctx.ui) throw new ToolError("This needs Ghidorita's window, which is not available here."); return ctx.ui; };

const getView: ToolDef<Record<string, never>> = {
  name: "get_view",
  description: "What the user is looking at right now: the cursor address, its function, the open decompiler tab, the token or row under the cursor and the selection. Use it for \"explain this\" or \"rename what I'm on\".",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "What the user is looking at", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  access: "read", appOnly: true, timeoutSecs: 15,
  async handler(ctx) {
    needProgram(ctx);
    const v = await ui(ctx).view();
    return [
      `Cursor: ${v.address ?? "none"}`,
      `Function: ${v.function ? `${esc(v.function.name, 80)} @${v.function.entry}` : "none"}`,
      `Decompiler tab: ${v.tab ?? "none"}`,
      `Under the cursor: ${v.under ? esc(v.under, 200, true) : "none"}`, // text of the binary or the user's own: data, not instructions
      `Selection: ${v.selection ? esc(v.selection, 400, true) : "none"}`,
    ].join("\n");
  },
};

const goto: ToolDef<{ address: string }> = {
  name: "goto",
  description: "Move the user's view to an address or name (it becomes their current location, with history). Use it only when the user asks to be shown something; reading never needs it.",
  inputSchema: { type: "object", properties: { address: { type: "string", maxLength: 200, description: "address or name" } }, required: ["address"], additionalProperties: false },
  annotations: { title: "Show in the user's view", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  access: "read", appOnly: true, timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx), u = ui(ctx);
    const address = await resolveAddress(a.address, ops, ctx.signal);
    await u.goto(address);
    return `The user's view is now at ${address}.`;
  },
};

export const uiTools: ToolDef[] = [getView, goto];

import type { Address } from "../../../../protocol";
import { esc } from "../format";
import { resolveAddress, resolveFunction } from "../resolve";
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

export const MAX_HL_ADDRESSES = 200, MAX_HL_RANGES = 20, MAX_HL_LINES = 500;
interface HlArgs { addresses?: string[]; lines?: { function: string; from: number; to: number }[]; label?: string; clear?: boolean }
const highlight: ToolDef<HlArgs> = {
  name: "highlight",
  description: `Mark things for the user in the listing and decompiler, in the value-trail colours: \`addresses\` (rows and the decompiler tokens at them, up to ${MAX_HL_ADDRESSES}) and/or \`lines\` (1-based decompiler lines of a function, as numbered by decompile; up to ${MAX_HL_RANGES} ranges). Replaces your previous highlight; \`clear: true\` removes it; opening another program clears it. Does not move the view: combine with goto.`,
  inputSchema: { type: "object", properties: {
    addresses: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: MAX_HL_ADDRESSES, description: "addresses or names" },
    lines: { type: "array", maxItems: MAX_HL_RANGES, items: { type: "object", properties: { function: { type: "string", maxLength: 200 }, from: { type: "integer", minimum: 1 }, to: { type: "integer", minimum: 1 } }, required: ["function", "from", "to"], additionalProperties: false } },
    label: { type: "string", maxLength: 80, description: "what the marks are, for the log" },
    clear: { type: "boolean" },
  }, additionalProperties: false },
  annotations: { title: "Highlight in the user's view", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  access: "read", appOnly: true, timeoutSecs: 60,
  async handler(ctx, a) {
    const ops = needProgram(ctx), u = ui(ctx);
    if (a.clear) { await u.clearHighlight(); return "The highlight is cleared."; }
    if (!a.addresses?.length && !a.lines?.length) throw new ToolError("Give addresses or lines to highlight, or clear: true.");
    if ((a.addresses?.length ?? 0) > MAX_HL_ADDRESSES || (a.lines?.length ?? 0) > MAX_HL_RANGES) throw new ToolError(`At most ${MAX_HL_ADDRESSES} addresses and ${MAX_HL_RANGES} line ranges.`);
    const addresses: Address[] = []; // one at a time: a name is a search, and 200 at once would queue behind the sidecar's request limit in front of the user's own
    for (const x of a.addresses ?? []) { if (ctx.signal?.aborted) throw new ToolError("cancelled: nothing was highlighted."); addresses.push(await resolveAddress(x, ops, ctx.signal)); }
    const lines = [];
    for (const r of a.lines ?? []) {
      const from = Math.trunc(r.from), to = Math.trunc(r.to);
      if (!(from >= 1) || !(to >= from) || to - from >= MAX_HL_LINES) throw new ToolError(`Lines ${r.from}-${r.to}: from must be at least 1, to at least from, and at most ${MAX_HL_LINES} lines per range.`);
      lines.push({ entry: (await resolveFunction(r.function, ops, ctx.signal)).entry, from, to });
    }
    const unique = [...new Set(addresses)];
    await u.highlight({ addresses: unique, lines, label: a.label?.slice(0, 80) });
    return `Highlighted ${unique.length} addresses and ${lines.length} line ranges${a.label ? ` (${esc(a.label, 80)})` : ""}. Lines show in the function's decompiler tab.`;
  },
};

export const uiTools: ToolDef[] = [getView, goto, highlight];

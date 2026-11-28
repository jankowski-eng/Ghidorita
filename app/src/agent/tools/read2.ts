import type { Address } from "../../../../protocol";
import type { Job } from "../../renderer/backend";
import { parseAddr } from "../../renderer/address";
import { toToolError } from "../errors";
import { capPage, capText, esc, int, table } from "../format";
import { resolveAddress, resolveFunction } from "../resolve";
import { needProgram, ToolError, type JsonSchema, type ToolCtx, type ToolDef } from "../types";

// More read tools: p-code, value trail, function graph, bookmarks, undefined references. Same conventions as read.ts (text out, capped, binary text escaped).

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
type Def = Omit<ToolDef, "access" | "annotations"> & { title: string };
const tool = ({ title, handler, ...t }: Def): ToolDef => ({
  ...t, access: "read", annotations: { title, ...ANNOTATIONS },
  async handler(ctx, args) {
    if (ctx.signal.aborted) throw new ToolError("Cancelled: the call was cancelled or timed out.");
    try { return await handler(ctx, args ?? {}); } catch (e) { throw toToolError(e); }
  },
});
const schema = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
async function run<T>(ctx: ToolCtx, job: Job<T>): Promise<T> {
  const cancel = () => job.cancel();
  ctx.signal.addEventListener("abort", cancel, { once: true });
  if (ctx.signal.aborted) cancel();
  try { return await job.result; } finally { ctx.signal.removeEventListener("abort", cancel); }
}
const need = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${name} is required: a name or an address as a string.`);
  return v;
};
const sym = (s: unknown) => esc(s, 160);
const OFFSET = { type: "integer", minimum: 0, default: 0, description: "Lines to skip (use the offset a continuation line names)." };
const FUNCTION = { type: "string", description: "Function name or an address inside it (0x401000, main, FUN_00401000)." };
const TIMEOUT = { type: "integer", minimum: 1, maximum: 600, description: "Decompiler timeout in seconds; raise it on a Timeout error for a big function." };
const off = (a: { offset?: unknown }) => int(a.offset, 0, 0, 1e9);

export const pcode = tool({
  name: "pcode", title: "P-code", timeoutSecs: 150, capability: ["pcode", "decompile"],
  description: "P-code of a function. kind=high (default): the decompiler's ops by basic block, `B<n>  addr  [out = ]OP in, ...` with high variable names in parentheses. kind=raw: per instruction `addr  asm`, then its ops indented. from/to restrict to an address range. Large functions are cut by the provider (noted) and paged with offset.",
  inputSchema: schema({
    function: FUNCTION, kind: { type: "string", enum: ["high", "raw"], default: "high" },
    from: { type: "string", description: "First address of the range (default: function start)." }, to: { type: "string", description: "Last address of the range (default: function end)." },
    timeoutSecs: TIMEOUT, offset: OFFSET,
  }, ["function"]),
  async handler(ctx, a) {
    const ops = needProgram(ctx);
    if (a.kind !== undefined && a.kind !== "raw" && a.kind !== "high") throw new ToolError(`Unknown kind ${esc(a.kind, 40, true)}: use high or raw.`);
    const kind = a.kind === "raw" ? "raw" : "high";
    const f = await resolveFunction(need(a.function, "function"), ops, ctx.signal);
    const lo = typeof a.from === "string" && a.from.trim() ? parseAddr(await resolveAddress(a.from, ops, ctx.signal)) : null;
    const hi = typeof a.to === "string" && a.to.trim() ? parseAddr(await resolveAddress(a.to, ops, ctx.signal)) : null;
    const inRange = (addr: Address) => { const p = parseAddr(addr); return !p || ((!lo || (p.space === lo.space && p.off >= lo.off)) && (!hi || (p.space === hi.space && p.off <= hi.off))); };
    const r = await run(ctx, ops.decompiler.pcode({ entry: f.entry, timeoutSecs: int(a.timeoutSecs, 120, 1, 600) }));
    const lines = kind === "raw"
      ? r.raw.filter((i) => inRange(i.address)).flatMap((i) => [`${i.address}  ${esc(i.asm, 200)}`, ...i.ops.map((o) => `    ${esc(o, 300)}`)])
      : r.high.filter((o) => inRange(o.address)).map((o) => `B${o.block}  ${o.address}  ${esc(o.text, 300)}`);
    return `${sym(f.name)} @${f.entry}: ${kind} p-code${r.truncated ? " (TRUNCATED by the provider: a large function was cut)" : ""}\n${capText(lines, off(a))}`;
  },
});

export const value_trail = tool({
  name: "value_trail", title: "Value trail", timeoutSecs: 150, capability: ["valueTrail", "decompile"],
  description: "Where a decompiler variable's value comes from (backward) and goes to (forward) inside one function: the p-code ops (`addr  OP`; the slice stops at calls) and the C lines holding the tokens (S seed, < backward, > forward). Name the variable (`variable`, as in decompile) or point at a token with `line` and `column` (1-based, in decompile's text).",
  inputSchema: schema({
    function: FUNCTION, variable: { type: "string", description: "Variable name: param_1, local_10, iVar1." },
    line: { type: "integer", minimum: 1, description: "1-based line of decompile's text." }, column: { type: "integer", minimum: 1, description: "1-based column inside the variable token." },
    timeoutSecs: TIMEOUT, offset: OFFSET,
  }, ["function"]),
  async handler(ctx, a) {
    const ops = needProgram(ctx);
    const named = typeof a.variable === "string" && a.variable.trim() !== "";
    if (!named && !(typeof a.line === "number" && typeof a.column === "number")) throw new ToolError("Give `variable` (a name from the decompiled C) or both `line` and `column`.");
    const f = await resolveFunction(need(a.function, "function"), ops, ctx.signal);
    const timeoutSecs = int(a.timeoutSecs, 120, 1, 600);
    // the C text also gives the output its source lines; a cached decompile is cheap, and failing on a named variable only loses those lines
    const dec = await run(ctx, ops.decompiler.decompile({ entry: f.entry, timeoutSecs })).catch((e) => { if (!named || ctx.signal.aborted) throw e; return null; });
    let seed: { name: string } | { line: number; colStart: number };
    if (named) seed = { name: String(a.variable).trim() };
    else {
      const line = int(a.line, 1, 1, 1e9) - 1, col = int(a.column, 1, 1, 1e9) - 1;
      const t = dec!.tokens.find((t) => t.line === line && col >= t.colStart && col < t.colEnd);
      if (!t) throw new ToolError(`No token at line ${line + 1}, column ${col + 1} of ${sym(f.name)}'s decompiled text. Call decompile and point at a variable, or pass its name.`);
      seed = { line: t.line, colStart: t.colStart };
    }
    const r = await run(ctx, ops.decompiler.valueTrail({ entry: f.entry, ...seed, timeoutSecs }));
    const part = (dir: "backward" | "forward") => { const o = r.ops.filter((x) => x.dir === dir); return o.length ? o.map((x) => `  ${x.address}  ${esc(x.op, 60)}`) : ["  (none)"]; };
    const text = dec?.text.split("\n") ?? [];
    const marks = new Map<number, string>();
    for (const t of r.tokens) { const m = t.dir === "seed" ? "S" : t.dir === "forward" ? ">" : "<"; const s = marks.get(t.line) ?? ""; if (!s.includes(m)) marks.set(t.line, s + m); }
    const src = [...marks].sort((x, y) => x[0] - y[0]).map(([l, m]) => `  ${String(l + 1).padStart(4)} ${m.padEnd(3)} ${text[l] === undefined ? "" : esc(text[l], 300)}`.trimEnd());
    const lines = [`Backward (where it comes from), ${r.ops.filter((x) => x.dir === "backward").length} ops:`, ...part("backward"), `Forward (where it goes), ${r.ops.filter((x) => x.dir === "forward").length} ops:`, ...part("forward"), `C lines (${src.length}; S seed, < backward, > forward):`, ...(src.length ? src : ["  (none)"])];
    return `Value trail of ${named ? sym(a.variable) : `line ${a.line} column ${a.column}`} in ${sym(f.name)} @${f.entry}\n${capText(lines, off(a))}`;
  },
});

export const function_graph = tool({
  name: "function_graph", title: "Function graph", timeoutSecs: 150, capability: ["controlFlowGraph", "decompile"],
  description: "A function's basic blocks and control-flow edges: `B<n>  start-end  kind  -> B<m> (true|false|uncond), ...`; true/false follow a conditional branch (false = fall through). bodies=true also lists each block's code lines (assembly or C).",
  inputSchema: schema({ function: FUNCTION, bodies: { type: "boolean", default: false, description: "Include each block's lines (long)." }, timeoutSecs: TIMEOUT, offset: OFFSET }, ["function"]),
  async handler(ctx, a) {
    const ops = needProgram(ctx);
    const f = await resolveFunction(need(a.function, "function"), ops, ctx.signal);
    const g = await run(ctx, ops.decompiler.graph({ entry: f.entry, timeoutSecs: int(a.timeoutSecs, 120, 1, 600) }));
    const idx = new Map(g.blocks.map((b, i) => [b.start, i]));
    const bn = (addr: Address) => (idx.has(addr) ? `B${idx.get(addr)}` : addr);
    const lines = g.blocks.flatMap((b, i) => {
      const out = g.edges.filter((e) => e.from === b.start).map((e) => `${bn(e.to)} (${e.kind})`);
      return [`B${i}  ${b.start}-${b.end}  ${b.kind === "c" ? "C" : "asm"}${out.length ? `  -> ${out.join(", ")}` : ""}`, ...(a.bodies === true ? b.lines.map((l) => `    ${esc(l, 200)}`) : [])];
    });
    return `${sym(f.name)} @${f.entry}: ${g.blocks.length} blocks, ${g.edges.length} edges\n${capText(lines, off(a))}`;
  },
});

export const list_bookmarks = tool({
  name: "list_bookmarks", title: "Bookmarks", timeoutSecs: 60, capability: "bookmarks",
  description: "Bookmarks in address order: `addr  category  comment`. Yours (set_bookmark) and the user's are type Note; Ghidra's analyzers add Analysis, Warning, Error, Info. `category` filters by substring of the category or comment; `type` by bookmark type (comma list allowed).",
  inputSchema: schema({
    category: { type: "string", description: "Substring of the category or comment (case-insensitive)." },
    type: { type: "string", description: "Note, Analysis, Warning, Error, Info; several comma-separated." },
    offset: OFFSET, limit: { type: "integer", minimum: 1, maximum: 1000, default: 100, description: "Lines per call." },
  }),
  async handler(ctx, a) {
    const ops = needProgram(ctx);
    const offset = off(a);
    const r = await run(ctx, ops.bookmarks.list({ offset, limit: int(a.limit, 100, 1, 1000), ...(typeof a.category === "string" && a.category ? { query: a.category } : {}), ...(typeof a.type === "string" && a.type ? { type: a.type } : {}) }));
    const types = r.types.map((t) => `${esc(t.type, 40)} ${t.count}`).join(", ");
    return `${r.total} bookmarks${types ? ` (all types in the program: ${types})` : ""}\n${r.items.length ? capPage(table(r.items.map((b) => [b.address, esc(b.category, 80), esc(b.comment, 300)])), offset, Math.max(0, r.total - offset - r.items.length)) : "(none)"}`;
  },
});

export const list_undefined_refs = tool({
  name: "list_undefined_refs", title: "References into undefined bytes", timeoutSecs: 150, capability: "undefinedRefs",
  description: "Data references whose target is undefined bytes (no instruction, no defined data): `target  type  from  function`. type pointer = an address taken. Good leads for data that needs define_data. A scan; paged with offset.",
  inputSchema: schema({ offset: OFFSET, limit: { type: "integer", minimum: 1, maximum: 1000, default: 100, description: "Lines per call." } }),
  async handler(ctx, a) {
    const ops = needProgram(ctx);
    const offset = off(a);
    const r = await run(ctx, ops.searches.listUndefinedRefs({ offset, limit: int(a.limit, 100, 1, 1000) }));
    return `${r.total} references into undefined bytes\n${r.items.length ? capPage(table(r.items.map((x) => [x.address, x.type, x.from, x.function ? sym(x.function) : ""])), offset, Math.max(0, r.total - offset - r.items.length)) : "(none)"}`;
  },
});

export const read2Tools: readonly ToolDef[] = [pcode, value_trail, function_graph, list_bookmarks, list_undefined_refs];

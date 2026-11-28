import type { ActiveSession, ProgramEntry } from "../../../../protocol";
import { offIn } from "../../renderer/address";
import { toToolError } from "../errors";
import { capText, esc, int, table } from "../format";
import { resolveAddress } from "../resolve";
import { needProgram, ToolError, type JsonSchema, type ToolAnnotations, type ToolCtx, type ToolDef } from "../types";

// The Full-mode tools (docs/AGENTS_MCP.md "Full mode"): patching, save, export, program lifecycle, coverage summary.
// `list_patches` and `load_coverage` are "full" too (the plan's table): they only read, but one names files and the other the program's modified bytes.

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const ann = (title: string, readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean): ToolAnnotations => ({ title, readOnlyHint, destructiveHint, idempotentHint });
const PAGE = { offset: { type: "integer", minimum: 0, default: 0, description: "Lines to skip." }, limit: { type: "integer", minimum: 1, maximum: 500, default: 200, description: "Lines per call." } };

/** A tool body: refuses when already aborted; every backend failure becomes the agent-facing text. */
const guard = <A>(f: (ctx: ToolCtx, a: A) => Promise<string>) => async (ctx: ToolCtx, a: A): Promise<string> => {
  if (ctx.signal.aborted) throw new ToolError("Cancelled: the call was cancelled or timed out.");
  try { return await f(ctx, a ?? ({} as A)); } catch (e) { throw toToolError(e); }
};
/** Awaits a cancellable job, cancelling it when the call is aborted. */
async function run<T>(ctx: ToolCtx, job: { result: Promise<T>; cancel(): unknown }): Promise<T> {
  const cancel = () => { void job.cancel(); };
  ctx.signal.addEventListener("abort", cancel, { once: true });
  if (ctx.signal.aborted) cancel();
  try { return await job.result; } finally { ctx.signal.removeEventListener("abort", cancel); }
}

/** Absolute and already normalised (no `.`, `..` or empty segments, no control characters): the agent names exactly where a file is read or written. */
export function checkPath(p: unknown, what = "path"): string {
  const s = typeof p === "string" ? p : "";
  if (!s) throw new ToolError(`${what} is required: an absolute file path.`);
  const rest = /^[A-Za-z]:[\\/]/.test(s) ? s.slice(3) : s.startsWith("/") ? s.slice(1) : null;
  if (rest === null) throw new ToolError(`${what} must be absolute (starting with / or a drive letter), got ${esc(s, 120, true)}. Ask the user where files belong, or use an absolute path in the user's home or temp folder.`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new ToolError(`${what} contains control characters.`);
  if (rest.split(/[\\/]/).some((seg) => seg === "" || seg === "." || seg === ".."))
    throw new ToolError(`${what} must be normalised: no "..", "." or empty segments (got ${esc(s, 120, true)}). Resolve it yourself and pass the final absolute path.`);
  return s;
}

// ---- patching ----
const HEX = /^[0-9a-f]{2}(?:\s*[0-9a-f]{2})*$/i;
const MAX_PATCH = 256;

const patch: ToolDef<{ address: string; asm?: string; bytes?: string; overwriteFollowing?: boolean }> = {
  name: "patch",
  description: "Patch the program's bytes at an address, as one undoable step: `asm` (ONE instruction, assembled with Ghidra's assembler for the program's language) or `bytes` (hex, \"90 90\"). The range is re-disassembled. When the new bytes are longer than the code unit at the address they spill over the following instructions or data: the call then writes nothing and reports what would be overwritten; repeat it with overwriteFollowing=true only if that is intended (or pad with nops). The original file is not touched.",
  inputSchema: obj({ address: str("Address or symbol name where the patched unit starts."), asm: str("One instruction, e.g. `mov eax, 1`."), bytes: str("Hex bytes, e.g. `90 90`."), overwriteFollowing: { type: "boolean", description: "Allow the patch to overwrite the units after the one at address. Default false." } }, ["address"]),
  annotations: ann("Patch bytes", false, true, true), access: "full", capability: "patch", timeoutSecs: 60,
  handler: guard(async (ctx, a) => {
    const ops = needProgram(ctx);
    if ((a.asm === undefined) === (a.bytes === undefined)) throw new ToolError("Pass exactly one of asm (one instruction) and bytes (hex).");
    const address = await resolveAddress(a.address, ops, ctx.signal);
    let bytes: string, oldLength: number, length: number, overwrites: number | null = null;
    if (a.asm !== undefined) {
      const asm = a.asm.trim();
      if (!asm) throw new ToolError("asm is empty.");
      const r = await run(ctx, ops.patch.assemble({ address, text: asm }));
      ({ bytes, oldLength, length } = r); overwrites = r.overwrites;
      if ((length > oldLength || overwrites > 0) && !a.overwriteFollowing)
        throw new ToolError(`Not applied, nothing was written. \`${esc(asm, 120)}\` assembles to ${length} bytes (${bytes}) but the unit at ${address} is ${oldLength} bytes (${r.oldBytes}), so the patch would overwrite ${overwrites ? `${overwrites} following instruction(s) or data unit(s)` : "the bytes after it"}. Call again with overwriteFollowing=true if that is intended, or use an instruction of at most ${oldLength} bytes (pad with nop).`);
    } else {
      if (!HEX.test(a.bytes!)) throw new ToolError(`bytes must be hex pairs like "90 90", got ${esc(a.bytes, 80, true)}.`);
      bytes = a.bytes!.trim().replace(/\s+/g, "").match(/../g)!.join(" ").toLowerCase();
      length = (bytes.length + 1) / 3;
      if (length > MAX_PATCH) throw new ToolError(`At most ${MAX_PATCH} bytes per patch; patch in several calls.`);
      const row = (await ops.listing.rows({ address, count: 1 }))[0];
      if (!row) throw new ToolError(`There is nothing to patch at ${address}: it is not initialized memory.`);
      oldLength = row.length;
      if (length > oldLength && !a.overwriteFollowing)
        throw new ToolError(`Not applied, nothing was written. ${length} bytes would spill over the ${oldLength}-byte unit at ${address} onto what follows it. Call again with overwriteFollowing=true if that is intended, or give at most ${oldLength} bytes.`);
    }
    const r = await ops.patch.apply(ctx.tag({ address, bytes, ...(a.overwriteFollowing ? { overwriteFollowing: true } : {}) }));
    return `Patched ${r.address}: ${bytes} (${r.length} bytes${a.asm !== undefined ? `, \`${esc(a.asm.trim(), 120)}\`` : ""}) over a ${oldLength}-byte unit.${r.overwritten ? ` Overwrote ${r.overwritten} following unit(s).` : ""} The user can undo it. Disassemble to check the result.`;
  }),
};

const list_patches: ToolDef<{ offset?: number; limit?: number }> = {
  name: "list_patches",
  description: "The bytes that differ from the original file, as runs: address, length, original and current bytes.",
  inputSchema: obj(PAGE),
  annotations: ann("List patches", true, false, true), access: "full", capability: "patch", timeoutSecs: 30,
  handler: guard(async (ctx, a) => {
    const runs = await needProgram(ctx).patch.list();
    if (!runs.length) return "No patches: the program's bytes match the file.";
    const cut = (h: string) => esc(h.length > 96 ? h.slice(0, 95) + " …" : h, 120);
    return `${runs.length} patched ranges (address, length, original, current)\n` + capText(table(runs.map((p) => [p.address, String(p.length), cut(p.original), cut(p.current)])), int(a.offset, 0, 0, 1e9), int(a.limit, 200, 1, 500));
  }),
};

// ---- persistence ----
const save: ToolDef<Record<string, never>> = {
  name: "save",
  description: "Save the program to the project. THIS ENDS THE USER'S UNDO HISTORY: after a save nobody can undo any earlier edit (yours or the user's) and undo_agent_edit finds nothing. Do not call it unless the user asked you to save. Ghidorita also saves when the program is closed.",
  inputSchema: obj({}),
  annotations: ann("Save program", false, true, true), access: "full", capability: "save", timeoutSecs: 120,
  handler: guard(async (ctx) => {
    const r = await needProgram(ctx).history.save();
    return r.saved ? `Saved.${r.undoHistoryCleared ? " The undo history is gone: earlier edits can no longer be undone." : ""}` : "Nothing to save: there were no unsaved changes.";
  }),
};

const KINDS = ["symbols", "header", "gzf"] as const;
const export_: ToolDef<{ kind: typeof KINDS[number]; path: string }> = {
  name: "export",
  description: "Write the program to a file: symbols (JSON map of functions, labels, data, comments), header (C header of the data types and functions), gzf (Ghidra archive). `path` must be absolute and normalised; an existing file there is overwritten, so pick a fresh name unless the user named the file.",
  inputSchema: obj({ kind: { type: "string", enum: KINDS }, path: str("Absolute output path.") }, ["kind", "path"]),
  annotations: ann("Export", false, true, true), access: "full", capability: "export", timeoutSecs: 120,
  handler: guard(async (ctx, a) => {
    const ops = needProgram(ctx), path = checkPath(a.path);
    if (!KINDS.includes(a.kind)) throw new ToolError(`kind must be one of ${KINDS.join(", ")}.`);
    if (a.kind === "gzf" && !ctx.backend.capabilities.has("exportGzf")) throw new ToolError("This provider cannot write Ghidra archives (no exportGzf capability). Use symbols or header.");
    const r = a.kind === "symbols" ? await ops.exports.symbols({ path }) : a.kind === "header" ? await ops.exports.header({ path }) : await ops.exports.gzf({ path });
    const detail = "bytes" in r ? `${r.bytes} bytes` : "labels" in r ? `${r.functions} functions, ${r.labels} labels, ${r.data} data, ${r.comments} comments` : `${r.types} types, ${r.functions} functions`;
    return `Wrote the ${a.kind} export to ${esc(r.path, 300)} (${detail}).`;
  }),
};

// ---- program lifecycle ----
// In the app the session store is the only caller of the backend's lifecycle (store/session.ts), so the app goes through `ctx.ui`; a headless host (no `ui`) calls the backend.

/** Below Full in the app: the user decides. Nothing to protect when no program is open. */
async function confirmReplace(ctx: ToolCtx, message: string) {
  if (ctx.mode === "full" || !ctx.ui) return; // also with no program open: opening an arbitrary file is the user's call
  if (!(await ctx.ui.confirm(message))) throw new ToolError("The user declined. Do not try again unless they ask you to.");
}
const label = (s: { name: string }) => esc(s.name, 100, true);
const MAX_LISTED = 12;
const listing = (entries: ProgramEntry[]) => entries.slice(0, MAX_LISTED).map((e) => `${label(e)} (id ${esc(e.programId, 100)})`).join("; ") + (entries.length > MAX_LISTED ? `; … ${entries.length - MAX_LISTED} more` : "");

const open_program: ToolDef<{ program?: string; path?: string }> = {
  name: "open_program",
  description: "Open a program, replacing the one that is open (it is saved and closed first). `program` = a stored program's id or name (pass neither to list them); `path` = an absolute path of a binary to import with Ghidra's default options. Below Full access the user is asked first. Analysis keeps running in the background: call wait_for_analysis. Everything you knew about the old program (addresses, variable names) is stale afterwards: call status.",
  inputSchema: obj({ program: str("Program id or name from the project."), path: str("Absolute path of a binary to import.") }),
  annotations: ann("Open program", false, true, false), access: "edit", capability: "projects", timeoutSecs: 240,
  handler: guard(async (ctx, a) => {
    if (a.program !== undefined && a.path !== undefined) throw new ToolError("Pass program or path, not both.");
    const entries = await ctx.backend.projects.list();
    if (a.program === undefined && a.path === undefined) return entries.length ? `${entries.length} stored programs: ${listing(entries)}. Call open_program with program=<id or name>.` : "The project has no stored programs. Pass path=<absolute path of a binary> to import one.";
    let target: { programId: string } | { path: string }, entry: ProgramEntry | undefined, name: string;
    if (a.path !== undefined) { name = checkPath(a.path); target = { path: name }; } else {
      const q = String(a.program).trim(), lower = q.toLowerCase();
      const hits = [entries.filter((e) => e.programId === q), entries.filter((e) => e.name === q), entries.filter((e) => e.name.toLowerCase() === lower)].find((h) => h.length);
      if (!hits) throw new ToolError(`No stored program ${esc(q, 100, true)}. Stored: ${entries.length ? listing(entries) : "none"}. To import a binary pass path=<absolute path>.`);
      if (hits.length > 1) throw new ToolError(`${esc(q, 100, true)} is ambiguous: ${listing(hits)}. Pass the id.`);
      entry = hits[0]; name = entry.name; target = { programId: entry.programId };
    }
    await confirmReplace(ctx, `The agent wants to open ${esc(name, 200, true)}${ctx.session ? `, which saves and closes ${label(ctx.session)}` : ""}. Allow?`);
    let opened: ActiveSession | null;
    if (ctx.ui) {
      await ctx.ui.openProgram(target);
      opened = await ctx.backend.lifecycle.active();
    } else opened = await run(ctx, entry ? ctx.backend.projects.reopen(entry, () => {}, "background") : ctx.backend.lifecycle.open((target as { path: string }).path, {}, () => {}, "background"));
    if (!opened) throw new ToolError("The program did not open. Call status to see what is open; the user may need to look at the window.");
    return `Opened ${label(opened)} (id ${esc(opened.programId, 100)}). Analysis may still be running: call wait_for_analysis. Call status: earlier addresses and names no longer apply.`;
  }),
};

const close_program: ToolDef<Record<string, never>> = {
  name: "close_program",
  description: "Save and close the open program. Below Full access the user is asked first. Afterwards only open_program and status work.",
  inputSchema: obj({}),
  annotations: ann("Close program", false, true, true), access: "edit", timeoutSecs: 60,
  handler: guard(async (ctx) => {
    const cur = ctx.session;
    if (!cur) return "No program is open.";
    await confirmReplace(ctx, `The agent wants to close ${label(cur)} (it is saved first). Allow?`);
    if (ctx.ui) await ctx.ui.closeProgram(); else await ctx.backend.lifecycle.close(cur);
    return `Closed ${label(cur)}.`;
  }),
};

// ---- coverage ----
const load_coverage: ToolDef<{ path: string; offset?: number; limit?: number }> = {
  name: "load_coverage",
  description: "Read a coverage file (text: `0xSTART-0xEND` inclusive or `0xADDR` per line, `#` comments; default address space only) and summarise it per function: bytes covered of the function's size, for every function it touches. Does not tint the app's views. `path` must be absolute.",
  inputSchema: obj({ path: str("Absolute path of the coverage file."), ...PAGE }, ["path"]),
  annotations: ann("Load coverage", true, false, true), access: "full", capability: "coverage", timeoutSecs: 60,
  handler: guard(async (ctx, a) => {
    const ops = needProgram(ctx), path = checkPath(a.path);
    const { ranges } = await ops.coverage.load({ path });
    const spans = ranges.flatMap((r) => { const s = offIn(r.start, ""), e = offIn(r.end, ""); return s !== null && e !== null && e >= s ? [[s, e + 1n] as const] : []; }).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const merged: (readonly [bigint, bigint])[] = [];
    for (const s of spans) { const l = merged.at(-1); if (l && s[0] <= l[1]) merged[merged.length - 1] = [l[0], s[1] > l[1] ? s[1] : l[1]]; else merged.push(s); }
    const fns = await ctx.functions();
    const rows: string[][] = [];
    for (const f of fns) {
      const s = offIn(f.entry, ""); if (s === null) continue;
      const e = s + BigInt(Math.max(f.size, 1));
      let hit = 0n;
      for (const m of merged) { if (m[0] >= e) break; if (m[1] > s) hit += (m[1] < e ? m[1] : e) - (m[0] > s ? m[0] : s); }
      if (hit > 0n) rows.push([esc(f.name, 80), f.entry, `${hit}/${f.size}`, `${Math.round(Number(hit) * 100 / Math.max(f.size, 1))}%`]);
    }
    const bytes = merged.reduce((n, m) => n + (m[1] - m[0]), 0n);
    return `${esc(path, 200)}: ${ranges.length} ranges (${bytes} bytes), touching ${rows.length} of ${fns.length} functions (columns: function, entry, covered bytes/size, percent)\n${capText(table(rows), int(a.offset, 0, 0, 1e9), int(a.limit, 200, 1, 500))}`;
  }),
};

export const fullTools: readonly ToolDef[] = [patch, list_patches, save, export_, open_program, close_program, load_coverage];

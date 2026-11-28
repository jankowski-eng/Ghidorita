import type { CommentKind, EnumOp, StructOp } from "../../../../protocol";
import { isKind, toToolError } from "../errors";
import { resolveAddress, resolveFunction } from "../resolve";
import { needProgram, ToolError, type JsonSchema, type ToolAnnotations, type ToolCtx, type ToolDef } from "../types";

/**
 * Every edit builds its params, tags them (`ctx.tag`) and hands THAT object to the backend call: rpc.ts passes the caller's own object to the
 * change log, so the identity is the attribution. Never copy or spread between tag and call.
 * One retry when the backend says `cancelled` (a variable edit that another write raced); a fresh tagged object per attempt, none once aborted.
 */
async function attempt<T>(ctx: ToolCtx, call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (e) {
    if (!isKind(e, "cancelled") || ctx.signal.aborted) throw toToolError(e);
    try { return await call(); } catch (e2) { throw toToolError(e2); }
  }
}

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>, required: string[]): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const ann = (title: string, destructiveHint: boolean, idempotentHint: boolean): ToolAnnotations => ({ title, readOnlyHint: false, destructiveHint, idempotentHint });
const FN = str("Function name or address (0x401000, main, FUN_00401000).");
const AT = str("Address or symbol name.");
const SLOW = 90; // a variable edit decompiles first (sidecar default 30 s), and may run twice

const renameSymbol: ToolDef<{ target: string; newName: string }> = {
  name: "rename_symbol",
  description: "Rename the function or label at an address or named target. Use create_label where nothing is named yet.",
  inputSchema: obj({ target: AT, newName: str("The new name, no whitespace.") }, ["target", "newName"]),
  annotations: ann("Rename symbol", false, true), access: "edit", capability: "editing", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx), address = await resolveAddress(a.target, ops, ctx.signal);
    await attempt(ctx, () => ops.edits.renameSymbol(ctx.tag({ address, newName: a.newName })));
    return `Renamed ${a.target} to ${a.newName} at ${address}.`;
  },
};

const createLabel: ToolDef<{ address: string; name: string }> = {
  name: "create_label",
  description: "Name an address that has no symbol yet. To rename an existing symbol use rename_symbol.",
  inputSchema: obj({ address: AT, name: str("The label, no whitespace.") }, ["address", "name"]),
  annotations: ann("Create label", false, false), access: "edit", capability: "editing", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx), address = await resolveAddress(a.address, ops, ctx.signal);
    await attempt(ctx, () => ops.edits.createLabel(ctx.tag({ address, name: a.name })));
    return `Created label ${a.name} at ${address}.`;
  },
};

const renameVariable: ToolDef<{ function: string; variable: string; newName: string }> = {
  name: "rename_variable",
  description: "Rename a local variable or parameter as the decompiler shows it (e.g. local_10, param_1). Decompile first to see the names; they can change after an edit.",
  inputSchema: obj({ function: FN, variable: str("The variable's current name."), newName: str("The new name.") }, ["function", "variable", "newName"]),
  annotations: ann("Rename variable", false, true), access: "edit", capability: "variableEditing", timeoutSecs: SLOW,
  async handler(ctx, a) {
    const ops = needProgram(ctx), f = await resolveFunction(a.function, ops, ctx.signal);
    await attempt(ctx, () => ops.edits.renameVariable(ctx.tag({ entry: f.entry, name: a.variable, newName: a.newName })));
    return `Renamed ${a.variable} to ${a.newName} in ${f.name} (${f.entry}). Decompile again: other names may have changed.`;
  },
};

const retypeVariable: ToolDef<{ function: string; variable: string; type: string }> = {
  name: "retype_variable",
  description: "Change the data type of a local variable or parameter. The type is a name or path as define_data takes it (int, char *, /dword, MyStruct *).",
  inputSchema: obj({ function: FN, variable: str("The variable's current name."), type: str("The new data type.") }, ["function", "variable", "type"]),
  annotations: ann("Retype variable", true, true), access: "edit", capability: "variableEditing", timeoutSecs: SLOW,
  async handler(ctx, a) {
    const ops = needProgram(ctx), f = await resolveFunction(a.function, ops, ctx.signal);
    await attempt(ctx, () => ops.edits.retypeVariable(ctx.tag({ entry: f.entry, name: a.variable, dataType: a.type })));
    return `Retyped ${a.variable} as ${a.type} in ${f.name} (${f.entry}). Decompile again to see the effect.`;
  },
};

const setSignature: ToolDef<{ function: string; signature: string }> = {
  name: "set_function_signature",
  description: "Replace a function's signature with a C declaration, e.g. `int parse_header(char *buf, size_t len)`. Replaces the return type, name, parameters and calling convention as given.",
  inputSchema: obj({ function: FN, signature: str("A C function declaration.") }, ["function", "signature"]),
  annotations: ann("Set function signature", true, true), access: "edit", capability: "editing", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx), f = await resolveFunction(a.function, ops, ctx.signal), signature = a.signature.trim();
    await attempt(ctx, () => ops.edits.setFunctionSignature(ctx.tag({ entry: f.entry, signature })));
    return `Set the signature of ${f.name} (${f.entry}) to: ${signature}`;
  },
};

const KINDS: CommentKind[] = ["eol", "pre", "post", "plate", "repeatable"];
const setComment: ToolDef<{ address: string; text: string; kind?: CommentKind }> = {
  name: "set_comment",
  description: "Set the comment at an address (replaces the one of that kind; empty text clears it). Kinds: eol (end of line, default), pre, post, plate (header box), repeatable.",
  inputSchema: obj({ address: AT, text: str("The comment; empty clears it."), kind: { type: "string", enum: KINDS, description: "default eol" } }, ["address", "text"]),
  annotations: ann("Set comment", true, true), access: "edit", capability: "editing", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx), address = await resolveAddress(a.address, ops, ctx.signal), kind = a.kind ?? "eol";
    await attempt(ctx, () => ops.edits.setComment(ctx.tag({ address, kind, text: a.text })));
    return a.text ? `Set the ${kind} comment at ${address}.` : `Cleared the ${kind} comment at ${address}.`;
  },
};

const defineData: ToolDef<{ address: string; type: string }> = {
  name: "define_data",
  description: "Define data of a type at an address, replacing any code or data that is in the way. Types: int, char[16], pointer, /dword, a struct name.",
  inputSchema: obj({ address: AT, type: str("Data type name or path; arrays as char[4].") }, ["address", "type"]),
  annotations: ann("Define data", true, true), access: "edit", capability: "typeEditing", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx), address = await resolveAddress(a.address, ops, ctx.signal);
    await attempt(ctx, () => ops.edits.defineData(ctx.tag({ address, dataType: a.type })));
    return `Defined ${a.type} at ${address}.`;
  },
};

const createFunction: ToolDef<{ address: string; name?: string }> = {
  name: "create_function",
  description: "Create a function at an address (undefined bytes are disassembled first). Fails if the address is already inside a function.",
  inputSchema: obj({ address: AT, name: str("Optional name; default is FUN_<address>.") }, ["address"]),
  annotations: ann("Create function", false, false), access: "edit", capability: "editing", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx), address = await resolveAddress(a.address, ops, ctx.signal);
    const r = await attempt(ctx, () => ops.edits.createFunction(ctx.tag({ address, ...(a.name ? { name: a.name } : {}) })));
    return `Created function ${r.name} at ${r.entry}.`;
  },
};

const setBookmark: ToolDef<{ address: string; comment: string; category?: string }> = {
  name: "set_bookmark",
  description: "Record a finding as a Note bookmark the user sees in the Bookmarks panel. Replaces the note of the same category at that address.",
  inputSchema: obj({ address: AT, comment: str("What you found."), category: str("default agent") }, ["address", "comment"]),
  annotations: ann("Set bookmark", true, true), access: "edit", capability: "bookmarks", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx), address = await resolveAddress(a.address, ops, ctx.signal), category = a.category ?? "agent";
    await attempt(ctx, () => ops.bookmarks.set(ctx.tag({ address, category, comment: a.comment })));
    return `Bookmarked ${address} (${category}).`;
  },
};

const TYPE_KINDS = ["struct", "union", "enum", "typedef", "pointer", "category"] as const;
type TypeKind = typeof TYPE_KINDS[number];
const createType: ToolDef<{ kind: TypeKind; name?: string; category?: string; size?: number; base?: string }> = {
  name: "create_type",
  description: "Create a data type in the program: struct or union (size = bytes of undefined filler, then edit_struct), enum (size 1, 2, 4 or 8), typedef or pointer (base = the target type), or an empty category. Returns its path.",
  inputSchema: obj({
    kind: { type: "string", enum: TYPE_KINDS }, name: str("No whitespace; not for pointer."), category: str("Category path, default /."),
    size: { type: "integer", minimum: 0, description: "struct/union bytes, or enum size 1, 2, 4, 8" }, base: str("typedef or pointer target type."),
  }, ["kind"]),
  annotations: ann("Create type", false, false), access: "edit", capability: "typeEditing", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx);
    const r = await attempt(ctx, () => ops.typeEdits.createDataType(ctx.tag({ kind: a.kind, ...(a.name ? { name: a.name } : {}), ...(a.category ? { category: a.category } : {}), ...(a.size !== undefined ? { size: a.size } : {}), ...(a.base ? { base: a.base } : {}) })));
    return `Created ${a.kind} ${r.path}.`;
  },
};

const editStruct: ToolDef<{ path: string; op: StructOp }> = {
  name: "edit_struct",
  description: "Edit a struct or union by one operation: add (append), insert (before ordinal), set (change the component at ordinal; omitted fields are kept, \"\" clears), delete, clear (back to filler), move (packed structs and unions), resize (unpacked), pack. Types are fixed-length names like int, char[8], Other *.",
  inputSchema: obj({
    path: str("Type path, e.g. /MyStruct."),
    op: { type: "object", additionalProperties: false, required: ["op"], properties: {
      op: { type: "string", enum: ["add", "insert", "set", "delete", "clear", "move", "resize", "pack"] },
      ordinal: { type: "integer", minimum: 0, description: "component index, as data_type shows it" }, type: str("add, insert, set"), name: str("field name"), comment: str("field comment"),
      to: { type: "integer", minimum: 0, description: "move: the new ordinal" }, size: { type: "integer", minimum: 0, description: "resize: bytes" },
      packed: { type: "boolean", description: "pack" }, packingValue: { type: "integer" }, minAlign: { type: "integer" },
    } },
  }, ["path", "op"]),
  annotations: ann("Edit struct", true, false), access: "edit", capability: "typeEditing", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx);
    await attempt(ctx, () => ops.typeEdits.editStruct(ctx.tag({ path: a.path, op: a.op })));
    return `Edited ${a.path}: ${a.op.op}.`;
  },
};

const editEnum: ToolDef<{ path: string; op: EnumOp }> = {
  name: "edit_enum",
  description: "Edit an enum by one operation: set (add a member, or change its value; oldName renames it), remove, resize (size 1, 2, 4 or 8). Values are strings: decimal or 0x hex.",
  inputSchema: obj({
    path: str("Type path, e.g. /MyEnum."),
    op: { type: "object", additionalProperties: false, required: ["op"], properties: {
      op: { type: "string", enum: ["set", "remove", "resize"] }, name: str("member name"), value: str("member value"), oldName: str("set: the member's current name, to rename it"), size: { type: "integer", enum: [1, 2, 4, 8] },
    } },
  }, ["path", "op"]),
  annotations: ann("Edit enum", true, false), access: "edit", capability: "typeEditing", timeoutSecs: 30,
  async handler(ctx, a) {
    const ops = needProgram(ctx);
    await attempt(ctx, () => ops.typeEdits.editEnum(ctx.tag({ path: a.path, op: a.op })));
    return `Edited ${a.path}: ${a.op.op}.`;
  },
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * What the sidecar names the undo step of each change-log label (changeLog.describe -> sidecar `ses.edit(name, ...)`). The names are not one to one
 * with the labels (the label drops the old name, the undo name drops the new one), so each agent edit kind has a pair: a label pattern, and the
 * undo name it must correspond to. A label with no pair (a patch, an equate, ...) never matches: the agent did not make it, so undo refuses.
 */
const UNDO_NAMES: [RegExp, (m: RegExpMatchArray) => RegExp][] = [
  [/^Rename to (.+)$/s, (m) => new RegExp(`^Rename (?!variable\b).+ to ${esc(m[1])}$`, "s")],
  [/^Label (.+)$/s, (m) => new RegExp(`^Create label ${esc(m[1])}$`, "s")],
  [/^Comment \((\w+)\)$/, (m) => new RegExp(`^Set ${m[1]} comment$`)],
  [/^Clear comment \((\w+)\)$/, (m) => new RegExp(`^Clear ${m[1]} comment$`)],
  [/^Create function\b/, () => /^Create function at /],
  [/^Signature /, () => /^Edit signature of /],
  [/^Retype /, () => /^Retype variable\b/],
  [/^Rename .+ to .+$/s, () => /^Rename variable\b/],
  [/^Define /, () => /^Define data$/],
  [/^Bookmark/, () => /^Set bookmark$/],
  [/^Create (struct|union|enum|typedef|pointer|category)(?: (.+))?$/s, (m) => new RegExp(`^Create ${m[1]} ${esc(m[2] ?? "pointer")}$`, "s")],
  [/^Edit (?:structure|enum) (.+)$/s, (m) => new RegExp(`^Edit ${esc(m[1].split("/").pop() ?? "")}: `)],
];
export function undoNameMatches(label: string, undoName: string | undefined): boolean {
  if (!undoName) return false;
  for (const [l, expect] of UNDO_NAMES) { const m = label.match(l); if (m) return expect(m).test(undoName); }
  return false;
}

const undoAgentEdit: ToolDef<Record<string, never>> = {
  name: "undo_agent_edit",
  description: "Undo your own most recent edit. Refuses when the newest change is the user's, or was made by another client, so it can never revert the user's work. Call again to step back further.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: ann("Undo agent edit", true, false), access: "edit", capability: "undo", timeoutSecs: 30,
  async handler(ctx) {
    const ops = needProgram(ctx);
    // Ghidra's undo stack is shared with the user. Undo only when (1) the newest live change-log entry was made by THIS client (not another agent:
    // that would revert someone else's work too), (2) the provider can undo, and (3) the provider's top undo step is the one that entry names.
    // Remaining gap: an edit that lands between this check and the undo, or a user edit of the same kind and target the log never saw.
    const n = ctx.changes.newest();
    if (!n) throw new ToolError("Nothing to undo: none of your changes is still undoable (saved changes can no longer be undone).");
    if (!n.by) throw new ToolError(`The newest change is the user's (${n.label}); I will not undo it. Ask the user to undo it, or leave it.`);
    if (n.by !== ctx.client) throw new ToolError(`The newest change (${n.label}) was made by ${n.by}, not by you; I will not undo it.`);
    let u;
    try { u = await ops.history.state(); } catch (e) { throw toToolError(e); }
    if (!u.canUndo) throw new ToolError("Nothing to undo: the program has no undo history left (it was saved, or analysis ran).");
    if (!undoNameMatches(n.label, u.undoName)) throw new ToolError(`The program's newest undo step is "${u.undoName ?? "?"}", which does not match your last change (${n.label}): someone else edited since. Nothing was undone.`);
    try { await ops.history.undo(); } catch (e) { throw toToolError(e); }
    return `Undid: ${n.label}.`;
  },
};

export const editTools: ToolDef[] = [renameSymbol, createLabel, renameVariable, retypeVariable, setSignature, setComment, defineData, createFunction, setBookmark, createType, editStruct, editEnum, undoAgentEdit];

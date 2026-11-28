import type { CommentKind, EnumOp, StructOp } from "../../../../protocol";
import { isKind, toToolError } from "../errors";
import { esc as clip } from "../format";
import { resolveAddress, resolveFunction } from "../resolve";
import { needProgram, ToolError, type JsonSchema, type ToolAnnotations, type ToolCtx, type ToolDef } from "../types";

/**
 * Every edit builds its params, tags them (`ctx.tag`) and hands THAT object to the backend call: rpc.ts passes the caller's own object to the
 * change log, so the identity is the attribution. Never copy or spread between tag and call.
 * One retry when the backend says `cancelled` (a variable edit that another write raced); a fresh tagged object per attempt, none once aborted.
 */
async function attempt<T>(ctx: ToolCtx, send: () => Promise<T>): Promise<T> {
  // a call cancelled (or access switched off) while the name was still being resolved must not reach the sidecar: check right before each write
  const call = () => { if (ctx.signal.aborted) throw new ToolError("Cancelled."); return send(); };
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
    return `Renamed ${clip(a.target, 120)} to ${clip(a.newName, 120)} at ${address}.`;
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
    return `Created label ${clip(a.name, 120)} at ${address}.`;
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
    return `Renamed ${clip(a.variable, 120)} to ${clip(a.newName, 120)} in ${clip(f.name, 120)} (${f.entry}). Decompile again: other names may have changed.`;
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
    return `Retyped ${clip(a.variable, 120)} as ${clip(a.type, 120)} in ${clip(f.name, 120)} (${f.entry}). Decompile again to see the effect.`;
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
    return `Set the signature of ${clip(f.name, 120)} (${f.entry}) to: ${clip(signature, 300)}`;
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
    return `Defined ${clip(a.type, 120)} at ${address}.`;
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
    return `Created function ${clip(r.name, 120)} at ${r.entry}.`;
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
    return `Bookmarked ${address} (${clip(category, 60)}).`;
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
    return `Created ${a.kind} ${clip(r.path, 200)}.`;
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
    return `Edited ${clip(a.path, 200)}: ${clip(a.op.op, 20)}.`;
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
    return `Edited ${clip(a.path, 200)}: ${clip(a.op.op, 20)}.`;
  },
};

const undoAgentEdit: ToolDef<Record<string, never>> = {
  name: "undo_agent_edit",
  description: "Undo your own most recent edit. Refuses when the newest change is the user's, or was made by another client, so it can never revert the user's work. Call again to step back further.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: ann("Undo agent edit", true, false), access: "edit", capability: "undo", timeoutSecs: 30,
  async handler(ctx) {
    const ops = needProgram(ctx);
    // Ghidra's undo stack is shared with the user. Undo only when the newest live change-log entry was made by THIS connection (not the user, not another
    // agent) and then ask the provider to undo exactly the step that edit committed (`expect`): it checks on its own thread, so nothing can land in between.
    // Remaining gap: a user edit that happens to carry the very same undo name (two "Set eol comment" steps) between our edit and this call.
    const n = ctx.changes.newest();
    if (!n) throw new ToolError("Nothing to undo: none of your changes is still undoable (saved changes can no longer be undone).");
    if (!n.by) throw new ToolError(`The newest change is the user's (${clip(n.label, 80, true)}); I will not undo it. Ask the user to undo it, or leave it.`);
    if (n.by !== ctx.client) throw new ToolError(`The newest change (${clip(n.label, 80, true)}) was made by ${clip(n.by, 60)}, not by you; I will not undo it.`);
    if (!n.undoName) throw new ToolError(`The provider did not report an undo step for your last change (${clip(n.label, 80, true)}), so it cannot be undone safely from here. Ask the user to undo it.`);
    try { await ops.history.undo(n.undoName); } catch (e) {
      if (isKind(e, "cancelled")) throw new ToolError(`Your last change (${clip(n.label, 80, true)}) is no longer the newest undo step: someone else edited since. Nothing was undone.`);
      if (isKind(e, "invalid")) throw new ToolError("Nothing to undo: the program has no undo history left (it was saved, or analysis ran).");
      throw toToolError(e);
    }
    return `Undid: ${clip(n.label, 200)}.`;
  },
};

export const editTools: ToolDef[] = [renameSymbol, createLabel, renameVariable, retypeVariable, setSignature, setComment, defineData, createFunction, setBookmark, createType, editStruct, editEnum, undoAgentEdit];

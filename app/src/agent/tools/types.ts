import { BackendError } from "../../renderer/backend";
import { isKind, toToolError } from "../errors";
import { esc, fits } from "../format";
import { needProgram, ToolError, type ToolCtx, type ToolDef } from "../types";

/** One retry when the backend says `cancelled` (as edit.ts: a fresh tagged params object per attempt, none once aborted). */
async function attempt<T>(ctx: ToolCtx, call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (e) {
    if (!isKind(e, "cancelled") || ctx.signal.aborted) throw e;
    return await call();
  }
}

const MAX_C = 200_000; // the sidecar's own cap

const defineTypes: ToolDef<{ c: string; category?: string }> = {
  name: "define_types",
  description: "Define structs, unions, enums, typedefs and function prototypes from C source, as you would write them in a header; one undo step, all or nothing. A type with the same name is replaced (data using it follows); a type the C only uses (`struct Base b;`) is left alone. Built-in names (int, char, uint32_t, ...) work. There is no preprocessor (no #include or #define) and Windows names such as DWORD need a typedef. `category` (e.g. /net) puts the declared types there; default /. On a parse error nothing is defined: fix the C at the reported line and call again. Use data_type to read the result, retype_variable or define_data to apply it.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["c"],
    properties: { c: { type: "string", minLength: 1, maxLength: MAX_C, description: "C declarations, e.g. `struct Hdr { uint32_t magic; char name[16]; };`" }, category: { type: "string", description: "Category path starting with /, default /." } },
  },
  // destructive: it replaces same-named types. idempotent: the same C twice leaves the same types.
  annotations: { title: "Define types from C", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  access: "edit", capability: ["typeEditing", "parseCTypes"], appOnly: false, timeoutSecs: 60,
  async handler(ctx, a) {
    const ops = needProgram(ctx);
    let r;
    try {
      r = await attempt(ctx, () => ops.typeEdits.parseCTypes(ctx.tag({ c: a.c, ...(a.category ? { category: a.category } : {}) })));
    } catch (e) {
      if (e instanceof BackendError && e.kind === "invalid") throw new ToolError(`Nothing was defined. ${e.message.split("\n").map((l) => esc(l, 240)).join("\n")}\nFix the C (at the line named, if there is one) and call define_types again.`);
      throw toToolError(e);
    }
    if (!r.created.length && !r.replaced.length) return "No type changed: everything the C declares already exists identically.";
    const lines = [`Defined ${r.created.length + r.replaced.length} types (one undo step).`];
    for (const [label, paths] of [["Created", r.created], ["Replaced", r.replaced]] as const) if (paths.length) lines.push(`${label}:`, ...paths.map((p) => `  ${esc(p, 200)}`));
    const n = fits(lines);
    return n < lines.length ? [...lines.slice(0, n), `… ${lines.length - n} more lines`].join("\n") : lines.join("\n");
  },
};

export const typesTools: ToolDef[] = [defineTypes];

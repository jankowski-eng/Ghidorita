import { useRef } from "react";
import type { Address, CommentKind } from "../../../../protocol";
import { allowsEdit } from "../../capabilities";
import { arrayPlan, arrayType, equateTarget, fieldTarget, noReturnTarget, splitTarget, renameTarget, retypeTarget, tokenAt, undoRoute, isOwnName, xrefTargetOf, type EditAction, type Focus } from "../editActions";
import type { EditSpec } from "../EditDialog";
import type { Program } from "../store/program";
import { useSession } from "../store/session";
import type { TabsApi } from "../useTabs";

const NO_FIELD = "(no field)";
/** Enum members whose value is `value` (suggestions for Set Equate; best effort: the program's enums among the first 1000 matches of list_data_types). */
async function enumMembers(ops: Program["api"], value: string, size: number): Promise<{ label: string; name: string; enum: string }[]> {
  try {
    const enums = (await ops.types.listDataTypes({ query: "", limit: 1000 }).result).filter((t) => t.kind === "enum" && t.source === "program").slice(0, 20);
    const out: { label: string; name: string; enum: string }[] = [];
    for (const e of enums) for (const m of (await ops.types.getDataType({ path: e.path })).values ?? []) if (BigInt.asUintN(size * 8, BigInt(m.value)) === BigInt.asUintN(size * 8, BigInt(value))) out.push({ label: `${e.name}.${m.name}`, name: m.name, enum: e.path });
    return out;
  } catch { return []; }
}

export const focusKind = (el: Element | null): Focus => {
  if (!el) return "other";
  // Monaco's hidden textarea is the editor itself; only its find/replace widget inputs are real text inputs
  if (el.matches("input, textarea, select, [contenteditable]") && (!el.closest(".monaco-editor") || el.closest(".find-widget"))) return "input";
  if (el.closest(".monaco-editor")) return "decompiler";
  return el.closest(".lbox") ? "listing" : "other";
};

/** Editing and references from the keyboard and menu: rename, comment, retype, create, undo/redo, save, "show references". The dialogs they open are in the views store (DialogHost). */
export function useEditing(tabs: TabsApi) {
  const session = useSession();
  const { views, refs, caps, store } = session;
  const fnNames = () => new Map(store.getState().funcs.map((f) => [f.entry, f.name]));
  const activeTab = () => tabs.state.tabs.find((x) => x.id === tabs.state.active) ?? null;
  const lastType = useRef<string | null>(null); // Y repeats it; set by T and P like Ghidra's "recently used" (Ghidra's array key does not set it)
  const define = async (ops: Program["api"], at: Address, dataType: string) => { await ops.edits.defineData({ address: at, dataType }); lastType.current = dataType; };
  const decompilerFocused = (kind: Focus) => kind === "decompiler" || (kind !== "listing" && refs.lastPane.current === "decompiler");

  const ask = (current: Program, spec: EditSpec, submit: (v: string, k: CommentKind) => Promise<void>) => {
    if (session.program() === current) views.dispatch({ type: "set", patch: { dlg: { spec, submit } } });
  };
  const editSignature = async (current: Program, entry: Address) => {
    const f = await current.api.functions.containing({ address: entry });
    if (!f) return session.flash("No function here.");
    ask(current, { title: "Edit function signature", label: "Signature", field: "text", initial: f.signature, submit: "Apply" },
      async (v) => { await current.api.edits.setFunctionSignature({ entry: f.entry, signature: v.trim() }); });
  };
  const askBookmark = (at: Address) => views.dispatch({ type: "set", patch: { formDlg: { title: "Add bookmark", submit: "Add", fields: [{ key: "category", label: "Category (optional)" }, { key: "comment", label: "Comment" }],
    go: async (v) => { await session.program()?.api.bookmarks.set({ address: at, category: v.category.trim(), comment: v.comment.trim() }); } } } });
  const listingEdit = async (current: Program, a: EditAction) => {
    const ops = current.api;
    const row = refs.listingRow.current?.();
    if (!row) return session.flash("Cursor row not loaded.");
    const at = row.address;
    if (a === "rename") {
      const f = await current.lookup.containing(at);
      if (row.label || (f && f.entry === at)) ask(current, { title: "Rename", label: "New name", field: "text", initial: row.label ?? f!.name, submit: "Rename" },
        async (v) => { await ops.edits.renameSymbol({ address: at, newName: v.trim() }); });
      else ask(current, { title: "Create label", label: "Label name", field: "text", initial: "", submit: "Create label" }, // nothing to rename here: L creates the label
        async (v) => { await ops.edits.createLabel({ address: at, name: v.trim() }); });
    } else if (a === "comment") {
      const comments = await ops.edits.getComments({ address: at });
      ask(current, { title: "Set comment", label: "Comment", field: "comment", initial: comments.eol ?? "", submit: "Set comment", kind: "eol", comments },
        async (v, kind) => { await ops.edits.setComment({ address: at, kind, text: v }); });
    } else if (a === "createFunction") await ops.edits.createFunction({ address: at });
    else if (a === "bookmark") askBookmark(at);
    else if (a === "clear") await ops.edits.clearCode({ address: at });
    else if (a === "defineData") ask(current, { title: "Define data", label: "Data type", field: "datatype", initial: "", submit: "Define" },
      async (v) => { await define(ops, at, v.trim()); });
    else if (a === "definePointer") await define(ops, at, "pointer"); // Ghidra's default pointer: the program's pointer size
    else if (a === "repeatData") { if (lastType.current) await ops.edits.defineData({ address: at, dataType: lastType.current }); else session.flash("No data type applied yet: use T or P first."); }
    else if (a === "defineArray") {
      const plan = arrayPlan(await ops.listing.rows({ address: at, count: 257 })); // shortcut: looks 256 rows ahead for the next defined item or label
      if (!plan) return session.flash("Define Array works on data, not on code.");
      views.dispatch({ type: "set", patch: { formDlg: { title: `Define ${plan.elem}[]`, submit: "Define", fields: [{ key: "count", label: "Number of elements", initial: String(plan.count) }],
        go: async (v) => {
          const n = Number(v.count.trim());
          if (!Number.isInteger(n) || n < 1) throw new Error("Enter a whole number of elements, 1 or more.");
          await ops.edits.defineData({ address: at, dataType: arrayType(plan.elem, n) });
        } } } });
    }
    else if (a === "createStruct") views.dispatch({ type: "set", patch: { formDlg: { title: "Create structure", submit: "Create", fields: [{ key: "name", label: "Structure name" }, { key: "length", label: "Length (bytes)", initial: String(row.length) }],
      go: async (v) => { await ops.edits.createStructFromData({ address: at, length: Number(v.length), name: v.name.trim() }); } } } });
    else if (a === "signature") { const f = await current.lookup.containing(at); if (f) await editSignature(current, f.entry); else session.flash("No function here."); }
    else if (a === "retype") session.flash("Retype works on a variable in the decompiler.");
    else if (a === "setEquate" || a === "noReturn" || a === "splitVariable" || a === "forceField") session.flash("This edit works on a token in the decompiler.");
  };
  const decompEdit = async (current: Program, a: EditAction) => {
    const ops = current.api;
    const tab = activeTab(), d = tab ? tabs.data[tab.id] : undefined, ed = refs.editor.current;
    if (!tab || !d || !ed) return;
    const pos = ed.getPosition();
    const tok = pos ? tokenAt(d.tokens, pos.lineNumber, pos.column) : undefined;
    const text = tok ? (d.text.split("\n")[tok.line] ?? "").slice(tok.colStart, tok.colEnd) : "";
    const entry = tab.entry, fnName = fnNames().get(entry) ?? "";
    if (a === "rename") {
      const t = renameTarget(tok, text, { entry, name: fnName });
      if (!t) return session.flash("Nothing to rename at the cursor.");
      if (t.kind === "variable") ask(current, { title: "Rename variable", label: "New name", field: "text", initial: t.name, submit: "Rename" },
        async (v) => { await ops.edits.renameVariable({ entry, name: t.name, newName: v.trim() }); });
      else ask(current, { title: "Rename function", label: "New name", field: "text", initial: t.current, submit: "Rename" },
        async (v) => { await ops.edits.renameSymbol({ address: t.address, newName: v.trim() }); });
    } else if (a === "retype") {
      const name = retypeTarget(tok);
      if (!name) return session.flash("Put the cursor on a variable to retype it.");
      ask(current, { title: "Retype variable", label: "Data type", field: "datatype", initial: "", submit: "Retype" },
        async (v) => { await ops.edits.retypeVariable({ entry, name, dataType: v.trim() }); });
    } else if (a === "autoStruct") {
      const name = retypeTarget(tok);
      if (!name) return session.flash("Put the cursor on a variable to auto create a structure for it.");
      views.dispatch({ type: "set", patch: { formDlg: { title: "Auto create structure", submit: "Create", fields: [{ key: "name", label: "Structure name (empty = automatic)" }],
        go: async (v) => { await ops.edits.autoCreateStructure({ entry, name, structName: v.name.trim() || undefined }); } } } });
    } else if (a === "setEquate") {
      const t = equateTarget(tok);
      if (!t) return session.flash("Put the cursor on a number to set an equate on it.");
      const names = await enumMembers(ops, t.value, t.size);
      views.dispatch({ type: "set", patch: { formDlg: { title: "Set equate", submit: "Set", fields: [{ key: "name", label: "Equate name or enum member", initial: names[0]?.label ?? "", choices: names.map((n) => n.label) }],
        go: async (v) => { const typed = v.name.trim(), pick = names.find((n) => n.label === typed); await ops.edits.setEquate({ ...t, name: pick?.name ?? typed, enum: pick?.enum }); } } } });
    } else if (a === "noReturn") {
      const t = noReturnTarget(tok, text, { entry, name: fnName });
      if (!t) return session.flash("Put the cursor on a function name to mark it as never returning.");
      await ops.edits.setFunctionNoReturn({ entry: t.entry });
    } else if (a === "splitVariable") {
      const t = splitTarget(tok);
      if (!t) return session.flash("Nothing to split out here: the variable is one use only.");
      views.dispatch({ type: "set", patch: { formDlg: { title: "Split out as new variable", submit: "Split", fields: [{ key: "name", label: "New variable name" }],
        go: async (v) => { await ops.edits.splitVariable({ entry, name: t.name, address: t.address, newName: v.name.trim() }); } } } });
    } else if (a === "forceField") {
      const t = fieldTarget(d.tokens, tok, (x) => (d.text.split("\n")[x.line] ?? "").slice(x.colStart, x.colEnd));
      if (!t) return session.flash("Force Field works on a union access.");
      const members = caps.has("dataTypes") ? (await ops.types.getDataType({ path: t.union })).components?.filter((c) => !c.undefined).map((c) => c.name ?? c.defaultName) ?? [] : []; // suggestions only: without type browsing the field is typed
      views.dispatch({ type: "set", patch: { formDlg: { title: "Force field", submit: "Force", fields: [{ key: "field", label: "Field", initial: members.includes(t.text) ? t.text : "", choices: [...members, NO_FIELD] }],
        go: async (v) => { const f = v.field.trim(); await ops.edits.forceUnionField({ entry, address: t.address, text: t.text, occurrence: t.occurrence, field: f === NO_FIELD ? null : f }); } } } });
    } else if (a === "bookmark") {
      const at = d.tokens.find((t) => t.line === (pos?.lineNumber ?? 1) - 1 && t.address)?.address;
      if (!at) return session.flash("No address on this line.");
      askBookmark(at);
    } else if (a === "signature") await editSignature(current, entry);
    else if (a === "comment") {
      const line0 = (pos?.lineNumber ?? 1) - 1;
      const at = d.tokens.find((t) => t.line === line0 && t.address)?.address;
      if (!at) return session.flash("No address on this line.");
      const comments = await ops.edits.getComments({ address: at });
      ask(current, { title: "Set comment", label: "Comment", field: "comment", initial: comments.pre ?? "", submit: "Set comment", kind: "pre", comments },
        async (v, kind) => { await ops.edits.setComment({ address: at, kind, text: v }); });
    } else session.flash("Use the listing for this action.");
  };

  const edit = async (a: EditAction) => {
    const current = session.program();
    if (!current || session.blocked() || views.getState().importFor || !allowsEdit(caps, a)) return;
    const kind = focusKind(document.activeElement);
    const dialogOpen = () => !!views.getState().dlg || !!views.getState().formDlg;
    if (a === "undo" || a === "redo") {
      if (undoRoute(kind) === "text") { document.execCommand(a); return; } // a text input keeps its own undo
      if (dialogOpen()) return; // no program undo under an open dialog
      return session.undoRedo(a);
    }
    if (a === "save") return session.save();
    if (dialogOpen()) return;
    await session.send(() => (decompilerFocused(kind) ? decompEdit(current, a) : listingEdit(current, a)));
  };

  // X: references to the listing cursor row, or to the decompiler token under the cursor (pinned in the xref panel)
  const showXrefs = () => {
    if (!session.program() || session.blocked() || !caps.has("references")) return;
    const kind = focusKind(document.activeElement);
    if (decompilerFocused(kind)) {
      const tab = activeTab(), d = tab ? tabs.data[tab.id] : undefined, pos = refs.editor.current?.getPosition();
      if (!tab || !d || !pos) return;
      const tok = tokenAt(d.tokens, pos.lineNumber, pos.column);
      const text = tok ? (d.text.split("\n")[tok.line] ?? "").slice(tok.colStart, tok.colEnd) : "";
      const t = xrefTargetOf(tok, text, { entry: tab.entry, name: fnNames().get(tab.entry) ?? "" });
      if (t && (t.type !== "variable" || caps.has("variableReferences"))) views.dispatch({ type: "set", patch: { xrefTarget: t, useHl: null } });
      else session.flash("No references for the token at the cursor.");
    } else {
      const a = refs.cursor.current || refs.topAddr.current;
      if (a) { const at = refs.listingRow.current?.()?.address ?? a; views.dispatch({ type: "set", patch: { xrefTarget: { type: "address", address: at, label: at } } }); }
    }
  };
  const canAt = (line1: number, col1: number) => {
    const tab = activeTab(), d = tab ? tabs.data[tab.id] : undefined;
    const tok = d ? tokenAt(d.tokens, line1, col1) : undefined;
    const text = tok && d ? (d.text.split("\n")[tok.line] ?? "").slice(tok.colStart, tok.colEnd) : "";
    const fn = tab ? { entry: tab.entry, name: fnNames().get(tab.entry) ?? "" } : null;
    const reference = xrefTargetOf(tok, text, fn);
    const textOf = (x: typeof tok & {}) => (d?.text.split("\n")[x.line] ?? "").slice(x.colStart, x.colEnd);
    return { equate: !!equateTarget(tok), noReturn: !!noReturnTarget(tok, text, fn), split: !!splitTarget(tok), field: !!(d && fieldTarget(d.tokens, tok, textOf)),
      rename: !!renameTarget(tok, text, fn), retype: !!retypeTarget(tok), signature: isOwnName(tok, text, fn), xrefs: !!reference && (reference.type !== "variable" || caps.has("variableReferences")) };
  };
  return { edit, showXrefs, canAt };
}
export type Editing = ReturnType<typeof useEditing>;

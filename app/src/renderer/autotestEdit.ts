import type { FunctionInfo } from "../../../protocol";
import { rpc } from "./client";
import { byLabel, press, sleep, typeInto, waitFor, type AutotestCtx } from "./autotest";

// Edit flow of the real-sidecar autotest. Everything goes through the UI: key events on the listing / Monaco's input,
// dialogs found by role + label, real application-menu items for Redo and Save.
const RETYPE: Record<string, string> = { int: "uint", uint: "int", long: "ulong", ulong: "long", undefined4: "uint", undefined8: "ulong" };
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordPos = (text: string, w: string) => { // first whole-word hit -> Monaco 1-based line/col of its middle
  const re = new RegExp(`\\b${escRe(w)}\\b`);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) { const m = re.exec(lines[i]); if (m) return { line: i + 1, col: m.index + 2 }; }
  throw new Error("word not in decompiler text: " + w);
};

export async function runEditFlow(fl: FunctionInfo[], c: AutotestCtx, result: Record<string, any>): Promise<{ ok: boolean; persist?: unknown }> {
  const R: Record<string, any> = (result.edit = {});
  const lb = () => document.querySelector<HTMLElement>(".lbox")!;
  const fnRow = (e: string) => document.getElementById("fn-" + e)?.textContent ?? "";
  const hasLabel = (n: string) => [...document.querySelectorAll(".lrow.lbl .l")].some((x) => x.textContent === n + ":");
  const monacoKey = (key: string, init: KeyboardEventInit = {}) => {
    const ta = document.querySelector<HTMLElement>(".monaco-editor textarea")!;
    c.editor().focus(); ta.focus();
    const code = "Key" + key.toUpperCase(), keyCode = key.toUpperCase().charCodeAt(0);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, ...init } as KeyboardEventInit));
  };
  const dialog = (title: string) => waitFor(() => byLabel("dialog", title), 5000, `dialog "${title}"`);
  const closed = (title: string) => waitFor(() => !byLabel("dialog", title), 8000, `dialog "${title}" to close`);
  const fill = async (label: string, text: string, submit = true) => {
    const el = await waitFor(() => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`), 5000, "input " + label);
    typeInto(el, text); if (submit) press(el, "Enter"); return el;
  };

  // 1. pick a function with a local declared with a retypeable type
  let pick: { f: FunctionInfo; v: string; type: string } | null = null, sawVar = false;
  for (const f of fl.slice(0, 80) as FunctionInfo[]) {
    const r = await rpc.call("decompile", { entry: f.entry });
    const lines = r.text.split("\n");
    for (const t of r.tokens) {
      if (t.kind !== "variable" || !t.varName) continue;
      sawVar = true;
      const m = new RegExp(`^\\s*([A-Za-z_][\\w ]*?)\\s+\\**${escRe(t.varName)}\\s*[;\\[=]`).exec(lines[t.line] ?? "");
      // 4-byte ints retype cleanly; 8-byte merged locals can split into several decompiler variables (Ghidra behaviour, not the app's)
      if (m && (m[1].trim() === "int" || m[1].trim() === "uint")) { pick = { f, v: t.varName, type: m[1].trim() }; break; }
    }
    if (pick) break;
  }
  if (!sawVar) { R.skipped = "decompiler has no variable tokens (mock sidecar)"; return { ok: true }; }
  if (!pick) throw new Error("no function with a retypeable local found");
  const { f, v: origVar, type: origType } = pick, newFn = "autotest_fn", newVar = "autotest_var", newType = RETYPE[origType];
  Object.assign(R, { function: f.name, variable: origVar, type: origType + "->" + newType });
  const declRe = (type: string, v: string) => new RegExp(`^\\s*${type}\\s+\\**${escRe(v)}\\s*[;\\[=]`, "m");
  await c.select(f.entry);
  await waitFor(() => c.editorText().includes(origVar), 15000, "decompiler text of " + f.name);
  const origText = c.editorText(), origCount = c.funcCount();

  // 2. L in the listing: rename the function; function list, listing label and decompiler all follow
  lb().focus(); press(lb(), "l");
  await dialog("Rename"); await fill("New name", newFn); await closed("Rename");
  await waitFor(() => fnRow(f.entry).includes(newFn), 8000, "function list to show " + newFn);
  await waitFor(() => hasLabel(newFn), 8000, "listing label " + newFn);
  await waitFor(() => c.editorText().includes(newFn + "("), 8000, "decompiler to show " + newFn);
  R.renameFunction = true; R.focusBack = document.activeElement === lb();

  // 3. L in the decompiler: rename the local; the cursor stays on its line
  let p = wordPos(c.editorText(), origVar);
  c.editor().setPosition({ lineNumber: p.line, column: p.col }); monacoKey("l");
  await dialog("Rename variable"); await fill("New name", newVar); await closed("Rename variable");
  await waitFor(() => c.editorText().includes(newVar) && !new RegExp(`\\b${escRe(origVar)}\\b`).test(c.editorText()), 8000, "variable rename in decompiler");
  R.renameVariable = true; R.cursorLineKept = c.editor().getPosition().lineNumber === p.line;

  // 4. Ctrl+L: retype it, with autocomplete from list_data_types
  p = wordPos(c.editorText(), newVar);
  c.editor().setPosition({ lineNumber: p.line, column: p.col }); monacoKey("l", { metaKey: true });
  await dialog("Retype variable");
  const box = await fill("Data type", newType, false);
  const opts = await waitFor(() => { const o = [...document.querySelectorAll<HTMLElement>('#dt-list [role="option"]')]; return o.length ? o : null; }, 5000, "data type suggestions");
  R.autocompleteHits = opts.length;
  const idx = opts.findIndex((o) => o.textContent!.startsWith(newType + " "));
  if (idx >= 0) { for (let i = 0; i <= idx; i++) press(box, "ArrowDown"); press(box, "Enter"); await sleep(100); }
  press(box, "Enter"); await closed("Retype variable");
  await waitFor(() => declRe(newType, newVar).test(c.editorText()), 8000, `declaration "${newType} ${newVar}"`);
  R.retype = true;

  // 5. ; in the listing: EOL comment shows in the listing row
  lb().focus(); press(lb(), ";");
  await dialog("Set comment"); await fill("Comment", "autotest note"); await closed("Set comment");
  await waitFor(() => [...document.querySelectorAll(".lrow .c")].some((x) => x.textContent === "; autotest note"), 8000, "comment in the listing");
  R.comment = true;

  // 6. F: create a function in a gap between functions (try a few; F reports failures as errors)
  const sorted = [...fl].sort((a, b) => (BigInt(a.entry) < BigInt(b.entry) ? -1 : 1));
  let created = false;
  for (let i = 0; i + 1 < sorted.length && !created && i < 400; i++) {
    const a = BigInt(sorted[i].entry) + BigInt(Math.max(sorted[i].size, 1));
    if (a >= BigInt(sorted[i + 1].entry)) continue;
    const e0 = c.errors.length;
    await c.select("0x" + a.toString(16)); await sleep(400);
    lb().focus(); press(lb(), "f");
    for (let t = 0; t < 40 && !created && c.errors.length === e0; t++) { await sleep(100); created = c.funcCount() > origCount; }
    if (!created) c.errors.length = e0; // not a valid function start: try the next gap
  }
  if (!created) throw new Error("could not create a function in any gap");
  R.createFunction = true;
  await c.select(f.entry); await waitFor(() => c.editorText().includes(newVar), 8000, "back on the edited function");
  lb().focus();

  // 7. Cmd+Z inside a text input stays the input's own undo (program untouched)
  const before = await rpc.call("undo_state", {});
  press(lb(), "l"); await dialog("Rename");
  const inp = document.querySelector<HTMLInputElement>('[aria-label="New name"]')!; typeInto(inp, "zzz");
  press(inp, "z", { metaKey: true }); await sleep(500);
  const after = await rpc.call("undo_state", {});
  press(inp, "Escape"); await closed("Rename");
  R.textUndoLeavesProgram = before.undoName === after.undoName && before.canRedo === after.canRedo && !after.canRedo;
  R.escapeRestoresFocus = document.activeElement === lb();

  // 8. Cmd+Z x5 on the listing, checking each step
  const undo = async () => { lb().focus(); press(lb(), "z", { metaKey: true }); };
  const wait = (f2: () => boolean, what: string) => waitFor(f2, 10000, what);
  await undo(); await wait(() => c.funcCount() === origCount, "undo create function");
  await undo(); await wait(() => ![...document.querySelectorAll(".lrow .c")].some((x) => x.textContent === "; autotest note"), "undo comment");
  await undo(); await wait(() => declRe(origType, newVar).test(c.editorText()), "undo retype");
  await undo(); await wait(() => c.editorText().includes(origVar) && !c.editorText().includes(newVar), "undo variable rename");
  await undo(); await wait(() => fnRow(f.entry).includes(f.name) && !fnRow(f.entry).includes(newFn) && c.editorText() === origText, "undo function rename (original names and text back)");
  R.undoAll = true;
  const st = await rpc.call("undo_state", {});
  R.afterUndo = st; if (!st.canRedo) throw new Error("redo not available after undo");

  // 9. Redo one through the real Edit menu item
  await c.menu("redo");
  await wait(() => fnRow(f.entry).includes(newFn) && c.editorText().includes(newFn + "("), "redo function rename");
  R.redo = true;

  // 10. Save through the real File > Save item; dirty marker clears
  const dirtyShown = () => /unsaved changes/.test(document.body.textContent ?? "");
  await wait(dirtyShown, "dirty marker after edits");
  R.titleDirty = document.title.startsWith("●");
  await c.menu("save");
  await wait(() => !dirtyShown(), "dirty marker to clear after save");
  R.dirtyCleared = !(await rpc.call("undo_state", {})).dirty && !document.title.startsWith("●");
  if (!R.dirtyCleared) throw new Error("dirty not cleared");
  const ok = R.renameFunction && R.renameVariable && R.retype && R.comment && R.createFunction && R.textUndoLeavesProgram && R.escapeRestoresFocus && R.focusBack && R.cursorLineKept && R.undoAll && R.redo && R.dirtyCleared;
  return { ok: !!ok, persist: { entry: f.entry, newName: newFn, origName: f.name, origVar, newVar, newType } };
}

/** Second launch on the same projects dir: the redone (and saved) rename must be there, the undone edits must not. */
export async function runPhase2(file: string, c: AutotestCtx, result: Record<string, any>) {
  const x = c.expect as { entry: string; newName: string; origVar: string; newVar: string };
  c.setPath(file);
  const fl = await c.open(file);
  if (!fl?.length) throw new Error("no functions after relaunch");
  const f = await rpc.call("get_function_at", { address: x.entry });
  const d = await rpc.call("decompile", { entry: x.entry });
  const rows = await rpc.call("listing_rows", { address: x.entry, count: 1 });
  const undo = await rpc.call("undo_state", {});
  result.phase2 = { name: f?.name, hasOrigVar: d.text.includes(x.origVar), hasNewVar: d.text.includes(x.newVar), comment: rows[0]?.comment ?? null, dirty: undo.dirty };
  result.ok = f?.name === x.newName && d.text.includes(x.origVar) && !d.text.includes(x.newVar) && !rows[0]?.comment && !undo.dirty;
}

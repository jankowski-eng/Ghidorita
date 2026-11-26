import type { FunctionInfo } from "../../../../protocol";
import { byLabel, isMock, press, sleep, typeInto, waitFor, type AutotestCtx } from "./autotest";

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
  fl = await c.program().functions.list(); // earlier steps of the autotest renamed functions: use current names
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
    const r = await c.program().decompiler.decompile({ entry: f.entry }).result;
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
  if (!sawVar || isMock(fl)) { R.skipped = "decompiler has no real variables (mock sidecar)"; return { ok: true }; }
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
  const before = await c.program().history.state();
  press(lb(), "l"); await dialog("Rename");
  const inp = document.querySelector<HTMLInputElement>('[aria-label="New name"]')!; typeInto(inp, "zzz");
  press(inp, "z", { metaKey: true }); await sleep(500);
  const after = await c.program().history.state();
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
  const st = await c.program().history.state();
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
  R.dirtyCleared = !(await c.program().history.state()).dirty && !document.title.startsWith("●");
  if (!R.dirtyCleared) throw new Error("dirty not cleared");

  // 11. E on a number in the decompiler: the equate replaces it in the C and survives a save and a restart (phase 2 checks it)
  const EQ = "AUTOTEST_EQ";
  let eq: { entry: string } | null = null;
  for (const g of fl.filter((x) => x.entry !== f.entry).reverse().slice(0, 120)) { // from the end of the list: the types flow edits the early functions, and a retyped parameter can swallow the number
    const r = await c.program().decompiler.decompile({ entry: g.entry }).result;
    const consts = r.tokens.filter((t) => t.kind === "const" && t.constValue && t.address && t.line > 1).slice(0, 4);
    if (!consts.length) continue;
    await c.select(g.entry); await waitFor(() => c.editorText() === r.text, 15000, "decompiler text of " + g.name);
    for (const t of consts) {
      c.editor().setPosition({ lineNumber: t.line + 1, column: t.colStart + 2 }); monacoKey("e");
      await dialog("Set equate"); const box = await fill("Equate name or enum member", EQ);
      const out = await waitFor(() => (!byLabel("dialog", "Set equate") ? "closed" : document.querySelector('[role="alert"]')?.textContent || null), 8000, "Set equate to finish");
      if (out === "closed") {
        const shown = await waitFor(() => c.editorText().includes(EQ), 4000, "equate in the decompiler").then(() => true, () => false);
        if (shown) { eq = { entry: g.entry }; break; }
        await c.menu("undo"); await waitFor(() => c.editorText() === r.text, 8000, "undo of an equate the C does not show"); // an operand the C does not print as this number
        continue;
      }
      press(box, "Escape"); await closed("Set equate"); // this constant is not one operand's scalar: the next one
    }
    if (eq) break;
  }
  if (!eq) throw new Error("could not set an equate on any constant");
  R.equate = true;
  await c.menu("save");
  await waitFor(() => !dirtyShown(), 10000, "dirty marker to clear after saving the equate");
  const ok = R.equate && R.renameFunction && R.renameVariable && R.retype && R.comment && R.createFunction && R.textUndoLeavesProgram && R.escapeRestoresFocus && R.focusBack && R.cursorLineKept && R.undoAll && R.redo && R.dirtyCleared;
  return { ok: !!ok, persist: { equate: { entry: eq.entry, name: EQ }, entry: f.entry, newName: newFn, origName: f.name, origVar, newVar, newType } };
}

/** Second launch on the same projects dir: the redone (and saved) rename must be there, the undone edits must not. */
export async function runPhase2(file: string, c: AutotestCtx, result: Record<string, any>) {
  const x = c.expect as { equate?: { entry: string; name: string }; entry: string; newName: string; origVar: string; newVar: string; bookmark?: { address: string; comment: string }; types?: { name: string; fields: string[]; size: number; addr: string; entry: string; from: string; fromAddr: string; data?: { arr: string; ptr: string; rep: string }; auto?: string } };
  const fl = await c.open(file);
  if (!fl?.length) throw new Error("no functions after relaunch");
  const f = await c.program().functions.containing({ address: x.entry });
  const d = await c.program().decompiler.decompile({ entry: x.entry }).result;
  const rows = await c.program().listing.rows({ address: x.entry, count: 1 });
  const undo = await c.program().history.state();
  result.phase2 = { name: f?.name, hasOrigVar: d.text.includes(x.origVar), hasNewVar: d.text.includes(x.newVar), comment: rows[0]?.comment ?? null, dirty: undo.dirty };
  let typesOk = true;
  if (x.types) { // the struct, its data, the decompiler's use of it and the struct made from data survived save + reopen
    const t = x.types, st = await c.program().types.getDataType({ path: "/" + t.name }), fd = await c.program().types.getDataType({ path: "/" + t.from });
    const row = (await c.program().listing.rows({ address: t.addr, count: 1 }))[0], row2 = (await c.program().listing.rows({ address: t.fromAddr, count: 1 }))[0];
    const dec = await c.program().decompiler.decompile({ entry: t.entry }).result;
    result.phase2.types = { size: st.size, fields: st.components!.filter((c) => !c.undefined).map((c) => c.name), row: row.mnemonic, fromRow: row2.mnemonic, fromFields: fd.components!.filter((c) => !c.undefined).length, inDecompiler: dec.text.includes(t.name) };
    typesOk = st.size === t.size && st.components!.filter((c) => !c.undefined).slice(0, 2).map((c) => c.name).join() === t.fields.join() && row.mnemonic === t.name
      && row2.mnemonic === t.from && fd.components!.filter((c) => !c.undefined).length === 2 && dec.text.includes(t.name);
    if (t.data) { // the array and pointers defined with [, P and Y survived too
      const at = async (a: string) => (await c.program().listing.rows({ address: a, count: 1 }))[0]?.dataType;
      result.phase2.types.data = [await at(t.data.arr), await at(t.data.ptr), await at(t.data.rep)];
      typesOk = typesOk && result.phase2.types.data.join() === "byte[8],pointer,pointer";
    }
    if (t.auto) { // the auto-created struct and the variable's new type survived too
      const as = await c.program().types.getDataType({ path: "/auto_structs/AutotestAuto" }), ad = await c.program().decompiler.decompile({ entry: t.auto }).result;
      result.phase2.types.auto = { size: as.size, inDecompiler: ad.text.includes("AutotestAuto") };
      typesOk = typesOk && as.size > 0 && ad.text.includes("AutotestAuto");
    }
  }
  if (x.bookmark) { // the bookmark from the quick-wins flow survived save + quit + relaunch
    const b = await c.program().bookmarks.list({ type: "Note" }).result;
    result.phase2.bookmark = b.items.find((i) => i.address === x.bookmark!.address) ?? null;
    typesOk = typesOk && result.phase2.bookmark?.comment === x.bookmark.comment;
  }
  if (x.equate) { // the equate set with E survived save + quit + relaunch
    result.phase2.equate = (await c.program().decompiler.decompile({ entry: x.equate.entry }).result).text.includes(x.equate.name);
    typesOk = typesOk && result.phase2.equate;
  }
  result.ok = f?.name === x.newName && d.text.includes(x.origVar) && !d.text.includes(x.newVar) && !rows[0]?.comment && !undo.dirty && typesOk;
}

type EditPersist = { entry: string } | undefined;

/**
 * Data type manager flow, all through the UI: create a struct, add fields (dialog + inline cells), resize and fill undefined bytes,
 * apply it to data, show it in the listing and the decompiler (function signature), undo every step, redo every step, create a
 * struct from listing data, save. `edit` is the edit flow's persist record (real sidecar) or undefined (mock).
 */
export async function runTypesFlow(c: AutotestCtx, result: Record<string, any>, edit: EditPersist): Promise<{ ok: boolean; persist?: Record<string, unknown> }> {
  const R: Record<string, any> = (result.types = {});
  const lb = () => document.querySelector<HTMLElement>(".lbox")!;
  const btn = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const input = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  const until = async (f: () => Promise<boolean> | boolean, what: string, ms = 10000) => {
    const t0 = Date.now();
    for (;;) { if (await f()) return; if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + what); await sleep(60); }
  };
  const dialog = (title: string) => waitFor(() => byLabel("dialog", title), 5000, `dialog "${title}"`);
  const closed = (title: string) => waitFor(() => !byLabel("dialog", title), 8000, `dialog "${title}" to close`);
  const click = async (label: string) => { (await waitFor(() => { const b = btn(label); return b && !b.disabled ? b : null; }, 5000, "button " + label)).click(); };
  const fillAll = async (title: string, vals: Record<string, string>) => {
    await dialog(title);
    let last: HTMLInputElement | null = null;
    for (const [label, v] of Object.entries(vals)) { last = await waitFor(() => input(label), 5000, "input " + label); typeInto(last, v); }
    press(last!, "Enter"); await closed(title);
  };
  // program_changed refreshes the listing at its old top row ~100 ms after an edit; navigate only after that has settled
  const goTo = async (addr: string) => { await sleep(800); await c.select(addr as any); };
  const get = (path: string) => c.program().types.getDataType({ path });
  const rowsText = () => [...document.querySelectorAll(".lrow")].map((x) => x.textContent ?? "");
  const listingHas = (text: string) => rowsText().some((x) => x.includes(text));
  // wait for the listing to (not) show `text` at `addr`; a late program_changed refresh can scroll it back, so navigate again on a miss
  const listingShows = async (addr: string, text: string, what: string, want = true) => {
    for (let n = 0; ; n++) {
      await goTo(addr);
      try { await waitFor(() => listingHas(text) === want, 4000, what); return; }
      catch (e) { if (n >= 3) throw new Error(`${(e as Error).message}; visible rows: ${rowsText().slice(0, 8).join(" | ")}`); }
    }
  };
  const base = await c.program().history.state();
  const strings = (await c.program().searches.listStrings({ limit: 2, minLength: 1 }).result).items;
  const a = strings[0].address, b = strings[1].address;
  const fl = await c.program().functions.list();
  const entry = (fl.find((f) => f.entry !== edit?.entry && f.size > 16) ?? fl[0]).entry; // not the function the edit flow checks in phase 2
  const NAME = "AutotestStruct";
  let steps = 0; // undo steps this flow adds (one per transaction)

  // 1. open the manager (View > Data Type Manager), create a struct through the dialog
  c.command({ type: "datatypes" });
  await waitFor(() => byLabel("region", "Data Type Manager"), 5000, "data type manager");
  await click("New struct");
  await fillAll("New struct", { Name: NAME }); steps++;
  await waitFor(() => [...document.querySelectorAll('[role="treeitem"]')].some((x) => x.textContent?.includes(NAME)), 8000, "struct in the tree");
  await waitFor(() => document.body.textContent?.includes("struct " + NAME), 8000, "editor header");
  R.created = true;

  // 2. add two fields in the dialog, rename one inline
  await click("Add field");
  await fillAll("Add field", { "Field type": "dword", "Field name": "f_a" }); steps++;
  await waitFor(() => input("Name 0"), 8000, "first field row");
  await click("Add field");
  await fillAll("Add field", { "Field type": "char[8]", "Field name": "f_name", "Field comment": "autotest field" }); steps++;
  await waitFor(() => input("Name 1"), 8000, "second field row");
  typeInto(input("Name 0")!, "f_first"); press(input("Name 0")!, "Enter"); steps++;
  await until(async () => (await get("/" + NAME)).components?.[0].name === "f_first", "inline rename");
  const d = await get("/" + NAME);
  R.fields = d.components!.map((x) => `${x.offset}:${x.type}:${x.name}`);
  if (d.size !== 12 || d.components!.length !== 2 || d.components![1].comment !== "autotest field") throw new Error("unexpected struct " + JSON.stringify(R.fields));

  // 3. resize (undefined filler) and fill the filler with a type through its inline type cell
  typeInto(input("Size")!, "16"); press(input("Size")!, "Enter"); steps++;
  await waitFor(() => input("Type 2"), 8000, "undefined filler rows");
  R.filler = (await get("/" + NAME)).components!.filter((x) => x.undefined).length;
  typeInto(input("Type 2")!, "dword"); press(input("Type 2")!, "Enter"); steps++;
  await until(async () => { const x = await get("/" + NAME); return x.size === 16 && x.components!.length === 3 && x.components![2].type === "dword"; }, "filler replaced by a dword");
  R.fillerFilled = true;

  // 4. apply it at a string's address from the editor, close the manager, find it in the listing
  await click("Apply at address");
  await fillAll("Apply data type", { Address: a, "Data type": "/" + NAME }); steps++;
  await click("Close data types");
  await waitFor(() => !byLabel("region", "Data Type Manager"), 3000, "manager to close");
  await listingShows(a, NAME, "struct in the listing");
  R.listing = true;

  // 5. the decompiler shows the type: set a parameter of the function to NAME * through Edit Function Signature
  await goTo(entry);
  await waitFor(() => c.editorText().length > 0, 15000, "decompiler text");
  c.editor().focus(); document.querySelector<HTMLElement>(".monaco-editor textarea")!.focus();
  c.command({ type: "edit", action: "signature" });
  const sig = (await c.program().functions.containing({ address: entry }))!.signature;
  const box = await waitFor(() => input("Signature"), 5000, "signature input");
  typeInto(box, sig.replace(/\(.*\)\s*;?$/, `(${NAME} *autotest_param)`)); press(box, "Enter"); await closed("Edit function signature"); steps++;
  await waitFor(() => c.editorText().includes(NAME), 15000, "decompiler to show " + NAME);
  R.decompiler = true;

  // 6. undo every step (Cmd+Z on the listing), looking at the visible effect of the first two
  const undo = async () => { lb().focus(); press(lb(), "z", { metaKey: true }); };
  // labels repeat ("Edit S: add" twice), so a step is noticed by the undo state *and* the struct's content changing
  const depth = async () => JSON.stringify([await c.program().history.state(), (await get("/" + NAME).catch(() => null))?.components?.map((x) => [x.type, x.name, x.comment])]);
  await undo(); await waitFor(() => !c.editorText().includes(NAME), 15000, "undo signature");
  await undo(); await listingShows(a, NAME, "undo apply", false);
  for (let i = 2; i < steps; i++) { const n = await depth(); await undo(); await until(async () => (await depth()) !== n, "undo step " + (i + 1)); }
  await until(async () => (await c.program().types.getDataType({ path: "/" + NAME }).then(() => false, () => true)), "struct gone after undoing everything");
  const st = await c.program().history.state();
  R.undoAll = st.undoName === base.undoName && st.canRedo;
  if (!R.undoAll) throw new Error(`undo stack not back at baseline: ${JSON.stringify([st, base])}`);

  // 7. redo every step through the real Edit menu
  for (let i = 0; i < steps; i++) { const n = await depth(); await c.menu("redo"); await until(async () => (await depth()) !== n, "redo step " + (i + 1)); }
  const d2 = await get("/" + NAME);
  if (d2.size !== 16 || d2.components!.length !== 3 || d2.components![0].name !== "f_first") throw new Error("redo did not restore the struct: " + JSON.stringify(d2.components));
  await listingShows(a, NAME, "redo apply");
  await goTo(entry); await waitFor(() => c.editorText().includes(NAME), 15000, "redo signature in the decompiler");
  R.redoAll = true;

  // 8. create a struct from listing data: int + short, selected by cursor + length, applied; one undo removes both
  await c.program().edits.defineData({ address: b, dataType: "int" });
  await c.program().edits.defineData({ address: "0x" + (BigInt(b) + 4n).toString(16), dataType: "short" });
  await goTo(b); await sleep(300);
  lb().focus(); c.command({ type: "edit", action: "createStruct" });
  await fillAll("Create structure", { "Structure name": "AutotestFromData", "Length (bytes)": "6" });
  await until(async () => !!(await c.program().types.getDataType({ path: "/AutotestFromData" }).catch(() => null)), "struct from data");
  const f2 = await get("/AutotestFromData");
  R.fromData = f2.components!.filter((x) => !x.undefined).map((x) => `${x.offset}:${x.type}`);
  if (f2.size !== 6 || R.fromData.join() !== "0:int,4:short") throw new Error("unexpected struct from data " + JSON.stringify(R.fromData));
  await listingShows(b, "AutotestFromData", "struct from data in the listing");
  await undo(); await until(async () => !(await c.program().types.getDataType({ path: "/AutotestFromData" }).then(() => true, () => false)), "undo struct from data");
  await listingShows(b, "AutotestFromData", "listing without the struct from data", false);
  await c.menu("redo"); await until(async () => !!(await c.program().types.getDataType({ path: "/AutotestFromData" }).catch(() => null)), "redo struct from data");
  R.fromDataUndoRedo = true;

  // 8b. Auto Create Structure on a decompiler variable (real sidecar only: the mock's variables are not Ghidra's).
  // Find a variable with inferable field accesses by trying the RPC (then undo it), then do it through the UI: cursor on the variable + Edit menu.
  let auto: { entry: string; v: string } | undefined;
  const hasVars = (await c.program().decompiler.decompile({ entry }).result).tokens.some((t) => t.kind === "variable" || t.kind === "param");
  for (const f of (hasVars && !isMock(fl) ? [...fl] : []).sort((x, y) => y.size - x.size).slice(0, 60)) {
    if (f.entry === entry || f.entry === edit?.entry) continue;
    const r = await c.program().decompiler.decompile({ entry: f.entry }).result.catch(() => null); // (huge functions may time out)
    if (!r) continue;
    const vars = [...new Set(r.tokens.filter((t) => (t.kind === "variable" || t.kind === "param") && t.varName).map((t) => t.varName!))];
    for (const v of vars) {
      const ok = await c.program().edits.autoCreateStructure({ entry: f.entry, name: v, structName: "AutotestProbe" }).then(() => true, () => false);
      if (ok) { await c.program().history.undo(); auto = { entry: f.entry, v }; break; }
    }
    if (auto) break;
  }
  if (!auto) R.autoStruct = "skipped (no variable tokens or no inferable variable)";
  else {
    await goTo(auto.entry);
    await waitFor(() => new RegExp(`\\b${escRe(auto!.v)}\\b`).test(c.editorText()), 15000, "decompiler text of the auto struct function");
    const p = wordPos(c.editorText(), auto.v);
    c.editor().setPosition({ lineNumber: p.line, column: p.col }); c.editor().focus(); document.querySelector<HTMLElement>(".monaco-editor textarea")!.focus();
    c.command({ type: "edit", action: "autoStruct" });
    await fillAll("Auto create structure", { "Structure name (empty = automatic)": "AutotestAuto" });
    await waitFor(() => c.editorText().includes("AutotestAuto"), 15000, "decompiler to show AutotestAuto");
    const ds = await get("/auto_structs/AutotestAuto").catch(async (e) => { throw new Error(`${e.message}; auto_structs: ${JSON.stringify(await c.program().types.dtChildren({ path: "/auto_structs" }).catch(() => null))}; editor: ${c.editorText().split("\n").filter((l) => l.includes("AutotestAuto")).join(" / ")}`); });
    R.autoStruct = { variable: auto.v, size: ds.size, fields: ds.components!.filter((x) => !x.undefined).length };
    if (!ds.size || !R.autoStruct.fields) throw new Error("auto struct has no fields");
    await undo(); await waitFor(() => !c.editorText().includes("AutotestAuto"), 15000, "undo auto struct");
    await c.menu("redo"); await waitFor(() => c.editorText().includes("AutotestAuto"), 15000, "redo auto struct");
  }

  // 8c. Ghidra's data keys on the listing: [ (array, count asked in a dialog), P (pointer), Y (repeat the last type); one undoable edit each
  let dataAt: { arr: string; ptr: string; rep: string } | undefined;
  if (isMock(fl)) R.dataKeys = true; // no dataType on the mock listing rows
  else {
    const hex = (n: bigint) => "0x" + n.toString(16);
    const dx = BigInt(a) > BigInt(b) ? BigInt(a) : BigInt(b);
    const arrAt = hex(dx + 64n), ptrAt = hex(dx + 72n), repAt = hex(dx + 80n);
    await c.program().edits.clearCode({ address: arrAt, length: 32 }); // undefined bytes to work on
    const typeAt = async (at: string) => (await c.program().listing.rows({ address: at, count: 1 }))[0]?.dataType;
    const keyOn = async (at: string, key: string) => {
      await goTo(at);
      const row = await waitFor(() => [...document.querySelectorAll<HTMLElement>(".lrow")].find((r) => r.querySelector(".a")?.textContent === at), 5000, "listing row " + at);
      row.click(); lb().focus(); press(lb(), key);
    };
    await keyOn(arrAt, "[");
    await fillAll("Define byte[]", { "Number of elements": "8" });
    await until(async () => (await typeAt(arrAt)) === "byte[8]", "array defined by [");
    R.array = await typeAt(arrAt);
    await keyOn(ptrAt, "p");
    await until(async () => (await typeAt(ptrAt)) === "pointer", "pointer defined by P");
    R.pointer = await typeAt(ptrAt);
    await keyOn(repAt, "y"); // repeats the last type applied with T or P: the pointer
    await until(async () => (await typeAt(repAt)) === "pointer", "Y repeats the pointer");
    R.repeat = await typeAt(repAt);
    await undo(); await until(async () => (await typeAt(repAt)) === "undefined", "one undo removes the Y edit");
    await c.menu("redo"); await until(async () => (await typeAt(repAt)) === "pointer", "redo the Y edit");
    R.dataKeys = (await typeAt(arrAt)) === "byte[8]" && (await typeAt(ptrAt)) === "pointer";
    dataAt = { arr: arrAt, ptr: ptrAt, rep: repAt };
  }

  // 9. save through File > Save; the dirty marker clears
  await c.menu("save");
  await until(async () => !(await c.program().history.state()).dirty, "save");
  const ok = R.created && R.fillerFilled && R.listing && R.decompiler && R.undoAll && R.redoAll && R.fromDataUndoRedo && R.dataKeys;
  return { ok: !!ok, persist: { name: NAME, fields: ["f_first", "f_name"], size: 16, addr: a, entry, from: "AutotestFromData", fromAddr: b, ...(dataAt ? { data: dataAt } : {}), ...(auto ? { auto: auto.entry } : {}) } };
}

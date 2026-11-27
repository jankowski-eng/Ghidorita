import type { FunctionInfo } from "../../../../protocol";
import { copied } from "../clipboard";
import { byLabel, isMock, press, setSelect, typeInto, waitFor, sleep, type AutotestCtx } from "./autotest";

// Round 11 flow: one step per quick win (copy actions, then callers/callees, then bookmarks). Mock and real sidecar.
const need = (ok: unknown, what: string) => { if (!ok) throw new Error("quick: " + what); };
const mainRow = (nth = 0) => document.querySelectorAll<HTMLElement>(".lbox .lrow.k-main")[nth];
const rowAddr = (el: HTMLElement) => el.querySelector(".a")!.textContent!.replace(/[▸▾▪]/g, "").trim();

async function copyStep(fl: FunctionInfo[], c: AutotestCtx, R: Record<string, any>) {
  const caps = c.backend.capabilities;
  need(caps.has("bytes"), "provider has no bytes capability");
  await c.goAddr(fl[0].entry);
  await waitFor(() => c.topAddr() === fl[0].entry && mainRow(), 10000, "listing at the first function");
  const row = mainRow(2) ?? mainRow(), addr = rowAddr(row);
  row.click(); document.querySelector<HTMLElement>(".lbox")!.focus(); await sleep(100);
  copied.last = "";
  c.command({ type: "copy", what: "address" });
  await waitFor(() => copied.last, 5000, "address copied from the listing");
  need(copied.last === addr, `listing address ${copied.last} != ${addr}`);
  const shown = row.querySelector(".b")!.textContent!.replace(/\s*…\+\d+$/, "");
  copied.last = ""; c.command({ type: "copy", what: "bytes" });
  await waitFor(() => copied.last, 5000, "bytes copied");
  need(copied.last === shown, `hex ${copied.last} != ${shown}`);
  const hex = copied.last;
  copied.last = ""; c.command({ type: "copy", what: "carray" });
  await waitFor(() => copied.last, 5000, "C array copied");
  need(copied.last.startsWith("unsigned char bytes[] = {") && copied.last.match(/0x[0-9a-f]{2}/g)!.length === hex.split(" ").length, "C array " + copied.last);
  // the wire path of get_bytes (row.bytes already holds a short unit, so the UI only calls it for long ones)
  const g = await c.program().listing.bytes({ address: addr, length: hex.split(" ").length });
  need(g.bytes === hex, `get_bytes ${g.bytes} != ${hex}`);
  // right-click menu on a listing row
  copied.last = "";
  mainRow(1).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
  const item = await waitFor(() => [...document.querySelectorAll<HTMLElement>(".ctxmenu [role=menuitem]")].find((e) => e.textContent === "Copy Address"), 5000, "listing context menu");
  need([...document.querySelectorAll(".ctxmenu [role=menuitem]")].map((e) => e.textContent).includes("Copy Bytes (C Array)"), "menu lists the byte copies");
  const second = rowAddr(mainRow(1)); item.click();
  await waitFor(() => copied.last, 5000, "address copied from the context menu");
  need(copied.last === second, `context menu copied ${copied.last} != ${second}`);
  // decompiler: the whole text, and the address at the cursor
  if (caps.has("decompile")) {
    await c.select(fl[0].entry);
    await waitFor(() => c.editorText().length > 0, 20000, "decompiled text");
    const ed = c.editor(), d = await c.program().decompiler.decompile({ entry: fl[0].entry }).result;
    const tok = d.tokens.find((t) => t.address && !t.targetFunction && !t.varAddress && t.kind !== "default") ?? d.tokens.find((t) => t.address);
    need(tok, "no token with an address");
    ed.setPosition({ lineNumber: tok!.line + 1, column: tok!.colStart + 2 }); ed.focus(); document.querySelector<HTMLElement>(".monaco-editor textarea")!.focus(); await sleep(150);
    copied.last = ""; c.command({ type: "copy", what: "decompiled" });
    await waitFor(() => copied.last, 5000, "decompiled copied");
    need(copied.last === c.editorText(), "decompiled text differs from the editor");
    copied.last = ""; c.command({ type: "copy", what: "address" });
    await waitFor(() => copied.last, 5000, "decompiler address copied");
    need(copied.last === tok!.address, `decompiler address ${copied.last} != ${tok!.address}`);
  }
  // function list: the selected function's entry (and its own context menu)
  const fnRow = [...document.querySelectorAll<HTMLElement>('.funcs [role="option"]')][0];
  need(fnRow, "no function row");
  copied.last = "";
  fnRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 40 }));
  (await waitFor(() => [...document.querySelectorAll<HTMLElement>(".ctxmenu [role=menuitem]")].find((e) => e.textContent === "Copy Address"), 5000, "function list context menu")).click();
  await waitFor(() => copied.last, 5000, "function address copied");
  need(fnRow.id === "fn-" + copied.last, `function list copied ${copied.last} for ${fnRow.id}`);
  R.copy = { address: addr, bytes: hex, ok: true };
}

async function hexStep(fl: FunctionInfo[], c: AutotestCtx, R: Record<string, any>) {
  need(c.backend.capabilities.has("bytes"), "provider has no bytes capability");
  await c.goAddr(fl[0].entry);
  await waitFor(() => c.topAddr() === fl[0].entry && mainRow(2), 10000, "listing at the first function");
  const row = mainRow(2), addr = rowAddr(row);
  row.click(); document.querySelector<HTMLElement>(".lbox")!.focus(); await sleep(100);
  c.command({ type: "dock", panel: "hex" });
  const region = await waitFor(() => byLabel<HTMLElement>("region", "Bytes"), 5000, "bytes pane");
  const cur = () => [...region.querySelectorAll<HTMLElement>(".hx-bytes .hx-b.cur")];
  const shown = row.querySelector(".b")!.textContent!.replace(/\s*…\+\d+$/, "");
  await waitFor(() => cur().length > 0 && cur().every((e) => e.textContent !== "··"), 10000, "the cursor's bytes loaded in the pane");
  need(cur().map((e) => e.textContent).join(" ") === shown, `pane bytes ${cur().map((e) => e.textContent).join(" ")} != row bytes ${shown}`);
  const g = await c.program().listing.bytes({ address: addr, length: shown.split(" ").length });
  need(g.bytes === shown, `get_bytes ${g.bytes} != ${shown}`);
  need(region.querySelector(".hx-off")!.textContent!.length > 2 && region.querySelector(".hx-ascii")!.textContent!.length === 16, "offset and ASCII columns");
  // clicking a byte moves the shared cursor (the pane highlights it, the listing follows)
  const other = [...region.querySelectorAll<HTMLElement>(".hx-bytes .hx-b")].find((e) => !e.classList.contains("cur") && e.textContent !== "  " && e.textContent !== "··");
  need(other, "a byte to click");
  const idx = [...other!.parentElement!.children].indexOf(other!), rowEl = other!.closest(".hx-row")!;
  other!.click();
  await waitFor(() => cur().length === 1 || cur().some((e) => e === other || (e.closest(".hx-row") === rowEl && [...e.parentElement!.children].indexOf(e) === idx)), 10000, "clicked byte becomes the cursor");
  R.hex = { address: addr, bytes: shown, ok: true };
}

async function patchStep(fl: FunctionInfo[], c: AutotestCtx, R: Record<string, any>, result: Record<string, any>) {
  need(c.backend.capabilities.has("patch"), "provider has no patch capability");
  await c.goAddr(fl[0].entry);
  await waitFor(() => c.topAddr() === fl[0].entry && mainRow(2), 10000, "listing at the first function");
  const addr = rowAddr(mainRow(2));
  mainRow(2).click(); document.querySelector<HTMLElement>(".lbox")!.focus(); await sleep(100);
  const first = (await c.program().listing.bytes({ address: addr, length: 1 })).bytes;
  const text = first === "90" ? "INT3" : "NOP", bytes = first === "90" ? "cc" : "90";
  c.command({ type: "edit", action: "patch" });
  const dlg = await waitFor(() => byLabel("dialog", "Patch instruction"), 5000, "patch dialog");
  typeInto(dlg.querySelector<HTMLInputElement>('input[aria-label="Instruction"]')!, "frob rax");
  await waitFor(() => /cannot assemble|FROB|frob/i.test(dlg.querySelector('[aria-label="Preview"]')!.textContent ?? ""), 60000, "an error for a bad instruction in the preview");
  need(dlg.querySelector<HTMLButtonElement>('button[aria-label="Patch"]')!.disabled, "Patch is disabled while the preview fails");
  typeInto(dlg.querySelector<HTMLInputElement>('input[aria-label="Instruction"]')!, text);
  const preview = () => dlg.querySelector('[aria-label="Preview"]')!.textContent ?? "";
  await waitFor(() => preview() !== "…" && !/frob/i.test(preview()), 60000, "the preview of " + text);
  need(preview().startsWith(bytes) && !dlg.querySelector<HTMLButtonElement>('button[aria-label="Patch"]')!.disabled, `preview of ${text}: ${preview()}`);
  dlg.querySelector<HTMLButtonElement>('button[aria-label="Patch"]')!.click();
  await waitFor(() => !byLabel("dialog", "Patch instruction"), 10000, "dialog closed");
  need((await c.program().listing.bytes({ address: addr, length: 1 })).bytes === bytes, "the byte is written");
  const patches = await c.program().patch.list();
  const p = patches.find((x) => x.address === addr);
  need(p && p.original === first && p.current.startsWith(bytes), "list_patches has the change with the original: " + JSON.stringify(patches));
  if (!isMock(fl)) need((await c.program().listing.rows({ address: addr, count: 1 }))[0].mnemonic === text, "the listing re-disassembled the range");
  c.command({ type: "dock", panel: "hex" });
  const region = await waitFor(() => byLabel<HTMLElement>("region", "Bytes"), 5000, "bytes pane");
  const chg = await waitFor(() => [...region.querySelectorAll<HTMLElement>(".hx-b.chg")].find((e) => e.title === `patched, was ${first}`), 10000, "the patched byte marked in the hex pane");
  need(chg.textContent === bytes, "the marked byte shows the new value");
  R.patch = { address: addr, original: first, current: bytes };
  result.quickPersist = { ...(result.quickPersist ?? {}), patch: { address: addr, original: first, current: bytes } };
}

async function pcodeStep(fl: FunctionInfo[], c: AutotestCtx, R: Record<string, any>) {
  need(c.backend.capabilities.has("pcode"), "provider has no pcode capability");
  const f = fl.find((x) => x.size > 40) ?? fl[0];
  await c.select(f.entry);
  await waitFor(() => c.editorText().length > 0, 20000, "decompiled text");
  const want = await c.program().decompiler.pcode({ entry: f.entry }).result;
  need(want.raw.length > 2 && want.high.length > 0, "p-code for the function");
  c.command({ type: "pcode" });
  const region = await waitFor(() => byLabel<HTMLElement>("region", "P-code"), 10000, "p-code pane");
  const rows = () => [...region.querySelectorAll<HTMLElement>(".pc-line")];
  await waitFor(() => /ops/.test(region.querySelector('[aria-label="P-code state"]')!.textContent ?? ""), 20000, "high p-code loaded");
  need(region.querySelector('[aria-label="P-code state"]')!.textContent!.startsWith(`${want.high.length} ops`), "high count");
  need(document.querySelector<HTMLElement>(".editor")!.style.display === "none", "the decompiler is replaced while p-code shows");
  region.querySelector<HTMLButtonElement>('button[aria-label="Raw p-code"]')!.click();
  await waitFor(() => region.querySelector('[aria-label="P-code state"]')!.textContent!.startsWith(`${want.raw.length} instructions`), 10000, "raw view");
  // follows the cursor: the listing moving to an instruction marks its lines; a click on a line moves the cursor back
  const second = want.raw[2].address;
  await c.goAddr(second);
  await waitFor(() => rows().some((r) => r.classList.contains("cur") && r.textContent!.startsWith(second)), 10000, "the cursor's instruction marked");
  const other = want.raw[1].address;
  rows().find((r) => r.classList.contains("head") && r.textContent!.startsWith(other))?.click();
  await waitFor(() => c.topAddr() === other, 10000, "a click in the p-code moves the shared cursor to the listing");
  c.command({ type: "pcode" });
  await waitFor(() => document.querySelector<HTMLElement>(".editor")!.style.display !== "none" && !byLabel("region", "P-code"), 10000, "the decompiler is back");
  R.pcode = { entry: f.entry, raw: want.raw.length, high: want.high.length };
}

async function layoutStep(fl: FunctionInfo[], c: AutotestCtx, R: Record<string, any>) {
  const hasPcode = c.backend.capabilities.has("pcode");
  const order = () => [...document.querySelectorAll<HTMLElement>("section.pane")].map((e) => e.getAttribute("aria-label"));
  await c.select(fl[0].entry);
  await waitFor(() => c.editorText().length > 0, 20000, "decompiled text");
  c.command({ type: "layout", op: "apply", name: "Default" });
  await waitFor(() => !document.querySelector('section[aria-label="Dock"]') && order().join() === "Functions,Listing,Decompiler", 5000, "the Default layout");
  // arrange: listing first, the hex dock open, p-code instead of the C; save it under a name through the dialog
  c.command({ type: "pane-move", pane: "listing", dir: -1 });
  c.command({ type: "dock", panel: "hex" });
  if (hasPcode) c.command({ type: "pcode" });
  await waitFor(() => order().join() === "Listing,Functions,Decompiler" && document.querySelector('section[aria-label="Dock"]'), 5000, "the arrangement");
  c.command({ type: "layout-save" });
  const dlg = await waitFor(() => byLabel("dialog", "Save layout"), 5000, "save layout dialog");
  typeInto(dlg.querySelector<HTMLInputElement>('input[aria-label="Layout name"]')!, "autotest layout");
  dlg.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!.click();
  await waitFor(() => !byLabel("dialog", "Save layout"), 5000, "dialog closed");
  // back to the Default, then restore the saved one
  c.command({ type: "layout", op: "apply", name: "Default" });
  await waitFor(() => !document.querySelector('section[aria-label="Dock"]') && order().join() === "Functions,Listing,Decompiler" && !byLabel("region", "P-code"), 5000, "back to the Default");
  c.command({ type: "layout", op: "apply", name: "autotest layout" });
  await waitFor(() => order().join() === "Listing,Functions,Decompiler" && byLabel("region", "Bytes") && (!hasPcode || byLabel("region", "P-code")), 10000, "the saved layout restored");
  // the menu state carries the names; then delete it and leave the Default
  need(c.lastMenu()?.layouts?.includes("autotest layout"), "View > Layouts lists it");
  c.command({ type: "layout", op: "delete", name: "autotest layout" });
  await waitFor(() => !c.lastMenu()?.layouts?.includes("autotest layout"), 5000, "deleted");
  c.command({ type: "layout", op: "apply", name: "Default" });
  await waitFor(() => order().join() === "Functions,Listing,Decompiler" && !document.querySelector('section[aria-label="Dock"]'), 5000, "Default again");
  R.layout = { restored: "Listing,Functions,Decompiler", pcode: hasPcode };
}

async function trailStep(fl: FunctionInfo[], c: AutotestCtx, R: Record<string, any>) {
  need(c.backend.capabilities.has("valueTrail"), "provider has no valueTrail capability");
  // a function whose parameter or variable has a trail with ops, found through the backend (the same call the UI makes)
  let pick: { f: FunctionInfo; tok: { line: number; colStart: number; varName?: string }; want: Awaited<ReturnType<ReturnType<AutotestCtx["program"]>["decompiler"]["valueTrail"]>["result"]> } | null = null;
  for (const f of fl.filter((x) => x.size > 60).slice(0, 40)) {
    const d = await c.program().decompiler.decompile({ entry: f.entry }).result;
    const tok = d.tokens.find((t) => (t.kind === "param" || t.kind === "variable") && t.varName && t.line > 1 && t.address && !t.varAddress);
    if (!tok) continue;
    const want = await c.program().decompiler.valueTrail({ entry: f.entry, name: tok.varName, line: tok.line, colStart: tok.colStart }).result;
    if (want.ops.length && want.tokens.length) { pick = { f, tok, want }; break; }
  }
  need(pick, "a variable with a value trail");
  const { f, tok, want } = pick!;
  await c.select(f.entry);
  await waitFor(() => c.editorText().length > 0, 20000, "decompiled text");
  const ed = c.editor();
  ed.setPosition({ lineNumber: tok.line + 1, column: tok.colStart + 2 }); ed.focus(); await sleep(150);
  c.command({ type: "trail" });
  const status = () => document.querySelector('[aria-label="Value trail"]')?.textContent ?? "";
  const up = want.ops.filter((o) => o.dir === "backward").length, down = want.ops.filter((o) => o.dir === "forward").length;
  await waitFor(() => status().includes(`${up} upstream, ${down} downstream`), 20000, "the status bar's trail counts");
  await waitFor(() => document.querySelector(".monaco-editor .trail-seed"), 5000, "the seed token highlighted in the decompiler");
  need(document.querySelectorAll(".monaco-editor .trail-forward, .monaco-editor .trail-backward").length >= want.tokens.filter((t) => t.dir !== "seed").length ? true : want.tokens.every((t) => t.dir === "seed"), "downstream/upstream tokens highlighted");
  // the listing marks the instruction of an op
  const op = want.ops[0];
  await c.goAddr(op.address);
  await waitFor(() => [...document.querySelectorAll<HTMLElement>(".lbox .lrow.k-main")].some((r) => rowAddr(r) === op.address && (r.classList.contains("trail-f") || r.classList.contains("trail-b"))), 10000, "the op's instruction marked in the listing");
  // Esc clears it everywhere
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !status() && !document.querySelector(".monaco-editor .trail-seed") && !document.querySelector(".lbox .trail-f, .lbox .trail-b"), 5000, "Esc clears the trail");
  R.trail = { function: f.name, variable: tok.varName, up, down, tokens: want.tokens.length };
}

async function callsStep(fl: FunctionInfo[], c: AutotestCtx, R: Record<string, any>) {
  need(c.backend.capabilities.has("calls"), "provider has no calls capability");
  let pick: { f: FunctionInfo; r: Awaited<ReturnType<ReturnType<AutotestCtx["program"]>["references"]["calls"]>["result"]> } | null = null;
  for (const f of fl.slice(0, 300)) {
    const r = await c.program().references.calls({ entry: f.entry }).result;
    if (r.callers.length && r.callees.some((e) => e.entry)) { pick = { f, r }; break; }
  }
  need(pick, "no function with callers and callees");
  const { f, r } = pick!;
  await c.select(f.entry);
  c.command({ type: "dock", panel: "calls" });
  const region = await waitFor(() => document.querySelector<HTMLElement>('[role="region"][aria-label="Calls"]'), 5000, "calls panel");
  const rows = () => [...region.querySelectorAll<HTMLElement>('[role="row"].vt-row')];
  await waitFor(() => rows().length === r.callers.length + r.callees.length, 10000, "calls rows");
  need(region.textContent!.includes(`${r.callers.length} callers, ${r.callees.length} callees`), "counts in the header");
  const target = [...r.callers, ...r.callees].find((e) => e.entry && e.entry !== f.entry)!;
  const row = rows().find((x) => x.textContent!.includes(target.entry!))!;
  row.click();
  await waitFor(() => c.selected() === target.entry || c.topAddr() === target.entry, 20000, "navigation to the clicked call");
  R.calls = { entry: f.entry, callers: r.callers.length, callees: r.callees.length, clicked: target.name, thunks: [...r.callers, ...r.callees].filter((e) => e.thunk).length };
}

/** The Stack panel follows the function at the cursor: one row per slot, amber rings on analysis/default slots, a click selects (Rename/Retype enable). */
async function stackStep(fl: FunctionInfo[], c: AutotestCtx, R: Record<string, any>) {
  need(c.backend.capabilities.has("stackFrame"), "provider has no stackFrame capability");
  let pick: { f: FunctionInfo; slots: Awaited<ReturnType<ReturnType<AutotestCtx["program"]>["functions"]["stackFrame"]>>["slots"] } | null = null;
  for (const f of fl.slice(0, 300)) {
    const slots = (await c.program().functions.stackFrame({ entry: f.entry })).slots;
    if (slots.length >= 2 && slots.some((s) => s.source === "analysis" || s.source === "default")) { pick = { f, slots }; break; }
  }
  need(pick, "no function with a stack frame");
  const { f, slots } = pick!;
  await c.select(f.entry);
  c.command({ type: "dock", panel: "stack" });
  const region = await waitFor(() => document.querySelector<HTMLElement>('[role="region"][aria-label="Stack frame"]'), 5000, "stack panel");
  const rows = () => [...region.querySelectorAll<HTMLElement>('[role="row"].vt-row')];
  await waitFor(() => rows().length > 0 && region.textContent!.includes(`${slots.length} slots`), 10000, "stack rows");
  // the table is virtualized: check the rendered window only (aria-rowindex maps a row to its slot)
  const inferredAt = (r: HTMLElement) => { const s = slots[Number(r.getAttribute("aria-rowindex")) - 1]; return !!s && (s.source === "analysis" || s.source === "default"); };
  const inferred = slots.filter((s) => s.source === "analysis" || s.source === "default").length;
  need(rows().every((r) => (r.querySelector(".psrc.ring") !== null) === inferredAt(r)), "amber rings exactly on the inferred slots");
  const rename = region.querySelector<HTMLButtonElement>('button[aria-label="Rename slot"]');
  if (rename) {
    need(rename.disabled, "Rename needs a selected slot");
    rows()[0].click();
    await waitFor(() => !region.querySelector<HTMLButtonElement>('button[aria-label="Rename slot"]')!.disabled, 5000, "Rename enabled after a click");
  }
  R.stack = { entry: f.entry, slots: slots.length, inferred, editable: !!rename };
}

/** The Undefined tab: a click goes to the target, T there defines it, and the row is gone after the refresh. */
async function undefinedStep(c: AutotestCtx, R: Record<string, any>) {
  need(c.backend.capabilities.has("undefinedRefs"), "provider has no undefinedRefs capability");
  const first = await c.program().searches.listUndefinedRefs({ limit: 50 }).result;
  need(first.total > 0, "no reference into undefined bytes");
  const target = first.items[0].address;
  c.command({ type: "dock", panel: "undefined" });
  const region = await waitFor(() => document.querySelector<HTMLElement>('[role="region"][aria-label="Undefined data references"]'), 5000, "undefined panel");
  const rows = () => [...region.querySelectorAll<HTMLElement>('[role="row"].vt-row')];
  await waitFor(() => rows().length > 0 && region.textContent!.includes(`${first.total} references`), 20000, "undefined rows");
  const isTarget = (r: HTMLElement) => r.firstElementChild?.textContent === target;
  rows().find(isTarget)!.click();
  await waitFor(() => c.selected() === target || c.topAddr() === target, 20000, "navigation to the target");
  await sleep(300);
  document.querySelector<HTMLElement>(".lbox")!.focus();
  press(document.querySelector<HTMLElement>(".lbox")!, "t");
  const dlg = await waitFor(() => byLabel("dialog", "Define data"), 5000, "define data dialog");
  const box = dlg.querySelector<HTMLInputElement>('input[aria-label="Data type"]')!;
  typeInto(box, "byte"); press(box, "Enter");
  await waitFor(() => !byLabel("dialog", "Define data"), 10000, "dialog closed");
  await waitFor(() => !rows().some(isTarget) && !region.textContent!.includes(`${first.total} references`), 15000, "the defined target left the list");
  R.undefinedRefs = { total: first.total, target, after: (await c.program().searches.listUndefinedRefs({ limit: 1 }).result).total };
}

async function bookmarkStep(fl: FunctionInfo[], c: AutotestCtx, R: Record<string, any>, result: Record<string, any>) {
  need(c.backend.capabilities.has("bookmarks"), "provider has no bookmarks capability");
  await c.goAddr(fl[0].entry);
  await waitFor(() => c.topAddr() === fl[0].entry && mainRow(3), 10000, "listing at the first function");
  const row = mainRow(3), addr = rowAddr(row);
  const rowNow = () => [...document.querySelectorAll<HTMLElement>(".lbox .lrow.k-main")].find((r) => rowAddr(r) === addr);
  row.click(); document.querySelector<HTMLElement>(".lbox")!.focus(); await sleep(100);
  const notes = async () => (await c.program().bookmarks.list({ type: "Note" }).result).total;
  const n0 = await notes();
  c.command({ type: "edit", action: "bookmark" });
  const dlg = await waitFor(() => byLabel("dialog", "Add bookmark"), 5000, "add bookmark dialog");
  typeInto(dlg.querySelector<HTMLInputElement>('input[aria-label="Category (optional)"]')!, "triage");
  typeInto(dlg.querySelector<HTMLInputElement>('input[aria-label="Comment"]')!, "autotest bookmark");
  dlg.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!.click();
  await waitFor(() => !byLabel("dialog", "Add bookmark"), 10000, "dialog closed");
  await waitFor(() => rowNow()?.querySelector(".bm"), 10000, "bookmark marker in the listing");
  need(await notes() === n0 + 1, "one more Note bookmark");
  c.command({ type: "dock", panel: "bookmarks" });
  const region = await waitFor(() => document.querySelector<HTMLElement>('[role="region"][aria-label="Bookmarks"]'), 5000, "bookmarks panel");
  const rows = () => [...region.querySelectorAll<HTMLElement>('[role="row"].vt-row')];
  await waitFor(() => region.textContent!.includes(`${n0 + 1} bookmarks`) && rows().some((r) => r.textContent!.includes("autotest bookmark")), 10000, "the bookmark in the panel");
  region.querySelector<HTMLButtonElement>('button[aria-label="Sort by Category"]')!.click();
  await sleep(300);
  setSelect(region.querySelector<HTMLSelectElement>('select[aria-label="Bookmark type"]')!, "");
  await waitFor(() => /\d+ bookmarks/.test(region.textContent!) && !region.textContent!.includes(`${n0 + 1} bookmarks`) || n0 + 1 === (+(/(\d+) bookmarks/.exec(region.textContent!)?.[1] ?? 0)), 10000, "all types listed");
  setSelect(region.querySelector<HTMLSelectElement>('select[aria-label="Bookmark type"]')!, "Note");
  await waitFor(() => region.textContent!.includes(`${n0 + 1} bookmarks`), 10000, "Note filter back");
  await c.goAddr(fl[0].entry); await waitFor(() => c.topAddr() === fl[0].entry, 10000, "away from the row");
  const hit = await waitFor(() => rows().find((r) => r.textContent!.includes("autotest bookmark")), 10000, "panel row");
  hit.click();
  await waitFor(() => (window as any).__listing?.rowAt(addr) && c.topAddr() === (window as any).__listing.rowAt(addr).address, 10000, "panel click navigates the listing");
  // one undo step each way
  document.querySelector<HTMLElement>(".lbox")!.focus();
  c.command({ type: "edit", action: "undo" });
  await waitFor(() => !rowNow()?.querySelector(".bm"), 10000, "marker gone after undo");
  need(await notes() === n0, "undo removed it");
  c.command({ type: "edit", action: "redo" });
  await waitFor(() => rowNow()?.querySelector(".bm"), 10000, "marker back after redo");
  need(await notes() === n0 + 1, "redo restored it");
  c.command({ type: "edit", action: "save" }); // clean for the edit flow, and the bookmark must survive the quit (AUTOTEST_PHASE=2 checks it)
  await waitFor(() => !c.title().startsWith("• "), 10000, "saved");
  R.bookmarks = { address: addr, before: n0 };
  result.quickPersist = { ...(result.quickPersist ?? {}), bookmark: { address: addr, comment: "autotest bookmark" } };
}

export async function runQuickFlow(fl: FunctionInfo[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.quick = {});
  await copyStep(fl, c, R);
  await callsStep(fl, c, R);
  await stackStep(fl, c, R);
  await undefinedStep(c, R);
  await hexStep(fl, c, R);
  await pcodeStep(fl, c, R);
  await layoutStep(fl, c, R);
  await trailStep(fl, c, R);
  await patchStep(fl, c, R, result);
  await bookmarkStep(fl, c, R, result);
  return true;
}

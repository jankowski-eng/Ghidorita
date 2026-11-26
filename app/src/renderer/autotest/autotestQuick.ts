import type { FunctionInfo } from "../../../../protocol";
import { copied } from "../clipboard";
import { byLabel, press, setSelect, typeInto, waitFor, sleep, type AutotestCtx } from "./autotest";

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
  result.quickPersist = { bookmark: { address: addr, comment: "autotest bookmark" } };
}

export async function runQuickFlow(fl: FunctionInfo[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.quick = {});
  await copyStep(fl, c, R);
  await callsStep(fl, c, R);
  await stackStep(fl, c, R);
  await undefinedStep(c, R);
  await bookmarkStep(fl, c, R, result);
  return true;
}

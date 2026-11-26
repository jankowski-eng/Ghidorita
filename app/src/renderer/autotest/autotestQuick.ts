import type { FunctionInfo } from "../../../../protocol";
import { copied } from "../clipboard";
import { waitFor, sleep, type AutotestCtx } from "./autotest";

// Round 11 flow: one step per quick win (copy actions, then callers/callees, then bookmarks). Mock and real sidecar.
const need = (ok: unknown, what: string) => { if (!ok) throw new Error("quick: " + what); };
const mainRow = (nth = 0) => document.querySelectorAll<HTMLElement>(".lbox .lrow.k-main")[nth];
const rowAddr = (el: HTMLElement) => el.querySelector(".a")!.textContent!.replace(/[▸▾]/g, "").trim();

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

export async function runQuickFlow(fl: FunctionInfo[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.quick = {});
  await copyStep(fl, c, R);
  return true;
}

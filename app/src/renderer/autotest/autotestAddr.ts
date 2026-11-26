import type { FunctionInfo, Token } from "../../../../protocol";
import { byLabel, isMock, press, setSelect, sleep, typeInto, waitFor, type AutotestCtx } from "./autotest";

// Round 8 flow of the autotest: X on a decompiler global opens the references to its address, X on a decompiler temporary (iVar1, uVar3)
// lists its writes and reads, a click on a use navigates the listing and highlights the token; then (real sidecar) the program is imported as
// a raw blob above 2^63 and Go to Address reaches it. Mock and real sidecar (the mock's blob range is in its listing flow).
const need = (ok: unknown, what: string) => { if (!ok) throw new Error("addr: " + what); };
const TEMP = /^[a-z]{1,3}Var\d+$/;

export async function runAddrFlow(file: string, fl: FunctionInfo[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.addr = {});
  const errors0 = c.errors.length;
  const xr = () => byLabel("region", "References to current address")!;
  const xrows = () => [...xr().querySelectorAll<HTMLElement>("button.xr")];
  const hdr = () => xr().querySelector(".xh")?.textContent ?? "";
  const pinned = () => !!xr().querySelector('button[aria-label="Follow cursor"]');
  const topAt = (addr: string) => { const r = (window as any).__listing?.rowAt(addr); return !!r && c.topAddr() === r.address; };
  const pressX = async (f: FunctionInfo, text: string, t: Token) => {
    await c.select(f.entry);
    await waitFor(() => c.editorText() === text, 20000, "decompiler text of " + f.name);
    const ed = c.editor();
    ed.setPosition({ lineNumber: t.line + 1, column: t.colStart + 2 }); ed.focus();
    await sleep(200);
    const ta = document.querySelector<HTMLElement>(".monaco-editor textarea")!; ta.focus();
    c.command({ type: "xrefs" }); // Cmd+Shift+F is a menu accelerator; the menu sends this command
  };

  // find a function with a global token that has references, and one with a temporary that has writes and reads
  let glob: { f: FunctionInfo; t: Token; text: string; refs: number } | null = null, temp: { f: FunctionInfo; t: Token; text: string; uses: { from: string; kind: string }[] } | null = null;
  for (const f of [...fl].sort((a, b) => b.size - a.size).slice(0, 120)) {
    if (glob && temp) break;
    const d = await c.program().decompiler.decompile({ entry: f.entry }).result.catch(() => null);
    if (!d) continue;
    if (!glob) {
      const t = d.tokens.find((t) => t.varAddress);
      const refs = t ? await c.program().references.xrefsTo({ address: t.varAddress!, limit: 500 }) : [];
      if (t && refs.length) glob = { f, t, text: d.text, refs: refs.length };
    }
    if (!temp) {
      for (const name of new Set(d.tokens.filter((t) => t.varName && TEMP.test(t.varName) && !t.varAddress).map((t) => t.varName!))) {
        if ((await c.program().references.xrefsToVariable({ entry: f.entry, name })).length) continue; // a program variable: the other path
        const uses = await c.program().references.variableUses({ entry: f.entry, name }).result;
        const t = d.tokens.find((t) => t.varName === name && uses.some((u) => u.from === t.address));
        if (t && uses.some((u) => u.kind === "write") && uses.some((u) => u.kind === "read")) { temp = { f, t, text: d.text, uses }; break; }
      }
    }
  }
  need(glob, "no decompiler global with references found"); need(temp, "no decompiler temporary with writes and reads found");

  // X on the global: references to its address (the panel shows the variable's name)
  const g = glob!;
  await pressX(g.f, g.text, g.t);
  await waitFor(() => hdr().startsWith(`References to ${g.t.varName}`) && pinned() && xrows().length === Math.min(g.refs, 200), 15000, `X on global ${g.t.varName}: ${g.refs} references (panel: ${hdr()}, ${xrows().length} rows)`);
  R.global = { fn: g.f.name, name: g.t.varName, address: g.t.varAddress, rows: xrows().length, expected: g.refs };
  document.querySelector<HTMLElement>('button[aria-label="Follow cursor"]')!.click();
  await waitFor(() => !pinned(), 5000, "follow cursor unpins");

  // X on the temporary: its uses with their kinds; a click navigates the listing and highlights the token
  const tp = temp!;
  await pressX(tp.f, tp.text, tp.t);
  await waitFor(() => hdr().startsWith(`References to ${tp.t.varName}`) && pinned() && xrows().length === tp.uses.length, 20000, `X on temporary ${tp.t.varName}: ${tp.uses.length} uses (panel: ${hdr()}, ${xrows().length} rows)`);
  const kinds = new Set(xrows().map((r) => r.querySelector(".xk")?.textContent));
  need(kinds.has("write") && kinds.has("read"), "use kinds shown: " + [...kinds]);
  const hit = xrows().find((r) => r.querySelector(".a")?.textContent === tp.t.address)!;
  need(hit, "a row at the token's instruction " + tp.t.address);
  hit.click();
  await waitFor(() => topAt(tp.t.address!), 10000, `click navigates the listing to ${tp.t.address} (top ${c.topAddr()})`);
  const hl = await waitFor(() => document.querySelector(".use-token"), 10000, "decompiler highlights the token");
  need(hl.textContent === tp.t.varName, "highlighted text " + hl.textContent);
  R.temp = { fn: tp.f.name, name: tp.t.varName, uses: tp.uses.length, kinds: [...kinds], clicked: tp.t.address };
  document.querySelector<HTMLElement>('button[aria-label="Follow cursor"]')?.click();

  // Go to Address with a high address on a raw blob (real sidecar; the explicit-option dialog opens are otherwise answered Cancelled)
  if (!isMock(fl)) {
    const dlg = (t: string) => byLabel("dialog", t);
    c.command({ type: "open-path", path: file });
    const d = await waitFor(() => dlg("Import binary"), 10000, "import dialog");
    const openBtn = d.querySelector<HTMLButtonElement>("button.primary")!;
    await waitFor(() => !openBtn.disabled, 10000, "import dialog ready");
    const loader = d.querySelector<HTMLSelectElement>('select[aria-label="Loader"]')!;
    setSelect(loader, [...loader.options].find((o) => /Raw Binary/.test(o.textContent!))!.value);
    const lang = await waitFor(() => d.querySelector<HTMLSelectElement>('select[aria-label="Language"]'), 5000, "language select");
    await waitFor(() => [...lang.options].some((o) => o.value === "x86:LE:64:default"), 10000, "x86-64 language");
    setSelect(lang, "x86:LE:64:default");
    const bi = d.querySelector<HTMLInputElement>('input[aria-label="Base address"]')!;
    typeInto(bi, "0xffffffff80000000"); await sleep(100);
    need(!openBtn.disabled, "a base above 2^63 is accepted");
    setSelect(d.querySelector<HTMLSelectElement>('select[aria-label="Analysis profile"]')!, "fast");
    press(bi, "Enter");
    await waitFor(() => !dlg("Import binary") && c.status().opened && !c.status().opening, 300000, "raw import");
    const info = await c.program().listing.info();
    need(info.ranges[0].start === "0xffffffff80000000", "raw blob range " + JSON.stringify(info.ranges[0]));
    const target = "0xffffffff80000100";
    c.command({ type: "goto" });
    const inp = await waitFor(() => document.querySelector<HTMLInputElement>(".goto input"), 5000, "Go to address bar");
    typeInto(inp, target); press(inp, "Enter");
    await waitFor(() => topAt(target), 15000, `Go to ${target} (top ${c.topAddr()})`);
    const shown = [...document.querySelectorAll(".lrow .a")].some((x) => x.textContent === target);
    need(shown && !c.topAddr().startsWith("-"), "row shown with the exact unsigned address");
    R.rawBlob = { base: info.ranges[0].start, goto: target, top: c.topAddr() };
    await c.open(file); // back to the default import for the flows after this one
  } else R.rawBlob = "skipped (mock: its listing flow covers the range above 2^63)";
  need(c.errors.length === errors0, "errors during the flow: " + c.errors.slice(errors0).join("; "));
  R.ok = true;
  return true;
}

import type { Address, AnalysisState, FunctionInfo } from "../../../../protocol";
import { AddrMap } from "../addrmap";
import type { ApplicationBackend, ProgramOperations } from "../backend";
import type { ImportOptions } from "../../../../protocol";
import type { MenuCommand, MenuState } from "../../preload/index";
import { runEditFlow, runPhase2, runTypesFlow } from "./autotestEdit";
import { runNavFlow } from "./autotestNav";
import { runR5Flow } from "./autotestR5";
import { runListingFlow } from "./autotestListing";
import { runFocusedFlow } from "./autotestFlows";
import { runAddrFlow } from "./autotestAddr";
import { runAnalysisFlow } from "./autotestAnalysis";
import { runQuickFlow } from "./autotestQuick";

/** What the scripted modes need from the running app. */
export interface AutotestControls {
  requests: { method: string; params: unknown }[];
  holdDecompile(entry: Address): { started: boolean; cancelled: number };
  cancelOpenWhen(predicate?: (params: ImportOptions & { path: string }) => boolean): void;
  openAttempts: (ImportOptions & { path: string })[];
  /** the next open never reaches the provider and stays pending until the returned function makes it fail as cancelled */
  holdNextOpen(): () => void;
}
export interface AutotestCtx extends AutotestControls {
  backend: ApplicationBackend;
  program(): ProgramOperations;
  open(path: string): Promise<FunctionInfo[] | undefined>;
  /** open with analysis "background" (open() above waits for the analysis, the older flows need that) */
  openBg(path: string, opts?: ImportOptions): Promise<FunctionInfo[] | undefined>;
  analysis(): AnalysisState | null;
  select(entry: Address): Promise<void>;
  /** navigate to any address like Go to Address does */
  goAddr(address: Address): Promise<void>;
  clickAt(line1: number, col1: number): Promise<void> | void;
  cancelFile: string | null;
  /** AUTOTEST_ONLY=listing|addr: open the file and run just that flow (fast iteration) */
  only?: string | null;
  /** AUTOTEST_FLOW: a focused scripted flow (see autotestFlows.ts) instead of the full run */
  flow: string | null;
  status(): { funcs: number; opened: boolean; opening: boolean; phase: string; notice: string };
  back(): void;
  forward(): void;
  selected(): Address | null;
  topAddr(): Address;
  editorText(): string;
  editor(): any;
  menu(id: string): Promise<boolean>;
  expect: any;
  funcCount(): number;
  errors: string[];
  fail(e: unknown): void;
  /** the same handler the application menu's commands end in (main only forwards the click) */
  command(c: MenuCommand): void;
  lastMenu(): MenuState | null;
  title(): string;
}

/** The mock sidecar names its functions fn_<n> (the real one never does for a stripped binary). Flows that need Ghidra's decompiler variables skip it. */
export const isMock = (fl: { name: string }[]) => fl.some((f) => /^fn_\d+$/.test(f.name));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor<T>(f: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + what); await sleep(50); }
}
// real-UI helpers: find by role/label, set a React-controlled input the way a user's typing does, dispatch real key events
export const byLabel = <E extends HTMLElement>(role: string, label: string) => document.querySelector<E>(`[role="${role}"][aria-label="${label}"]`);
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
export const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  el.focus();
  Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
export const setSelect = (el: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
export const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

export async function runAutotest(file: string, c: AutotestCtx) {
    const result: Record<string, unknown> = { ok: false };
    if (c.flow) {
      try { result.ok = await runFocusedFlow(c.flow, file, c, result); } catch (e) { c.fail(e); }
      result.errors = c.errors; if (c.errors.length) result.ok = false;
      return window.host.autotestDone(result);
    }
    if (c.expect) { // second launch of the edit autotest: did the saved edit survive the quit?
      try { await runPhase2(file, c, result); } catch (e) { c.fail(e); }
      result.errors = c.errors; if (c.errors.length) result.ok = false;
      return window.host.autotestDone(result);
    }
    let persist: unknown;
    try {
      if (c.only === "addr") {
        await c.open(file);
        result.ok = (await runAddrFlow(file, await c.program().functions.list(), c, result)) && c.errors.length === 0;
        result.errors = c.errors;
        return window.host.autotestDone(result);
      }
      if (c.only === "quick") {
        await c.open(file);
        result.ok = (await runQuickFlow(await c.program().functions.list(), c, result)) && c.errors.length === 0;
        result.errors = c.errors;
        return window.host.autotestDone(result);
      }
      if (c.only === "listing") {
        await c.open(file);
        result.ok = (await runListingFlow(await c.program().functions.list(), c, result)) && c.errors.length === 0;
        result.errors = c.errors;
        return window.host.autotestDone(result);
      }
      if (c.cancelFile) { // cancel during analysis of a never-seen binary, then open it again, all through the UI
        const openViaUi = async () => { // the open-path command (File > Open Recent), then Enter in the import dialog (defaults)
          c.command({ type: "open-path", path: c.cancelFile! });
          const d = await waitFor(() => byLabel("dialog", "Import binary"), 10000, "import dialog");
          await waitFor(() => !d.querySelector<HTMLButtonElement>("button.primary")!.disabled, 10000, "import dialog ready");
          press(d.querySelector<HTMLElement>('[aria-label="Loader"]')!, "Enter");
        };
        await openViaUi();
        await waitFor(() => c.status().phase === "analysis", 120000, "analysis phase");
        const dlg = byLabel("dialog", "Opening binary")!;
        const cancelBtn = [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
        cancelBtn.click();
        await waitFor(() => !c.status().opening, 30000, "open to end after Cancel");
        const st = c.status();
        const emptyState = !document.querySelector(".main") && /Open a binary to begin/.test(document.body.textContent ?? "");
        await openViaUi();
        await waitFor(() => c.status().opening, 5000, "reopen to start");
        await waitFor(() => !c.status().opening, 300000, "reopen to finish"); // needs a never-analyzed, non-trivial binary (see README)
        const after = c.status();
        result.cancel = { openedAfterCancel: st.opened, emptyState, notice: st.notice, reopenFunctions: after.funcs, openedAfterReopen: after.opened };
        result.cancelOk = !st.opened && emptyState && /cancel/i.test(st.notice) && after.funcs > 0 && after.opened;
      }
      const fl = await c.open(file);
      if (!fl?.length) throw new Error("no functions");
      // pick main (or first), else walk the first few functions until one has a call token
      const order = [...fl.filter((f) => f.name === "main"), ...fl.slice(0, 10)];
      let clicked = false;
      for (const f of order) {
        const r = await c.program().decompiler.decompile({ entry: f.entry }).result;
        const tok = r.tokens.find((t) => t.targetFunction && t.targetFunction !== f.entry); // a real call to another function
        if (!tok) continue;
        await c.select(f.entry);
        await new Promise((r) => setTimeout(r, 300));
        result.startFunction = f.name;
        result.clickedToken = { line: tok.line, colStart: tok.colStart, target: tok.targetFunction };
        await c.clickAt(tok.line + 1, tok.colStart + 2); // same path as a Monaco mouse click
        clicked = true;
        break;
      }
      if (!clicked) throw new Error("no call token found");
      await new Promise((r) => setTimeout(r, 1000));
      result.selectedEntry = c.selected();
      result.expectedEntry = (result.clickedToken as any).target;
      result.listingTopAddress = c.topAddr();
      result.editorFirstLine = c.editorText().split("\n")[0];
      result.functions = fl.length; result.totalBytes = (await c.program().listing.info()).totalBytes;
      // Back returns to the start function (listing top row = its entry), Forward to the callee again
      const startEntry = fl.find((f) => f.name === result.startFunction)!.entry;
      c.back(); await new Promise((r) => setTimeout(r, 1000));
      result.afterBackTop = c.topAddr();
      c.forward(); await new Promise((r) => setTimeout(r, 1000));
      result.afterForwardTop = c.topAddr();
      // symbol search through the real panel: click Search, type, wait for hits, press Enter; focus must come back
      const q = fl[Math.min(5, fl.length - 1)].name;
      const sbtn = button("Open binary")!; sbtn.focus(); c.command({ type: "search" });
      const box = await waitFor(() => document.querySelector<HTMLInputElement>('[role="combobox"][aria-label="Symbol or action"]'), 5000, "search panel");
      typeInto(box, q);
      const opt = await waitFor(() => document.querySelector<HTMLElement>('#sym-list [role="option"][aria-selected="true"]'), 5000, "search results");
      const hit = opt.querySelector(".a")!.textContent!;
      press(box, "Enter");
      await waitFor(() => !byLabel("dialog", "Search symbols"), 5000, "search panel to close");
      await sleep(1000);
      result.search = { query: q, address: hit, listingTop: c.topAddr(), focusRestored: document.activeElement === sbtn };
      result.searchOk = c.topAddr() === hit && document.activeElement === sbtn;

      // quickly open two functions back to back: the first decompile must be cancelled, the second one shown
      const [fa, fb] = fl.slice(-2);
      const held = c.holdDecompile(fa.entry);
      const first = c.select(fa.entry);
      await waitFor(() => held.started, 5000, "first decompile to start");
      await c.select(fb.entry); await first;
      await waitFor(() => c.selected() === fb.entry && c.editorText().length > 0, 10000, "second function decompiled");
      result.quickSwitch = { cancelled: held.cancelled, shown: c.selected() };
      result.quickSwitchOk = held.cancelled >= 1 && c.selected() === fb.entry;

      // ---- save / close (autosave) / welcome / import, all through the real UI ----
      const base = file.split("/").pop()!;
      const dirtyNow = () => c.title().startsWith("• ");
      const dlg = (l: string) => byLabel("dialog", l);
      const rename = async (i: number) => { const f = fl[i], n = `autotest_${Date.now().toString(36)}_${i}`; await c.program().edits.renameSymbol({ address: f.entry, newName: n }); return n; };
      const m0 = c.lastMenu();
      await rename(2);
      await waitFor(() => dirtyNow() && c.lastMenu()?.dirty && c.lastMenu()?.canEdit, 5000, "dirty marker and Save enabled");
      const dirtyShown = true;
      c.command({ type: "edit", action: "save" });
      await waitFor(() => !dirtyNow() && !c.lastMenu()?.dirty, 10000, "clean after Save");
      const savedClean = !(await c.program().history.state()).dirty;
      result.save = { menuBefore: m0, dirtyShown, savedClean, title: c.title() };

      // close with unsaved edits: no prompt, the sidecar autosaves; the rename must survive a reopen from the browser
      const kept = await rename(3); await waitFor(dirtyNow, 5000, "dirty again");
      c.command({ type: "close-program" });
      await waitFor(() => !c.status().opened && !document.querySelector(".main"), 10000, "welcome state after close");
      const noPrompt = !dlg("Save changes?");
      const entry = await waitFor(() => [...document.querySelectorAll<HTMLElement>(".welcome .open")].find((b) => b.textContent!.includes(base)), 10000, "program in browser");
      const noProgram = !(await c.backend.lifecycle.active());
      result.close = { noPrompt, titlePlain: !c.title().includes("—"), noProgram, menu: c.lastMenu() };

      entry.click(); // open from the welcome pane
      await waitFor(() => c.status().opening, 5000, "open from browser to start");
      await waitFor(() => !c.status().opening && c.status().opened, 300000, "open from browser to finish");
      const keptHits = await c.program().searches.searchSymbols({ query: kept, limit: 5 }).result;
      result.browserOpen = { functions: c.status().funcs, title: c.title(), autosaved: keptHits.some((h) => h.name === kept), cleanAfterReopen: !(await c.program().history.state()).dirty };

      // import dialog: record what open_binary is sent. An explicit-options open is answered Cancelled locally (no new analysis).
      const sentStart = c.openAttempts.length;
      c.cancelOpenWhen((options) => !!options.loader);
      const importDlg = async (path: string) => { c.command({ type: "open-path", path }); return waitFor(() => dlg("Import binary"), 10000, "import dialog"); };
      const openBtn = (d: Element) => d.querySelector<HTMLButtonElement>("button.primary")!;
      let d = await importDlg(file);
      await waitFor(() => !openBtn(d).disabled, 10000, "import dialog ready");
      const loader = d.querySelector<HTMLSelectElement>('select[aria-label="Loader"]')!;
      const preselectedPreferred = /preferred/.test(loader.selectedOptions[0].textContent!);
      press(loader, "Enter"); // defaults
      await waitFor(() => !dlg("Import binary") && c.status().opened && !c.status().opening, 300000, "default open"); // opened flips before the listing is read: a request made while opening is ignored
      const defaultSent = JSON.stringify(c.openAttempts[sentStart]);
      d = await importDlg(file);
      await waitFor(() => !openBtn(d).disabled, 10000, "import dialog ready 2");
      // Raw Binary is the one stock loader with a base address and a free language choice (real sidecar: Mach-O has neither)
      const loader2 = d.querySelector<HTMLSelectElement>('select[aria-label="Loader"]')!;
      setSelect(loader2, [...loader2.options].find((o) => /Raw Binary/.test(o.textContent!))!.value);
      const langSel = await waitFor(() => d.querySelector<HTMLSelectElement>('select[aria-label="Language"]'), 5000, "language select");
      await waitFor(() => langSel.options.length > 5 || (langSel.options.length > 2), 5000, "language list");
      const other = [...langSel.options].find((o) => o.value && o.value !== langSel.value)!;
      setSelect(langSel, other.value);
      const bi = d.querySelector<HTMLInputElement>('input[aria-label="Base address"]')!;
      typeInto(bi, "0xzz"); await sleep(100);
      const badDisables = openBtn(d).disabled && !!d.querySelector('[role="alert"]');
      typeInto(bi, "10000000000000000"); await sleep(100);
      const tooBigDisables = openBtn(d).disabled;
      typeInto(bi, "1000"); await sleep(100);
      const goodEnables = !openBtn(d).disabled;
      setSelect(d.querySelector<HTMLSelectElement>('select[aria-label="Analysis profile"]')!, "fast"); // sent along with the options
      press(bi, "Enter");
      await waitFor(() => !dlg("Import binary") && !c.status().opening, 10000, "explicit open answered");
      const explicit = c.openAttempts[sentStart + 1];
      await sleep(300);
      d = await importDlg("/nonexistent/missing.bin");
      await waitFor(() => d.querySelector('[role="alert"]'), 10000, "import error");
      const errorOk = /not found/i.test(d.querySelector('[role="alert"]')!.textContent!) && openBtn(d).disabled;
      press(d, "Escape");
      await waitFor(() => !dlg("Import binary"), 5000, "import dialog closes on Escape");
      c.cancelOpenWhen();
      result.importDlg = { preselectedPreferred, defaultSent, explicit, badDisables, tooBigDisables, goodEnables, errorOk };
      const importOk = preselectedPreferred && JSON.parse(defaultSent).path === file && JSON.parse(defaultSent).profile === "full" && !JSON.parse(defaultSent).loader && explicit?.language === other.value && explicit?.baseAddress === "0x1000" && explicit?.profile === "fast" && typeof explicit?.loader === "string"
        && badDisables && tooBigDisables && goodEnables && errorOk;

      result.importOk = importOk;
      await c.open(file); // use the default import for the remaining checks
      result.analysisOk = await runAnalysisFlow(file, c, result); // background open, status bar indicator, cancel, resume, browser Run full analysis; needs the fast key unseen (the R5 flow opens it); ends with the default import open
      result.r5Ok = await runR5Flow(file, c, result); // strings, references from, comment prefill, labels, import profile; ends with the default import open
      result.saveOk = dirtyShown && savedClean && !m0?.dirty;
      const bo = result.browserOpen as any, cl = result.close as any;
      result.closeOk = cl.noPrompt && cl.noProgram && cl.titlePlain && bo.functions > 0 && bo.autosaved && bo.cleanAfterReopen;
      result.navOk = result.afterBackTop === startEntry && result.afterForwardTop === result.expectedEntry;
      result.navFindOk = await runNavFlow(await c.program().functions.list(), c, result);
      result.ok = result.navOk && result.navFindOk === true && result.searchOk && result.quickSwitchOk && result.saveOk === true && result.closeOk === true && result.importOk === true && result.r5Ok === true && result.analysisOk === true && (!c.cancelFile || result.cancelOk === true) && result.expectedEntry !== fl.find((f) => f.name === result.startFunction)?.entry && result.selectedEntry === result.expectedEntry && result.listingTopAddress === result.selectedEntry && c.errors.length === 0;
      if (result.ok) result.ok = (await runListingFlow(await c.program().functions.list(), c, result)) && c.errors.length === 0;
      if (result.ok) result.ok = (await runAddrFlow(file, await c.program().functions.list(), c, result)) && c.errors.length === 0;
      if (result.ok) result.ok = (await runQuickFlow(await c.program().functions.list(), c, result)) && c.errors.length === 0;
      if (result.ok) {
        const ed = await runEditFlow(fl, c, result);
        let ok = ed.ok;
        if (ok) { const ty = await runTypesFlow(c, result, ed.persist as { entry: string } | undefined); ok = ty.ok; persist = ed.persist && { ...(ed.persist as object), types: ty.persist }; }
        result.ok = ok && c.errors.length === 0;
      }
    } catch (e) { c.fail(e); result.ok = false; }
    result.errors = c.errors;
    if (persist && result.ok) { (result as any).persist = persist; window.host.autotestQuit(result); } else window.host.autotestDone(result); // quit through the real before-quit path (saves, stops the sidecar)
}

// BENCH=1 AUTOTEST=<file>: listing scroll + decompile measurements in the real renderer (step 6 of the spike)
export async function runBench(file: string, c: AutotestCtx) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
    const q = (xs: number[], p: number) => { const a = [...xs].sort((x, y) => x - y); return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] * 100) / 100 : 0; };
    const summ = (xs: number[]) => ({ n: xs.length, median: q(xs, 0.5), p95: q(xs, 0.95), max: q(xs, 1) });
    const result: Record<string, any> = { ok: true };
    let gaps: number[] = [];
    let running = true;
    (async () => { let last = performance.now(); while (running) { const n = await frame(); gaps.push(n - last); last = n; } })();
    const frames = () => { const g = gaps; gaps = []; return { frames: g.length, ...summ(g) }; };
    try {
      const t0 = performance.now();
      const fl = await c.open(file);
      result.openMs = Math.round(performance.now() - t0);
      const info = await c.program().listing.info();
      const m = new AddrMap(info.ranges);
      result.functions = fl!.length; result.totalBytes = m.total;
      await sleep(1500);
      const L = (window as any).__listing;
      const randAddr = () => m.addr(Math.random() * (m.total - 1));

      frames();
      const lat: number[] = [];
      for (let i = 0; i < 300; i++) { const t = performance.now(); await L.jump(randAddr()); await frame(); lat.push(performance.now() - t); }
      result.randomJump300 = { ms: summ(lat), frameGapMs: frames() };

      const sw: number[] = []; const ts = performance.now();
      for (let i = 0; i < 1000; i++) { const t = performance.now(); await L.jump(m.addr((i / 999) * (m.total - 1))); await frame(); sw.push(performance.now() - t); }
      result.sweepStartToEnd1000 = { ms: summ(sw), totalS: Math.round(performance.now() - ts) / 1000, frameGapMs: frames() };

      // fling: 100 lines per frame (~6000 lines/s at 60 Hz) from the middle; a "stall" frame is one where the buffer could not supply the lines
      const fling = async (ms: number, until?: () => boolean) => {
        await L.jump(m.addr(m.total / 2)); await sleep(500); frames();
        const end = performance.now() + ms; let stall = 0, stallRun = 0, worst = 0, moved = 0, f = 0, t = performance.now();
        while (performance.now() < end && !(until?.())) {
          await frame(); f++;
          const d = L.scrollLines(100); moved += d;
          if (d < 100) { stall++; stallRun += performance.now() - t; worst = Math.max(worst, stallRun); } else stallRun = 0;
          t = performance.now();
        }
        return { frames: f, linesMoved: moved, stallFrames: stall, stallPct: Math.round((1000 * stall) / Math.max(f, 1)) / 10, worstConsecutiveStallMs: Math.round(worst), frameGapMs: frames() };
      };
      for (const [name, t] of [["batch100_margin60", { batch: 100, margin: 60 }], ["batch250_margin400", undefined]] as const) { // round 2 settings vs round 8, same session
        (window as any).__tune = t; result["fling20s_" + name] = await fling(20000);
      }
      (window as any).__tune = undefined;
      (window as any).__lst.length = 0;

      let done = false; const dl: number[] = [];
      const picks = Array.from({ length: 50 }, () => fl![Math.floor(Math.random() * fl!.length)]);
      const dec = (async () => { for (const f of picks) { const t = performance.now(); try { await c.program().decompiler.decompile({ entry: f.entry }).result; } catch (e) { c.errors.push(String(e)); } dl.push(performance.now() - t); } done = true; })();
      result.flingDuringDecompile50 = await fling(120000, () => done);
      await dec;
      result.decompileMs = summ(dl);
      const fwd = ((window as any).__lst as any[]).map((x) => x.ms);
      result.listingFetchMsDuringDecompile = summ(fwd);
    } catch (e) { c.fail(e); result.ok = false; }
    running = false;
    result.errors = c.errors;
    window.host.autotestDone(result);
}

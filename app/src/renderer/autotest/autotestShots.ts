import { byLabel, press, setSelect, sleep, typeInto, waitFor, type AutotestCtx } from "./autotest";

// Screenshot flows (AUTOTEST=/bin/ls AUTOTEST_FLOW=shot-<name> npm start): arrange one UI state through the real DOM, check it, and end there;
// the autotest's last act is app/out/screenshot.png.
const need = (ok: unknown, what: string) => { if (!ok) throw new Error("shot: " + what); };

export async function runShotFlow(name: string, file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const [flow, ...args] = name.split(":"); name = flow;
  if (name === "shot-start") return startShot(c);
  if (name === "shot-import") return importShot(file, c);
  if (name === "shot-analysis") return analysisShot(file, c, result);
  if (name === "shot-debugger") return debuggerShot(file, args, c, result);
  const fl = await c.open(file);
  need(fl?.length, "no functions");
  if (name === "shot-graph") return graphShot(fl!, c, result);
  if (name === "shot-map") return mapShot(fl!, args, c, result);
  if (name === "shot-export") return exportShot(fl!, c, result);
  if (name === "shot-bar") return barShot(c, result);
  if (name === "shot-calls") return callsShot(fl!, c, result);
  if (name === "shot-bookmarks") return bookmarksShot(fl!, c, result);
  if (name === "shot-warnings") return warningsShot(fl!, c, result);
  if (name === "shot-hex") return hexShot(fl!, c, result);
  if (name === "shot-pcode") return pcodeShot(fl!, c, result);
  if (name === "shot-layout") return layoutShot(fl!, c, result);
  if (name === "shot-trail") return trailShot(fl!, c, result);
  if (name === "shot-patch") return patchShot(fl!, c, result);
  if (name === "shot-copy") return copyShot(fl!, c, result);
  if (name === "shot-overview") return overviewShot(fl!, c);
  if (name === "shot-actions") return actionsShot(fl!, c);
  if (name === "shot-strings") return stringsShot(fl!, c);
  if (name === "shot-datatypes") return dataTypesShot(c);
  if (name === "shot-coverage") return coverageShot(fl!, args, c);
  if (name === "shot-callgraph") return callGraphShot(fl!, args, c, result);
  throw new Error("unknown shot flow " + name);
}

async function graphShot(fl: { name: string; entry: string; size: number }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const f = fl.find((x) => x.name === "main") ?? [...fl].sort((a, b) => a.size - b.size).find((x) => x.size > 300)!;
  const g = await c.program().decompiler.graph({ entry: f.entry }).result;
  need(g.blocks.length >= 3, "function with at least three blocks");
  await c.select(f.entry);
  await waitFor(() => document.querySelector(".editor")?.getBoundingClientRect().height, 10000, "decompiler visible");
  c.command({ type: "graph" }); // the graph key is a menu accelerator
  const nodes = () => [...document.querySelectorAll<SVGGElement>('.graph g[role="button"]')];
  await waitFor(() => nodes().length === g.blocks.length, 15000, "one node per block");
  need(nodes().some((n) => n.getAttribute("aria-current")), "the block at the cursor is highlighted");
  const strokes = new Set([...document.querySelectorAll(".graph path[stroke]")].map((p) => p.getAttribute("stroke")));
  need(strokes.has("#5aa0e0") && strokes.has("#e0a93b"), "true (blue) and false (orange) edges drawn: " + [...strokes]);
  const other = g.blocks.find((b) => !nodes().find((n) => n.getAttribute("aria-label") === `Block ${b.start}` && n.getAttribute("aria-current")))!;
  nodes().find((n) => n.getAttribute("aria-label") === `Block ${other.start}`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await waitFor(() => nodes().find((n) => n.getAttribute("aria-label") === `Block ${other.start}`)?.getAttribute("aria-current"), 10000, "clicked block becomes current");
  result.graph = { function: f.name, blocks: g.blocks.length, edges: g.edges.length, cKind: g.blocks.filter((b) => b.kind === "c").length };
  await sleep(300);
  return true;
}

async function barShot(c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  c.command({ type: "search" });
  const rows = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] .hit')].map((r) => r.textContent ?? "");
  await waitFor(() => rows().length > 3, 15000, "suggestions with an empty query");
  const r = rows();
  need(/entry point/.test(r[0]), "entry point first: " + r[0]);
  need(r.some((t) => /used in \d+ places?/.test(t)), "a row says why it ranks: " + r.slice(0, 4).join(" | "));
  result.bar = r.slice(0, 8);
  await sleep(300);
  return true;
}

// shot-map:<coverage file A>:<coverage file B>: a rename plus two coverage runs, then the map's layers
async function mapShot(fl: { name: string; entry: string }[], files: string[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  need(files.length === 2, "two coverage files");
  await c.program().edits.renameSymbol({ address: fl[3].entry, newName: "named_by_me" });
  for (const f of files) { c.command({ type: "coverage-path", path: f }); await sleep(800); }
  c.command({ type: "dock", panel: "coverage" });
  const runB = await waitFor(() => document.querySelector<HTMLSelectElement>('select[aria-label="Run B"]'), 5000, "Run B select"); // the last loaded run is A; compare it with the first
  setSelect(runB!, runB!.options[1].value);
  const map = () => document.querySelector('[aria-label="Binary map"]')?.getAttribute("aria-description") ?? "";
  await waitFor(() => /only in A/.test(map()) && /Renamed functions/.test(map()), 10000, "map layers: " + map());
  need(document.querySelector('[aria-label="Coverage layer"]'), "coverage layer toggle");
  (document.querySelector('[aria-label="Coverage layer"]') as HTMLElement).click();
  await waitFor(() => !/Coverage/.test(map()), 5000, "coverage layer switched off");
  (document.querySelector('[aria-label="Coverage layer"]') as HTMLElement).click();
  await waitFor(() => /only in A/.test(map()), 5000, "coverage layer back on");
  result.map = { description: map() };
  await sleep(300);
  return true;
}

// needs AUTOTEST_EXPORT_DIR (answers the save dialog); the files are checked by whoever runs the flow
async function exportShot(fl: { entry: string }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  await c.program().edits.renameSymbol({ address: fl[3].entry, newName: "renamed_for_export" });
  const flash = () => document.querySelector(".statusbar, footer, [role=status]")?.parentElement?.textContent ?? document.body.textContent ?? "";
  c.command({ type: "export", kind: "symbols" });
  await waitFor(() => /Exported \d+ functions, \d+ labels/.test(flash()), 30000, "symbol map exported");
  c.command({ type: "export", kind: "header" });
  await waitFor(() => /Exported \d+ types and \d+ prototypes/.test(flash()), 30000, "header exported");
  if (c.backend.capabilities.has("exportGzf")) {
    c.command({ type: "export", kind: "gzf" });
    await waitFor(() => /Exported Ghidra archive/.test(flash()), 60000, "gzf exported");
  }
  result.export = flash().match(/Exported [^|]*/g);
  await sleep(300);
  return true;
}

type Fn = { name: string; entry: string; size: number };
const mainRows = () => [...document.querySelectorAll<HTMLElement>(".lbox .lrow.k-main")];

// the Calls panel on a function with callers, callees and a thunk
async function callsShot(fl: Fn[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  let best: { f: Fn; n: number } | null = null;
  for (const f of fl.slice(0, 400)) {
    const r = await c.program().references.calls({ entry: f.entry }).result;
    const n = r.callers.length + r.callees.length + 3 * r.callees.filter((e) => e.thunk).length;
    if (r.callers.length >= 2 && r.callees.some((e) => e.thunk) && (!best || n > best.n)) best = { f, n };
  }
  need(best, "a function with callers and a thunk callee");
  await c.select(best!.f.entry);
  await waitFor(() => c.editorText().length > 0, 20000, "decompiled");
  c.command({ type: "dock", panel: "calls" });
  const region = await waitFor(() => document.querySelector<HTMLElement>('[role="region"][aria-label="Calls"]'), 5000, "calls panel");
  await waitFor(() => /\d+ callers, \d+ callees/.test(region.textContent!) && /thunk/.test(region.textContent!), 10000, "calls with a thunk shown");
  result.calls = { function: best!.f.name, text: region.textContent };
  await sleep(300);
  return true;
}

// a few bookmarks on one function: markers in the listing, the panel under it
async function bookmarksShot(fl: Fn[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const f = fl.find((x) => x.name === "main") ?? [...fl].sort((a, b) => b.size - a.size).find((x) => x.size > 300 && x.size < 3000)!;
  await c.select(f.entry);
  await waitFor(() => c.topAddr() === f.entry && mainRows().length > 12, 15000, "listing at the function");
  const rows = (await c.program().listing.rows({ address: f.entry, count: 14 })).filter((r) => !r.label || r.address !== f.entry);
  const notes: [number, string, string][] = [[2, "triage", "argument parsing starts here"], [6, "todo", "check the length before the copy"], [11, "crypto", "constant looks like a hash seed"]];
  for (const [i, category, comment] of notes) await c.program().bookmarks.set({ address: rows[i].address, category, comment });
  await waitFor(() => document.querySelectorAll(".lbox .bm").length >= 3, 10000, "three markers in the listing");
  c.command({ type: "dock", panel: "bookmarks" });
  const region = await waitFor(() => document.querySelector<HTMLElement>('[role="region"][aria-label="Bookmarks"]'), 5000, "bookmarks panel");
  await waitFor(() => /3 bookmarks/.test(region.textContent!) && /constant looks like/.test(region.textContent!), 10000, "the three notes in the panel");
  result.bookmarks = { function: f.name, addresses: notes.map(([i]) => rows[i].address) };
  await sleep(300);
  return true;
}

// the right-click menu of a listing row
async function copyShot(fl: Fn[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const f = fl.find((x) => x.name === "main") ?? [...fl].sort((a, b) => b.size - a.size).find((x) => x.size > 300 && x.size < 3000)!;
  await c.select(f.entry);
  await waitFor(() => c.topAddr() === f.entry && mainRows().length > 8, 15000, "listing at the function");
  const row = mainRows()[5], box = row.getBoundingClientRect();
  row.click();
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 160, clientY: box.top + 8 }));
  await waitFor(() => document.querySelector(".ctxmenu"), 5000, "context menu");
  result.copy = { menu: [...document.querySelectorAll(".ctxmenu [role=menuitem]")].map((e) => e.textContent) };
  await sleep(300);
  return true;
}

// the function the README screenshots sit on (bash x86-64: FUN_100001a40), else the second in the list; the decompiler showing it
async function at(fl: Fn[], c: AutotestCtx, name: string) {
  const f = fl.find((x) => x.name === name) ?? fl[1];
  await c.select(f.entry);
  await waitFor(() => c.editorText().length > 0, 30000, "decompiled " + f.name);
  return f;
}

// the start screen with the programs already in the projects dir
async function startShot(c: AutotestCtx): Promise<boolean> {
  await waitFor(() => /Programs in this project/.test(document.body.textContent ?? ""), 15000, "program list");
  await sleep(1500);
  return true;
}

// the import card of a file not yet in the project (sections and entropy loaded)
async function importShot(file: string, c: AutotestCtx): Promise<boolean> {
  await waitFor(() => /Programs in this project/.test(document.body.textContent ?? ""), 15000, "start screen");
  c.command({ type: "open-path", path: file });
  await waitFor(() => document.querySelector('[role="dialog"][aria-label="Import binary"] table[aria-label="Sections"]'), 60000, "import card with sections");
  await sleep(800);
  return true;
}

// a fresh import: the workspace and a decompiled function while the analysis still runs
async function analysisShot(file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  await c.openBg(file);
  await waitFor(() => c.funcCount() > 1500, 180000, "most functions found");
  const fl = (await c.program().functions.list()).filter((f) => /^FUN_/.test(f.name) && f.size > 300);
  await at(fl, c, "");
  need(c.analysis()?.state === "running", "analysis still running");
  await sleep(1500);
  result.analysis = c.analysis();
  return true;
}

// shot-debugger:<gdbstub port>, AUTOTEST=sidecar/testdata/fw/fw.bin, with `qemu-system-arm -M lm3s6965evb -kernel fw.bin -S -gdb tcp::<port> -display none` running:
// the Cortex-M test image imported raw at 0, its functions created (addresses from sidecar/testdata/fw/build.sh), attached, a breakpoint in scale() hit twice.
async function debuggerShot(file: string, args: string[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const port = Number(args[0]);
  need(port > 0, "the gdbstub port: shot-debugger:<port>");
  await c.openBg(file, { loader: "Raw Binary", language: "ARM:LE:32:Cortex", baseAddress: "0x0" });
  await waitFor(() => c.analysis()?.state === "done", 120000, "analysis done");
  const ops = c.program(), size = (await ops.listing.info()).totalBytes;
  await ops.edits.clearCode({ address: "0x8", length: size - 8 }); // the analysis left data after the vector table
  for (const [address, name] of [["0x8", "work_a"], ["0x18", "work_b"], ["0x28", "main_loop"], ["0x54", "scale"], ["0xa4", "fact"]]) {
    await ops.edits.createFunction({ address, name }).catch(() => ops.edits.renameSymbol({ address, newName: name })); // a call target is already a function (FUN_...): name it
  }
  await ops.history.save(); // no "unsaved changes" in the status bar
  const scale = (await ops.functions.list()).find((f) => f.name === "scale");
  need(scale, "scale() exists");
  await c.select(scale!.entry);
  await waitFor(() => document.querySelector(".editor .view-line"), 15000, "decompiler text");
  const bp = "0x" + (BigInt(scale!.entry) + 2n).toString(16); // after its sub sp
  await ops.debug.attach({ host: "127.0.0.1", port });
  await waitFor(() => c.debug()?.state === "stopped", 15000, "stopped after attach");
  await ops.debug.breakpoint({ address: bp });
  for (let hit = 1; hit <= 2; hit++) { // the second stop gives the values something to have been
    const before = c.debug()!.stop;
    c.command({ type: "debug", action: "continue" });
    await waitFor(() => c.debug()?.state === "stopped" && c.debug()!.stop > before, 15000, `breakpoint hit ${hit}`);
    await waitFor(() => c.debug()?.values, 15000, `the variables at hit ${hit}`); // the next stop compares with this one
  }
  need(c.debug()!.address === bp, "stopped at the breakpoint: " + c.debug()!.address);
  c.command({ type: "dock", panel: "locals" });
  const q = (sel: string) => document.querySelectorAll(sel).length;
  await waitFor(() => q(".vals tbody tr") > 0 && q(".vals tr.changed") > 0 && q(".dval") > 0 && q(".dpc") > 0, 15000, "locals, values after the lines, the current line");
  need(q(".lrow.pc") === 1 && q(".lrow.bp") === 1 && q(".lrow.stmt") > 0, "current row, breakpoint and the statement's instructions in the listing");
  result.debugger = { address: c.debug()!.address, stops: c.debug()!.stop, locals: q(".vals tbody tr"), changed: q(".vals tr.changed") };
  await sleep(500);
  return true;
}

async function overviewShot(fl: Fn[], c: AutotestCtx): Promise<boolean> {
  await at(fl, c, "_mysql_real_escape_string_quote");
  await sleep(1500);
  return true;
}

// the command bar in action mode (">")
async function actionsShot(fl: Fn[], c: AutotestCtx): Promise<boolean> {
  await at(fl, c, "FUN_100001a40");
  c.command({ type: "search" });
  const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Symbol or action"]'), 5000, "command bar");
  typeInto(input, ">");
  await waitFor(() => document.querySelectorAll('[role="listbox"] [role="option"]').length > 5, 5000, "actions listed");
  await sleep(500);
  return true;
}

async function stringsShot(fl: Fn[], c: AutotestCtx): Promise<boolean> {
  await at(fl, c, "FUN_100001a40");
  c.command({ type: "dock", panel: "strings" });
  await waitFor(() => /^\d+ strings$/.test(document.querySelector('[aria-label="String count"]')?.textContent ?? ""), 60000, "strings counted");
  await sleep(1000);
  return true;
}

// the Data Type Manager on Mach-O's segment_command
async function dataTypesShot(c: AutotestCtx): Promise<boolean> {
  c.command({ type: "datatypes" });
  const filter = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Filter data types"]'), 10000, "data type manager");
  typeInto(filter, "segment");
  const row = await waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => /segment_command\b/.test(r.textContent ?? "") && !/64/.test(r.textContent ?? "")), 15000, "segment_command listed");
  row.click();
  await waitFor(() => /struct segment_command/.test(document.querySelector('[aria-label="Data Type Manager"]')?.textContent ?? ""), 10000, "struct shown");
  await sleep(800);
  return true;
}

// shot-callgraph:<coverage file>: one coverage run loaded (ran / never ran), the call graph of a function with several callers
async function callGraphShot(fl: Fn[], files: string[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  for (const f of files) { c.command({ type: "coverage-path", path: f }); await sleep(800); }
  await quiet();
  const f = await at(fl, c, "FUN_10000254b");
  c.command({ type: "callgraph" });
  await waitFor(() => /callers above/.test(document.body.textContent ?? ""), 15000, "call graph");
  await sleep(2000);
  result.callgraph = f.name;
  return true;
}

// shot-coverage:<run A>:<run B>: two runs compared in the listing and decompiler, the Coverage tab open
async function coverageShot(fl: Fn[], files: string[], c: AutotestCtx): Promise<boolean> {
  need(files.length === 2, "two coverage files");
  for (const f of files) { c.command({ type: "coverage-path", path: f }); await sleep(800); }
  await quiet();
  await at(fl, c, "FUN_100001a40");
  c.command({ type: "dock", panel: "coverage" });
  const pick = async (label: string, file: string) => {
    const sel = await waitFor(() => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`), 5000, label);
    const o = await waitFor(() => [...sel.options].find((x) => x.text === file.split("/").pop()), 5000, `${label} option`);
    setSelect(sel, o.value);
  };
  await pick("Run A", files[0]);
  await pick("Run B", files[1]);
  await waitFor(() => /only A .* only B/.test(document.querySelector('[role="region"][aria-label="Coverage"], .panel')?.parentElement?.textContent ?? document.body.textContent ?? ""), 10000, "A and B compared");
  await sleep(1000);
  return true;
}

// the "Coverage … loaded" notice in the status bar has gone
const quiet = () => waitFor(() => !/loaded/.test(document.querySelector(".status")?.textContent ?? ""), 30000, "status bar notice gone");

// the warnings bar above the C: a function whose decompile carries warnings
async function warningsShot(fl: { name: string; entry: string; size: number }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  let pick: { entry: string; name: string; warnings: string[] } | undefined;
  for (const f of [...fl].sort((a, b) => b.size - a.size).slice(0, 150)) {
    if (f.size > 30000) continue;
    const d = await c.program().decompiler.decompile({ entry: f.entry, timeoutSecs: 60 }).result.catch(() => null);
    if (d?.warnings?.length) { pick = { entry: f.entry, name: f.name, warnings: d.warnings }; break; }
  }
  need(pick, "a function with decompiler warnings");
  await c.select(pick!.entry);
  const bar = await waitFor(() => document.querySelector<HTMLElement>(".dwarn"), 15000, "warnings bar");
  need(bar!.querySelectorAll(".dw").length >= 1, "a warning line");
  result.warnings = { function: pick!.name, shown: [...bar!.querySelectorAll(".dw")].map((e) => e.textContent) };
  await sleep(300);
  return true;
}

async function hexShot(fl: { entry: string }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  await c.goAddr(fl[0].entry);
  const row = await waitFor(() => document.querySelectorAll<HTMLElement>(".lbox .lrow.k-main")[2], 10000, "listing rows");
  row.click(); await sleep(100);
  c.command({ type: "dock", panel: "hex" });
  const region = await waitFor(() => byLabel<HTMLElement>("region", "Bytes"), 5000, "bytes pane");
  await waitFor(() => region.querySelectorAll(".hx-b.cur").length > 0 && ![...region.querySelectorAll(".hx-b")].some((e) => e.textContent === "··"), 10000, "bytes loaded");
  result.hex = { rows: region.querySelectorAll(".hx-row").length, cursorBytes: region.querySelectorAll(".hx-bytes .hx-b.cur").length };
  await sleep(300);
  return true;
}

async function patchShot(fl: { entry: string }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  need(c.backend.capabilities.has("patch"), "provider has no patch capability");
  await c.goAddr(fl[0].entry);
  const row = await waitFor(() => document.querySelectorAll<HTMLElement>(".lbox .lrow.k-main")[4], 10000, "listing rows");
  row.click(); document.querySelector<HTMLElement>(".lbox")!.focus(); await sleep(100);
  c.command({ type: "dock", panel: "hex" });
  c.command({ type: "edit", action: "patch" });
  const dlg = await waitFor(() => byLabel("dialog", "Patch instruction"), 5000, "patch dialog");
  typeInto(dlg.querySelector<HTMLInputElement>('input[aria-label="Instruction"]')!, "NOP");
  const preview = () => dlg.querySelector('[aria-label="Preview"]')!.textContent ?? "";
  await waitFor(() => /replaces/.test(preview()), 60000, "the preview");
  result.patch = { preview: preview() };
  await sleep(300);
  return true;
}

async function pcodeShot(fl: { name: string; entry: string; size: number }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  need(c.backend.capabilities.has("pcode"), "provider has no pcode capability");
  const f = fl.find((x) => x.name === "main") ?? [...fl].sort((a, b) => a.size - b.size).find((x) => x.size > 300)!;
  await c.select(f.entry);
  await waitFor(() => c.editorText().length > 0, 20000, "decompiled text");
  c.command({ type: "pcode" });
  const region = await waitFor(() => byLabel<HTMLElement>("region", "P-code"), 10000, "p-code pane");
  await waitFor(() => /ops/.test(region.querySelector('[aria-label="P-code state"]')!.textContent ?? ""), 30000, "high p-code");
  result.pcode = { function: f.name, state: region.querySelector('[aria-label="P-code state"]')!.textContent, rows: region.querySelectorAll(".pc-line").length };
  await sleep(300);
  return true;
}

async function layoutShot(fl: { entry: string }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  await c.select(fl[0].entry);
  await waitFor(() => c.editorText().length > 0, 20000, "decompiled text");
  c.command({ type: "pane-move", pane: "decompiler", dir: -1 });
  c.command({ type: "dock", panel: "hex" });
  c.command({ type: "search" });
  const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Symbol or action"]'), 5000, "command bar");
  typeInto(input, ">layout");
  await waitFor(() => [...document.querySelectorAll('[role="listbox"] .hit')].some((e) => /Layout: Default/.test(e.textContent ?? "")), 5000, "Layout: Default in the command bar");
  result.layout = { actions: [...document.querySelectorAll('[role="listbox"] .hit .n')].map((e) => e.textContent) };
  await sleep(300);
  return true;
}

async function trailShot(fl: { name: string; entry: string; size: number }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  need(c.backend.capabilities.has("valueTrail"), "provider has no valueTrail capability");
  for (const f of [...fl].sort((a, b) => a.size - b.size).filter((x) => x.size > 80).slice(0, 60)) {
    const d = await c.program().decompiler.decompile({ entry: f.entry }).result;
    for (const tok of d.tokens.filter((t) => t.kind === "param" && t.varName && t.line > 1 && !t.varAddress)) {
      const want = await c.program().decompiler.valueTrail({ entry: f.entry, name: tok.varName, line: tok.line, colStart: tok.colStart }).result;
      if (want.ops.filter((o) => o.dir === "forward").length < 3) continue;
      await c.select(f.entry);
      await waitFor(() => c.editorText().length > 0, 20000, "decompiled text");
      const ed = c.editor();
      ed.setPosition({ lineNumber: tok.line + 1, column: tok.colStart + 2 }); ed.focus(); await sleep(150);
      c.command({ type: "trail" });
      await waitFor(() => document.querySelector('[aria-label="Value trail"]'), 20000, "trail status");
      result.trail = { function: f.name, variable: tok.varName, status: document.querySelector('[aria-label="Value trail"]')!.textContent };
      await sleep(400);
      return true;
    }
  }
  throw new Error("shot: no parameter with a trail");
}

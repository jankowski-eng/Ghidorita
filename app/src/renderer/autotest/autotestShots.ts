import { press, setSelect, sleep, waitFor, type AutotestCtx } from "./autotest";

// Screenshot flows (AUTOTEST=/bin/ls AUTOTEST_FLOW=shot-<name> npm start): arrange one UI state through the real DOM, check it, and end there;
// the autotest's last act is app/out/screenshot.png.
const need = (ok: unknown, what: string) => { if (!ok) throw new Error("shot: " + what); };

export async function runShotFlow(name: string, file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const [flow, ...args] = name.split(":"); name = flow;
  const fl = await c.open(file);
  need(fl?.length, "no functions");
  if (name === "shot-graph") return graphShot(fl!, c, result);
  if (name === "shot-map") return mapShot(fl!, args, c, result);
  if (name === "shot-export") return exportShot(fl!, c, result);
  if (name === "shot-bar") return barShot(c, result);
  if (name === "shot-calls") return callsShot(fl!, c, result);
  if (name === "shot-bookmarks") return bookmarksShot(fl!, c, result);
  if (name === "shot-copy") return copyShot(fl!, c, result);
  throw new Error("unknown shot flow " + name);
}

async function graphShot(fl: { name: string; entry: string; size: number }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const f = fl.find((x) => x.name === "main") ?? [...fl].sort((a, b) => a.size - b.size).find((x) => x.size > 300)!;
  const g = await c.program().decompiler.graph({ entry: f.entry }).result;
  need(g.blocks.length >= 3, "function with at least three blocks");
  await c.select(f.entry);
  await waitFor(() => document.querySelector(".editor")?.getBoundingClientRect().height, 10000, "decompiler visible");
  press(document.body, " ");
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

import { rpc } from "./client";
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
  if (name === "shot-bar") return barShot(c, result);
  throw new Error("unknown shot flow " + name);
}

async function graphShot(fl: { name: string; entry: string; size: number }[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const f = fl.find((x) => x.name === "main") ?? [...fl].sort((a, b) => a.size - b.size).find((x) => x.size > 300)!;
  const g = await rpc.call("function_graph", { entry: f.entry });
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
  await rpc.call("rename_symbol", { address: fl[3].entry, newName: "named_by_me" });
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

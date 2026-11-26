import { rpc } from "./client";
import { press, sleep, waitFor, type AutotestCtx } from "./autotest";

// Screenshot flows (AUTOTEST=/bin/ls AUTOTEST_FLOW=shot-<name> npm start): arrange one UI state through the real DOM, check it, and end there;
// the autotest's last act is app/out/screenshot.png.
const need = (ok: unknown, what: string) => { if (!ok) throw new Error("shot: " + what); };

export async function runShotFlow(name: string, file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const fl = await c.open(file);
  need(fl?.length, "no functions");
  if (name === "shot-graph") return graphShot(fl!, c, result);
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

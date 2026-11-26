export interface LNode { id: string; w: number; h: number }
export interface LEdge { from: string; to: string }

/**
 * Layered layout (top-left corners): back edges found by a DFS from `root` are ignored, a node sits one layer below its deepest
 * predecessor, rows are ordered by a few barycenter sweeps and centred on the widest row.
 * shortcut: no dummy nodes, so an edge across several layers is drawn straight and can pass behind a node; upgrade with virtual nodes per skipped layer.
 */
export function layout(nodes: LNode[], edges: LEdge[], root: string, gapX = 28, gapY = 44): { pos: Map<string, { x: number; y: number }>; width: number; height: number } {
  const ids = new Set(nodes.map((n) => n.id)), out = new Map<string, string[]>(), back = new Set<string>();
  for (const n of nodes) out.set(n.id, []);
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) out.get(e.from)!.push(e.to);
  const state = new Map<string, 1 | 2>(), post: string[] = [];
  const dfs = (v: string) => {
    state.set(v, 1);
    for (const w of out.get(v)!) { if (state.get(w) === 1) back.add(v + "\0" + w); else if (!state.has(w)) dfs(w); }
    state.set(v, 2); post.push(v);
  };
  for (const id of [root, ...nodes.map((n) => n.id)]) if (ids.has(id) && !state.has(id)) dfs(id);
  const down = new Map<string, string[]>(), up = new Map<string, string[]>();
  for (const n of nodes) { down.set(n.id, []); up.set(n.id, []); }
  for (const [v, ws] of out) for (const w of ws) if (!back.has(v + "\0" + w)) { down.get(v)!.push(w); up.get(w)!.push(v); }
  const layer = new Map<string, number>();
  for (const v of post.reverse()) layer.set(v, Math.max(0, ...up.get(v)!.map((u) => layer.get(u)! + 1)));
  const rows: string[][] = [];
  for (const n of nodes) (rows[layer.get(n.id)!] ??= []).push(n.id);
  const idx = new Map<string, number>(), reindex = () => rows.forEach((r) => r.forEach((v, i) => idx.set(v, i)));
  reindex();
  const sweep = (r: string[], adj: Map<string, string[]>) => {
    const bc = (v: string) => { const a = adj.get(v)!; return a.length ? a.reduce((s, u) => s + idx.get(u)!, 0) / a.length : idx.get(v)!; };
    const key = new Map(r.map((v) => [v, bc(v)]));
    r.sort((a, b) => key.get(a)! - key.get(b)!); r.forEach((v, i) => idx.set(v, i));
  };
  for (let k = 0; k < 4; k++) { for (let i = 1; i < rows.length; i++) sweep(rows[i], up); for (let i = rows.length - 2; i >= 0; i--) sweep(rows[i], down); }
  const size = new Map(nodes.map((n) => [n.id, n]));
  const widths = rows.map((r) => r.reduce((s, v) => s + size.get(v)!.w, 0) + gapX * (r.length - 1)), width = Math.max(0, ...widths);
  const pos = new Map<string, { x: number; y: number }>();
  let y = 0;
  rows.forEach((r, i) => {
    let x = (width - widths[i]) / 2;
    for (const v of r) { pos.set(v, { x, y }); x += size.get(v)!.w + gapX; }
    y += Math.max(...r.map((v) => size.get(v)!.h)) + gapY;
  });
  return { pos, width, height: Math.max(0, y - gapY) };
}

/** The block containing `addr` (blocks as in function_graph); default-space addresses compare numerically, others only match a block start. */
export function blockAt<B extends { start: string; end: string }>(blocks: B[], addr: string | null): B | undefined {
  if (!addr) return undefined;
  if (!addr.startsWith("0x")) return blocks.find((b) => b.start === addr);
  const a = BigInt(addr);
  return blocks.find((b) => b.start.startsWith("0x") && BigInt(b.start) <= a && a <= BigInt(b.end));
}

/** Drops the indentation every line of a block shares (decompiler lines keep their nesting depth, which pushes short blocks far right). */
export function dedent(lines: string[]): string[] {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return Number.isFinite(ind) && ind > 0 ? lines.map((l) => l.slice(ind)) : lines;
}

export const READABLE = 0.7; // below this zoom the 12px block text is no longer readable

/** Where the graph opens: the whole graph if it fits at a readable zoom, else 1:1 with `focus` (the cursor's block) centred horizontally near the top. */
export function initialView(size: { w: number; h: number }, top: number, graph: { width: number; height: number }, focus?: { x: number; y: number; w: number }) {
  const fit = Math.min(1, (size.w - 24) / Math.max(graph.width, 1), (size.h - top - 12) / Math.max(graph.height, 1));
  if (fit >= READABLE || !focus) return { k: fit, x: (size.w - graph.width * fit) / 2, y: top };
  return { k: 1, x: size.w / 2 - (focus.x + focus.w / 2), y: top + 12 - focus.y };
}

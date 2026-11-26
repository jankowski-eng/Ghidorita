import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, FunctionGraph } from "../../../protocol";
import { coverage } from "./coverage";
import { blockAt, dedent, initialView, layout } from "./graphLayout";
import type { Decompilation } from "./backend";

const CW = 7.3, LH = 15, PAD = 8, MAXC = 90, MAXL = 40; // character width / line height of the 12px monospace, padding, caps per node
const EDGE = { true: "#5aa0e0", false: "#e0a93b", uncond: "#888" } as const; // blue / orange / neutral: no red-green
const COV: Record<string, string> = { " cov": "#4ec36b", " cov-a": "#e0a93b", " cov-b": "#5aa0e0" };
const cut = (s: string) => (s.length > MAXC ? s.slice(0, MAXC - 1) + "…" : s);

/** Control-flow graph of the function at `entry`: one node per basic block (C where the decompiler maps it, else assembly). Wheel zooms, drag pans, click a node to go there. */
export function GraphView({ source, entry, here, version, covVersion, onGo }: { source: Decompilation["graph"]; entry: Address; here: Address | null; version: number; covVersion: number; onGo: (a: Address) => void }) {
  const [g, setG] = useState<FunctionGraph | null>(null), [err, setErr] = useState("");
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const box = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    setErr("");
    const job = source({ entry });
    job.result.then((r) => { if (live) setG(r); }, (e) => { if (live) { setG(null); setErr(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; job.cancel(); };
  }, [source, entry, version]);
  const L = useMemo(() => {
    if (!g) return null;
    const nodes = g.blocks.map((b) => { const ls = dedent(b.lines.slice(0, MAXL)).map(cut); return { id: b.start, b, ls, more: b.lines.length > MAXL, w: Math.max(40, ...ls.map((l) => l.length)) * CW + 2 * PAD, h: (ls.length + (b.lines.length > MAXL ? 1 : 0)) * LH + 2 * PAD }; });
    return { nodes, ...layout(nodes, g.edges, entry) };
  }, [g, entry]);
  const cur = g ? blockAt(g.blocks, here)?.start : undefined;
  const TOP = 28; // below the legend row, so the first block never covers it
  const focusOf = (id?: string) => { const n = L?.nodes.find((x) => x.id === (id ?? entry)) ?? L?.nodes[0], p = n && L!.pos.get(n.id); return n && p ? { x: p.x, y: p.y, w: n.w } : undefined; };
  const show = (mode: "auto" | "fit" | "1:1") => {
    const el = box.current;
    if (!L || !el) return;
    const size = { w: el.clientWidth, h: el.clientHeight }, focus = focusOf(cur);
    setView(initialView(size, TOP, mode === "1:1" ? { width: Infinity, height: Infinity } : L, mode === "fit" ? undefined : focus));
  };
  useEffect(() => show("auto"), [L]); // eslint-disable-line -- a new graph: whole graph if readable, else 1:1 at the cursor's block
  useEffect(() => { // the cursor moved to a block off screen: bring it into view at the current zoom
    const el = box.current, f = focusOf(cur);
    if (!el || !f || !cur) return;
    setView((v) => { const sx = v.x + (f.x + f.w / 2) * v.k, sy = v.y + f.y * v.k; return sx >= 0 && sx <= el.clientWidth && sy >= TOP && sy <= el.clientHeight - 20 ? v : { ...v, x: el.clientWidth / 2 - (f.x + f.w / 2) * v.k, y: TOP + 12 - f.y * v.k }; });
  }, [cur]); // eslint-disable-line
  useEffect(() => {
    const el = box.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, f = Math.exp(-e.deltaY * 0.0015);
      setView((v) => { const k = Math.min(4, Math.max(0.05, v.k * f)); return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }; });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  const mark = (b: { start: string; end: string }) => {
    if (!coverage.shown || !b.start.startsWith("0x")) return "";
    return coverage.mark(b.start as Address, Number(BigInt(b.end) - BigInt(b.start) + 1n));
  };
  void covVersion; // re-render when the coverage runs change
  return (
    <div className="graph" ref={box} tabIndex={0} aria-label="Control-flow graph" role="img" aria-description="Basic blocks of the current function; Space returns to the decompiler"
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
      onPointerMove={(e) => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true; if (d.moved) { d.x = e.clientX; d.y = e.clientY; setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })); } }}
      onPointerUp={() => { setTimeout(() => { drag.current = null; }); }}>
      {!g && !err && <div className="empty">Building graph…</div>}
      {err && <div className="empty err">{err}</div>}
      <div className="glegend" aria-label="Legend"><span style={{ color: EDGE.true }}>── true</span> <span style={{ color: EDGE.false }}>── false</span> <span>── jump</span>
        <button className="gbtn" onPointerDown={(e) => e.stopPropagation()} onClick={() => show("fit")} title="Show the whole graph">Fit</button>
        <button className="gbtn" onPointerDown={(e) => e.stopPropagation()} onClick={() => show("1:1")} title="Actual size at the cursor's block">1:1</button></div>
      {g && L && (
        <svg width="100%" height="100%">
          <defs>{(Object.keys(EDGE) as (keyof typeof EDGE)[]).map((k) => <marker key={k} id={`ah-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L8 4L0 8z" fill={EDGE[k]} /></marker>)}</defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {g.edges.map((e, i) => {
              const a = L.pos.get(e.from), b = L.pos.get(e.to), na = L.nodes.find((n) => n.id === e.from), nb = L.nodes.find((n) => n.id === e.to);
              if (!a || !b || !na || !nb) return null;
              const x1 = a.x + na.w / 2, y1 = a.y + na.h, x2 = b.x + nb.w / 2, y2 = b.y, dy = Math.max(30, Math.abs(y2 - y1) / 2);
              return <path key={i} d={`M${x1} ${y1} C${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`} fill="none" stroke={EDGE[e.kind]} strokeWidth={1.5} markerEnd={`url(#ah-${e.kind})`} />;
            })}
            {L.nodes.map((n) => {
              const p = L.pos.get(n.id)!, m = mark(n.b);
              return (
                <g key={n.id} transform={`translate(${p.x} ${p.y})`} role="button" aria-label={`Block ${n.b.start}`} aria-current={n.id === cur ? "true" : undefined} style={{ cursor: "pointer" }}
                  onClick={() => { if (!drag.current?.moved) onGo(n.b.start); }}>
                  <rect width={n.w} height={n.h} rx={4} fill={n.id === cur ? "#094771" : "#252526"} stroke={n.id === cur ? "#9cdcfe" : COV[m] ?? "#555"} strokeWidth={n.id === cur || m ? 2 : 1} />
                  {m && <text x={n.w - 6} y={12} textAnchor="end" fontSize={10} fontWeight={700} fill={COV[m]}>{m === " cov-a" ? "A" : m === " cov-b" ? "B" : ""}</text>}
                  {n.ls.map((l, i) => <text key={i} x={PAD} y={PAD + (i + 1) * LH - 4} xmlSpace="preserve" fontFamily="Menlo, monospace" fontSize={12} fill="#d4d4d4" style={{ whiteSpace: "pre" }}>{l}</text>)}
                  {n.more && <text x={PAD} y={PAD + (n.ls.length + 1) * LH - 4} fontFamily="Menlo, monospace" fontSize={12} fill="#888">…</text>}
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

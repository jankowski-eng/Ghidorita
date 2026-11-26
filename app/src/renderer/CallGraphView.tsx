import { useEffect, useMemo, useState } from "react";
import { scanner } from "./scan";
import type { Address, CallGraph, FunctionInfo } from "../../../protocol";
import type { References } from "./backend";
import { coverage } from "./coverage";
import { initialView, layout } from "./graphLayout";
import { nodeInfo } from "./callGraph";
import { COLORS, covStyle, dotOf } from "./palette";
import { usePanZoom } from "./usePanZoom";

const CW = 7.3, LH = 15, PAD = 8, TOP = 34; // 12px monospace character width, line height, node padding, room for the bar above

/**
 * Call graph around the function at `entry`: callers above, callees below (two calls each way), or with a target the routes from entry to it
 * (the shortest and those one call longer).
 * Nodes show who named the function and, when coverage is loaded, whether a run reached it; imports are dashed leaves. Click a node to go there.
 */
export function CallGraphView({ source, entry, funcs, version, covVersion, onGo }: { source: References["callGraph"]; entry: Address; funcs: FunctionInfo[]; version: number; covVersion: number; onGo: (a: Address) => void }) {
  const [g, setG] = useState<CallGraph | null>(null), [err, setErr] = useState("");
  const [to, setTo] = useState<Address | null>(null), [text, setText] = useState("");
  const { box, view, setView, handlers, moved } = usePanZoom();
  const byEntry = useMemo(() => new Map(funcs.map((f) => [f.entry, f])), [funcs]);
  useEffect(() => {
    let live = true;
    const sc = scanner();
    setErr("");
    sc.run(source(to ? { entry, to } : { entry })).then((r) => { if (live) setG(r); }, (e) => { if (live) { setG(null); setErr(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; sc.cancelAll(); }; // the function, the target or the program changed: the sidecar stops walking for the obsolete request
  }, [source, entry, to, version]);
  const L = useMemo(() => {
    if (!g) return null;
    void covVersion; // coverage marks change the second line
    const nodes = g.nodes.map((n) => { const i = nodeInfo(n, byEntry.get(n.entry), coverage); return { id: n.entry, n, ...i, w: Math.max(n.name.length, i.sub.length, 6) * CW + 2 * PAD + 22, h: (i.sub ? 2 : 1) * LH + 2 * PAD }; });
    return { nodes, byId: new Map(nodes.map((x) => [x.id, x])), ...layout(nodes, g.edges, entry, 36, 56) };
  }, [g, entry, byEntry, covVersion]);
  const show = (fit: boolean) => {
    const el = box.current, p = L?.pos.get(entry), n = L?.byId.get(entry);
    if (L && el) setView(initialView({ w: el.clientWidth, h: el.clientHeight }, TOP, fit ? L : { width: Infinity, height: Infinity }, !fit && p && n ? { x: p.x, y: p.y, w: n.w } : undefined));
  };
  useEffect(() => { // whole graph if it stays readable, else 1:1 on the function itself
    const el = box.current, p = L?.pos.get(entry), n = L?.byId.get(entry);
    if (L && el) setView(initialView({ w: el.clientWidth, h: el.clientHeight }, TOP, L, p && n ? { x: p.x, y: p.y, w: n.w } : undefined));
  }, [L]); // eslint-disable-line
  const pick = () => {
    const t = text.trim(), f = funcs.find((f) => f.name === t) ?? funcs.find((f) => f.name.toLowerCase() === t.toLowerCase()) ?? funcs.find((f) => f.entry === t.toLowerCase());
    if (f) { setTo(f.entry); setErr(""); } else setErr(`No function named ${t}`);
  };
  const hints = useMemo(() => { const t = text.trim().toLowerCase(); return t.length < 2 ? [] : funcs.filter((f) => f.name.toLowerCase().includes(t)).slice(0, 50); }, [text, funcs]);
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  const noRoute = !!to && !!g && g.edges.length === 0 && to !== entry;
  return (
    <div className="graph" ref={box} tabIndex={0} aria-label="Call graph" role="img" aria-description="Callers above, callees below; with a target, every route to it" {...handlers}>
      <div className="glegend cgbar" aria-label="Call graph controls">
        <span>{to ? `routes to ${byEntry.get(to)?.name ?? to}` : "callers above · callees below"}</span>
        <input aria-label="Route target" placeholder="routes to function…" list="cg-targets" value={text} onPointerDown={stop}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") pick(); }} />
        <datalist id="cg-targets">{hints.map((f) => <option key={f.entry} value={f.name} />)}</datalist>
        <button className="gbtn" onPointerDown={stop} onClick={pick} disabled={!text.trim()}>Find routes</button>
        {to && <button className="gbtn" onPointerDown={stop} onClick={() => { setTo(null); setText(""); }}>Clear</button>}
        <button className="gbtn" onPointerDown={stop} onClick={() => show(true)} title="Show the whole graph">Fit</button>
        <button className="gbtn" onPointerDown={stop} onClick={() => show(false)} title="Actual size at this function">1:1</button>
        {g?.truncated && <span className="dim">(partial: size or time limit)</span>}
      </div>
      {!g && !err && <div className="empty">Building call graph…</div>}
      {err && <div className="empty err">{err}</div>}
      {noRoute && <div className="empty">No route from this function to {byEntry.get(to!)?.name ?? to} within 10 calls.</div>}
      {g && L && (
        <svg width="100%" height="100%">
          <defs><marker id="cg-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L8 4L0 8z" fill="#888" /></marker></defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {g.edges.map((e, i) => {
              const a = L.pos.get(e.from), b = L.pos.get(e.to), na = L.byId.get(e.from), nb = L.byId.get(e.to);
              if (!a || !b || !na || !nb || e.from === e.to) return null;
              const x1 = a.x + na.w / 2, y1 = a.y + na.h, x2 = b.x + nb.w / 2, y2 = b.y, dy = Math.max(30, Math.abs(y2 - y1) / 2);
              // an edge that skips a row would run behind the nodes in between: bow it out to the side
              const off = y2 - y1 > 130 ? (x2 >= x1 ? 1 : -1) * (Math.max(na.w, nb.w) / 2 + 40) : 0;
              return (<g key={i}>
                <path d={`M${x1} ${y1} C${x1 + off} ${y1 + dy} ${x2 + off} ${y2 - dy} ${x2} ${y2}`} fill="none" stroke={to ? COLORS.attention : "#888"} strokeWidth={1.5} markerEnd="url(#cg-ah)" />
                {e.sites > 1 && <text x={(x1 + x2) / 2 + off * 0.75 + 4} y={(y1 + y2) / 2} fontSize={12} fill="#aaa">×{e.sites}</text>}
              </g>);
            })}
            {L.nodes.map((x) => {
              const p = L.pos.get(x.id)!, root = x.id === entry, target = x.id === to, cs = covStyle(x.cov), isImport = x.n.kind === "import", dot = dotOf(isImport ? "imported" : byEntry.get(x.id)?.source);
              return (
                <g key={x.id} transform={`translate(${p.x} ${p.y})`} role="button" aria-label={`${x.n.name}${x.sub ? ", " + x.sub : ""}`} aria-current={root ? "true" : undefined}
                  style={{ cursor: x.n.kind === "import" ? "default" : "pointer" }} onClick={() => { if (!moved() && x.n.kind !== "import" && !root) onGo(x.id); }}>
                  <rect width={x.w} height={x.h} rx={4} fill={root ? "#094771" : "#252526"} stroke={target ? COLORS.attention : root ? "#9cdcfe" : cs?.color ?? (isImport ? COLORS.library : "#555")}
                    strokeWidth={root || target || x.cov ? 2 : 1} strokeDasharray={isImport ? "4 3" : cs?.hatched ? "5 3" : undefined} opacity={x.ran === false ? 0.55 : 1} />
                  {(isImport || byEntry.has(x.id)) && <circle cx={x.w - 9} cy={9} r={4} fill={dot.shape === "solid" ? dot.color : "none"} stroke={dot.color} strokeWidth={1.5} strokeDasharray={dot.shape === "dashed" ? "2 1.5" : undefined}><title>{dot.label}</title></circle>}
                  {cs?.letter && <text x={x.w - 22} y={13} textAnchor="end" fontSize={12} fontWeight={700} fill={cs.color}>{cs.letter}</text>}
                  <text x={PAD} y={PAD + LH - 4} fontFamily="Menlo, monospace" fontSize={12} fill={x.n.kind === "import" ? "#9cdcfe" : "#d4d4d4"}>{x.n.name}</text>
                  {x.sub && <text x={PAD} y={PAD + 2 * LH - 4} fontFamily="Menlo, monospace" fontSize={12} fill={x.ran === false ? COLORS.attention : cs?.letter ? cs.color : "#888"}>{x.sub}</text>}
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

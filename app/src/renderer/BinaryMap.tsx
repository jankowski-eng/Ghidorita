import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, FunctionInfo } from "../../../protocol";
import type { AddrMap } from "./addrmap";
import { describeAt, fill, mapLayers, type Layer } from "./binmap";
import { coverage } from "./coverage";

/** Vertical map of the whole program next to the function list: top = first loaded byte, bottom = last. Click or drag to go there; a line marks the current address. */
export function BinaryMap({ map, funcs, here, covVersion, onGo }: { map: AddrMap; funcs: FunctionInfo[]; here: Address | null; covVersion: number; onGo: (a: Address) => void }) {
  const [on, setOn] = useState({ renamed: true, coverage: true }); // which optional layers are drawn
  const box = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const [h, setH] = useState(0);
  const drag = useRef(false);
  const [tip, setTip] = useState<{ y: number; text: string } | null>(null);
  useEffect(() => { const el = box.current!; const ro = new ResizeObserver(() => setH(Math.floor(el.clientHeight))); ro.observe(el); setH(Math.floor(el.clientHeight)); return () => ro.disconnect(); }, []);
  const all = useMemo<Layer[]>(() => {
    const a = coverage.get(coverage.a), b = coverage.get(coverage.b);
    return mapLayers(map, funcs, on, { a: a && { name: a.name, spans: a.cov.spans() }, b: b && { name: b.name, spans: b.cov.spans() } });
  }, [map, funcs, on, covVersion]); // eslint-disable-line
  const fills = useMemo(() => all.map((l) => fill(map.total, l.spans, Math.max(1, h))), [all, map, h]);
  const pos = here ? map.posOf(here) : -1;
  useEffect(() => {
    const c = cv.current; if (!c || h <= 0) return;
    const w = c.width = 44; c.height = h;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1b1b1c"; g.fillRect(0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    fills.forEach((f, li) => { const [r, gg, b] = all[li].color; for (let y = 0; y < h; y++) if (f[y] > 0) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, a = 0.15 + 0.85 * f[y]; img.data[o] = img.data[o] * (1 - a) + r * a; img.data[o + 1] = img.data[o + 1] * (1 - a) + gg * a; img.data[o + 2] = img.data[o + 2] * (1 - a) + b * a; } });
    g.putImageData(img, 0, 0);
    g.fillStyle = "#777"; for (const cum of map.cum.slice(1)) g.fillRect(0, Math.floor((cum / map.total) * h), w, 1); // boundaries between loaded ranges
    if (pos >= 0 && map.total > 0) { g.fillStyle = "#fff"; g.fillRect(0, Math.min(h - 2, Math.floor((pos / map.total) * h)), w, 2); }
  }, [fills, all, h, pos, map]);
  const at = (e: React.PointerEvent) => Math.max(0, Math.min(1, (e.clientY - box.current!.getBoundingClientRect().top) / box.current!.clientHeight)) * map.total;
  const go = (e: React.PointerEvent) => onGo(map.addr(at(e)));
  const toggle = (k: "renamed" | "coverage", label: string, off?: boolean) => (
    <button aria-label={`${label} layer`} title={`${label} layer`} aria-pressed={on[k] && !off} disabled={off} onClick={() => setOn((o) => ({ ...o, [k]: !o[k] }))}>{label[0]}</button>
  );
  return (
    <div className="bmapcol">
    <div className="bmap" ref={box} role="slider" aria-label="Binary map" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pos >= 0 && map.total ? Math.round((pos / map.total) * 100) : 0} aria-valuetext={here ?? "no location"} tabIndex={0}
      aria-description={`Layers: ${all.map((l) => l.name).join(", ")}. Click or drag to go to an address.`}
      onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); go(e); }}
      onPointerMove={(e) => { if (drag.current) go(e); if (map.total) setTip({ y: e.clientY - box.current!.getBoundingClientRect().top, text: describeAt(map, funcs, at(e)) }); }} onPointerLeave={() => setTip(null)} onPointerUp={() => { drag.current = false; }} onPointerCancel={() => { drag.current = false; }}
      onKeyDown={(e) => { const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0; if (d && pos >= 0) { e.preventDefault(); onGo(map.addr(pos + d * Math.max(1, map.total / 100))); } }}>
      <canvas ref={cv} />
      {tip && <div className="bmap-tip" style={{ top: tip.y }}>{tip.text}</div>}
    </div>
    <div className="bmap-layers" role="group" aria-label="Map layers">{toggle("renamed", "Renamed")}{toggle("coverage", "Coverage", !coverage.shown)}</div>
    </div>
  );
}

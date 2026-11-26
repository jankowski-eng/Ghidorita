import { useEffect, useRef, useState } from "react";

/** Wheel zoom and drag pan for an SVG view: `view` is the transform, `handlers` go on the box, `moved()` tells a click from the end of a drag. */
export function usePanZoom() {
  const box = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
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
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; },
    onPointerMove: (e: React.PointerEvent) => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true; if (d.moved) { d.x = e.clientX; d.y = e.clientY; setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })); } },
    onPointerUp: () => { setTimeout(() => { drag.current = null; }); },
  };
  return { box, view, setView, handlers, moved: () => !!drag.current?.moved };
}

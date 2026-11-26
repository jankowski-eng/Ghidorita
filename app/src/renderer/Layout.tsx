import { useRef, useState, type ReactNode } from "react";

export type PaneId = "functions" | "listing" | "decompiler";
const ORDER: PaneId[] = ["functions", "listing", "decompiler"];
const LABEL: Record<PaneId, string> = { functions: "Functions", listing: "Listing", decompiler: "Decompiler" };
const KEY = "ghidra.layout.v1", MIN = 120;
type Sizes = Record<"functions" | "listing", number>;
const DEFAULT: Sizes = { functions: 260, listing: 560 };

function load(): Sizes {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s && Number.isFinite(s.functions) && Number.isFinite(s.listing)) return { functions: Math.min(2000, Math.max(MIN, s.functions)), listing: Math.min(2000, Math.max(MIN, s.listing)) };
  } catch { /* storage unavailable or corrupt: defaults */ }
  return DEFAULT;
}

/** Three panes side by side; each visible pane except the last visible one has a fixed width and a drag handle to its right. */
export function Panes({ visible, children }: { visible: Record<PaneId, boolean>; children: Record<PaneId, ReactNode> }) {
  const [sizes, setSizes] = useState(load);
  const sizesRef = useRef(sizes); sizesRef.current = sizes;
  const resize = (id: "functions" | "listing", w: number, save: boolean) => {
    const next = { ...sizesRef.current, [id]: Math.min(2000, Math.max(MIN, Math.round(w))) };
    setSizes(next);
    if (save) try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const shown = ORDER.filter((p) => visible[p]);
  return (
    <div className="main">
      {ORDER.map((id) => {
        const last = shown[shown.length - 1] === id;
        return (
          <div key={id} style={{ display: visible[id] ? "contents" : "none" }}>
            <section className="pane" aria-label={LABEL[id]} style={last || id === "decompiler" ? { flex: 1 } : { width: sizes[id as "functions" | "listing"], flex: "none" }}>
              {children[id]}
            </section>
            {visible[id] && !last && <Handle label={LABEL[id]} width={sizes[id as "functions" | "listing"]} onResize={(w, save) => resize(id as "functions" | "listing", w, save)} />}
          </div>
        );
      })}
    </div>
  );
}

function Handle({ label, width, onResize }: { label: string; width: number; onResize: (w: number, save: boolean) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  return (
    <div className="handle" role="separator" aria-orientation="vertical" aria-label={`Resize ${label} pane`} aria-valuenow={width} tabIndex={0}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, w: width }; }}
      onPointerMove={(e) => { if (drag.current) onResize(drag.current.w + e.clientX - drag.current.x, false); }}
      onPointerCancel={() => { drag.current = null; }}
      onPointerUp={(e) => { if (drag.current) { onResize(drag.current.w + e.clientX - drag.current.x, true); drag.current = null; } }}
      onKeyDown={(e) => {
        const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        if (d) { e.preventDefault(); onResize(width + d * (e.shiftKey ? 64 : 16), true); }
      }} />
  );
}

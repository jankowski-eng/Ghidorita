import { useRef, type ReactNode } from "react";

export type PaneId = "functions" | "listing" | "decompiler";
const LABEL: Record<PaneId, string> = { functions: "Functions", listing: "Listing", decompiler: "Decompiler" };
const MIN = 120;
type Sizes = Record<"functions" | "listing", number>;

/** The panes side by side in `order`; each visible sized pane except the last visible one has a drag handle to its right. The sizes are the owner's (`onSizes`, save = a drag or key step ended). */
export function Panes({ visible, order, sizes, onSizes, children }: { visible: Record<PaneId, boolean>; order: PaneId[]; sizes: Sizes; onSizes: (s: Sizes, save: boolean) => void; children: Record<PaneId, ReactNode> }) {
  const sizesRef = useRef(sizes); sizesRef.current = sizes;
  const resize = (id: "functions" | "listing", w: number, save: boolean) => onSizes({ ...sizesRef.current, [id]: Math.min(2000, Math.max(MIN, Math.round(w))) }, save);
  const shown = order.filter((p) => visible[p]);
  return (
    <div className="main">
      {order.map((id) => {
        const last = shown[shown.length - 1] === id;
        return (
          <div key={id} style={{ display: visible[id] ? "contents" : "none" }}>
            <section className="pane" aria-label={LABEL[id]} style={last || id === "decompiler" ? { flex: 1 } : { width: sizes[id as "functions" | "listing"], flex: "none" }}>
              {children[id]}
            </section>
            {visible[id] && !last && id !== "decompiler" && <Handle label={LABEL[id]} width={sizes[id as "functions" | "listing"]} onResize={(w, save) => resize(id as "functions" | "listing", w, save)} />}
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

import { useRef, type ReactNode } from "react";

export type PaneId = "functions" | "listing" | "decompiler";
const LABEL: Record<PaneId, string> = { functions: "Functions", listing: "Listing", decompiler: "Decompiler" };
const MIN = 120;
type Sizes = Record<"functions" | "listing", number>;

/** The panes side by side in `order`; each visible sized pane has a drag handle on the side facing the one flexible pane (the decompiler, else the last visible). The sizes are the owner's (`onSizes`, save = a drag or key step ended). */
export function Panes({ visible, order, sizes, onSizes, children }: { visible: Record<PaneId, boolean>; order: PaneId[]; sizes: Sizes; onSizes: (s: Sizes, save: boolean) => void; children: Record<PaneId, ReactNode> }) {
  const sizesRef = useRef(sizes); sizesRef.current = sizes;
  const resize = (id: "functions" | "listing", w: number, save: boolean) => onSizes({ ...sizesRef.current, [id]: Math.min(2000, Math.max(MIN, Math.round(w))) }, save);
  const shown = order.filter((p) => visible[p]);
  const flex = visible.decompiler ? "decompiler" : shown[shown.length - 1]; // exactly one visible pane fills the rest; the others keep their saved width
  const fi = shown.indexOf(flex);
  return (
    <div className="main">
      {order.map((id) => {
        const sized = id !== flex && id !== "decompiler" && visible[id], before = shown.indexOf(id) > fi; // a sized pane after the flexible one has its handle on its left
        const handle = sized && <Handle label={LABEL[id]} width={sizes[id as "functions" | "listing"]} sign={before ? -1 : 1} onResize={(w, save) => resize(id as "functions" | "listing", w, save)} />;
        return (
          <div key={id} style={{ display: visible[id] ? "contents" : "none" }}>
            {before && handle}
            <section className="pane" aria-label={LABEL[id]} style={id === flex ? { flex: 1 } : { width: sizes[id as "functions" | "listing"], flex: "none" }}>
              {children[id]}
            </section>
            {!before && handle}
          </div>
        );
      })}
    </div>
  );
}

function Handle({ label, width, sign, onResize }: { label: string; width: number; sign: 1 | -1; onResize: (w: number, save: boolean) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  return (
    <div className="handle" role="separator" aria-orientation="vertical" aria-label={`Resize ${label} pane`} aria-valuenow={width} tabIndex={0}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, w: width }; }}
      onPointerMove={(e) => { if (drag.current) onResize(drag.current.w + sign * (e.clientX - drag.current.x), false); }}
      onPointerCancel={() => { drag.current = null; }}
      onPointerUp={(e) => { if (drag.current) { onResize(drag.current.w + sign * (e.clientX - drag.current.x), true); drag.current = null; } }}
      onKeyDown={(e) => {
        const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        if (d) { e.preventDefault(); onResize(width + sign * d * (e.shiftKey ? 64 : 16), true); }
      }} />
  );
}

import { useEffect, useRef, useState } from "react";

export interface MenuItem { label: string; run: () => void }

/** A small popup menu at the pointer: Escape, a click elsewhere or a scroll closes it. `open(event, items)` from onContextMenu, render `node` once. */
export function useContextMenu() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => { if (!(e.type === "pointerdown" && ref.current?.contains(e.target as Node))) setM(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setM(null); };
    window.addEventListener("pointerdown", close, true); window.addEventListener("wheel", close, true); window.addEventListener("keydown", key, true); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("wheel", close, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", close); };
  }, [m]);
  const open = (e: React.MouseEvent, items: MenuItem[]) => { if (!items.length) return; e.preventDefault(); setM({ x: e.clientX, y: e.clientY, items }); };
  const node = m && (
    <div className="ctxmenu" ref={ref} role="menu" style={{ left: Math.min(m.x, window.innerWidth - 220), top: Math.min(m.y, window.innerHeight - 24 * m.items.length - 8) }}>
      {m.items.map((i) => <div key={i.label} role="menuitem" tabIndex={-1} onClick={() => { setM(null); i.run(); }}>{i.label}</div>)}
    </div>
  );
  return { open, node };
}

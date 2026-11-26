import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FunctionInfo, Address } from "../../../protocol";

/** Listbox: click/Enter opens a preview tab, double-click/Shift+Enter pins; arrows move the cursor (also from the filter box). */
export function FunctionList({ funcs, selected, onSelect, onPin }: { funcs: FunctionInfo[]; selected: Address | null; onSelect: (e: Address) => void; onPin: (e: Address) => void }) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => { const f = filter.toLowerCase(); return f ? funcs.filter((x) => x.name.toLowerCase().includes(f)) : funcs; }, [funcs, filter]);
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: shown.length, getScrollElement: () => ref.current, estimateSize: () => 20, overscan: 10 });
  useEffect(() => { const i = shown.findIndex((f) => f.entry === selected); if (i >= 0) { setCursor(i); v.scrollToIndex(i); } }, [selected]); // eslint-disable-line
  useEffect(() => setCursor(0), [filter]);
  const move = (i: number) => { const c = Math.max(0, Math.min(shown.length - 1, i)); setCursor(c); v.scrollToIndex(c); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(cursor + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(cursor - 1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(cursor + 15); }
    else if (e.key === "PageUp") { e.preventDefault(); move(cursor - 15); }
    else if (e.key === "Enter" && shown[cursor]) { e.preventDefault(); (e.shiftKey ? onPin : onSelect)(shown[cursor].entry); }
  };
  return (
    <div className="funcs" onKeyDown={onKey}>
      <input aria-label="Filter functions" placeholder={`filter ${funcs.length} functions`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="scroll" ref={ref} style={{ flex: 1 }} role="listbox" tabIndex={0} aria-label="Functions" aria-activedescendant={shown[cursor] ? `fn-${shown[cursor].entry}` : undefined}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((it) => {
            const f = shown[it.index];
            return (
              <div key={f.entry} id={`fn-${f.entry}`} role="option" aria-selected={f.entry === selected}
                className={"frow" + (f.entry === selected ? " sel" : "") + (it.index === cursor ? " cur" : "")}
                onClick={() => { setCursor(it.index); onSelect(f.entry); }} onDoubleClick={() => onPin(f.entry)}
                style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${it.start}px)` }}>
                {f.name} <span style={{ color: "#777" }}>{f.entry}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

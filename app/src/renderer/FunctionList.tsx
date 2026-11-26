import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FunctionInfo, Address } from "../../../protocol";

export function FunctionList({ funcs, selected, onSelect }: { funcs: FunctionInfo[]; selected: Address | null; onSelect: (e: Address) => void }) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => { const f = filter.toLowerCase(); return f ? funcs.filter((x) => x.name.toLowerCase().includes(f)) : funcs; }, [funcs, filter]);
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: shown.length, getScrollElement: () => ref.current, estimateSize: () => 20, overscan: 10 });
  useEffect(() => { const i = shown.findIndex((f) => f.entry === selected); if (i >= 0) v.scrollToIndex(i); }, [selected]); // eslint-disable-line
  return (
    <div className="funcs">
      <input placeholder={`filter ${funcs.length} functions`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="scroll" ref={ref} style={{ flex: 1 }}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((it) => {
            const f = shown[it.index];
            return (
              <div key={f.entry} className={"frow" + (f.entry === selected ? " sel" : "")} onClick={() => onSelect(f.entry)}
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

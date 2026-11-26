import { useState } from "react";
import type { Address } from "../../../protocol";
import { StringsPanel } from "./StringsPanel";
import { SymbolsPanel } from "./SymbolsPanel";
import { MemSearchPanel } from "./MemSearchPanel";
import { ChangesPanel } from "./ChangesPanel";
import { CoveragePanel } from "./CoveragePanel";

export type DockId = "strings" | "symbols" | "memsearch" | "changes" | "coverage";
const TABS: [DockId, string][] = [["symbols", "Symbol Table"], ["strings", "Defined Strings"], ["memsearch", "Search Memory"], ["changes", "Changes"], ["coverage", "Coverage"]];

/** Bottom dock with the navigate-and-find windows. A panel keeps its filter/results while another tab is shown (hidden, not unmounted). */
export function Dock({ active, onActivate, onClose, version, onGo, onError, cov }: {
  active: DockId; onActivate: (d: DockId) => void; onClose: () => void; version: number; onGo: (a: Address) => void; onError: (e: unknown) => void;
  cov: { version: number; onLoad: () => void; onChange: () => void };
}) {
  const [seen, setSeen] = useState<DockId[]>([active]);
  if (!seen.includes(active)) setSeen([...seen, active]);
  const P = { version, onGo, onError };
  return (
    <section className="dock" aria-label="Dock">
      <div className="tabstrip" role="tablist">
        {TABS.map(([id, label]) => (
          <div key={id} className={"tab" + (id === active ? " active" : "")}>
            <button role="tab" aria-selected={id === active} aria-label={`${label} tab`} onClick={() => onActivate(id)}>{label}</button>
          </div>
        ))}
        <span style={{ flex: 1 }} />
        <button className="x" aria-label="Close dock" onClick={onClose}>×</button>
      </div>
      <div className="dock-body">
        {seen.includes("symbols") && <div hidden={active !== "symbols"}><SymbolsPanel {...P} /></div>}
        {seen.includes("strings") && <div hidden={active !== "strings"}><StringsPanel {...P} /></div>}
        {seen.includes("changes") && <div hidden={active !== "changes"}><ChangesPanel onGo={onGo} /></div>}
        {seen.includes("coverage") && <div hidden={active !== "coverage"}><CoveragePanel {...cov} /></div>}
        {seen.includes("memsearch") && <div hidden={active !== "memsearch"}><MemSearchPanel {...P} /></div>}
      </div>
    </section>
  );
}

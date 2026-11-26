import type { Capability } from "../../../protocol";
import type { Searches } from "./backend";
import { dockCapability } from "../capabilities";
import { useState } from "react";
import type { Address, FunctionInfo } from "../../../protocol";
import { StringsPanel } from "./StringsPanel";
import { SymbolsPanel } from "./SymbolsPanel";
import { MemSearchPanel } from "./MemSearchPanel";
import { ChangesPanel } from "./ChangesPanel";
import { CoveragePanel } from "./CoveragePanel";
import { CallsPanel } from "./CallsPanel";
import { BookmarksPanel } from "./BookmarksPanel";
import type { Bookmarks, References } from "./backend";

export type DockId = "strings" | "symbols" | "memsearch" | "changes" | "coverage" | "calls" | "bookmarks";
const TABS: [DockId, string][] = [["symbols", "Symbol Table"], ["strings", "Defined Strings"], ["memsearch", "Search Memory"], ["changes", "Changes"], ["calls", "Calls"], ["bookmarks", "Bookmarks"], ["coverage", "Coverage"]];

/** Bottom dock with the navigate-and-find windows. A panel keeps its filter/results while another tab is shown (hidden, not unmounted). */
export function Dock({ searches, capabilities, active, onActivate, onClose, version, onGo, onError, cov, calls, bookmarks }: {
  bookmarks: Bookmarks;
  calls: { op: References["calls"]; entry: Address | null; name: string };
  searches: Searches; capabilities: ReadonlySet<Capability>; active: DockId; onActivate: (d: DockId) => void; onClose: () => void; version: number; onGo: (a: Address) => void; onError: (e: unknown) => void;
  cov: { version: number; funcs: FunctionInfo[]; onLoad: () => void; onChange: () => void };
}) {
  const [seen, setSeen] = useState<DockId[]>([active]);
  if (!seen.includes(active)) setSeen([...seen, active]);
  const P = { version, onGo, onError };
  return (
    <section className="dock" aria-label="Dock">
      <div className="tabstrip" role="tablist">
        {TABS.filter(([id]) => capabilities.has(dockCapability[id])).map(([id, label]) => (
          <div key={id} className={"tab" + (id === active ? " active" : "")}>
            <button role="tab" aria-selected={id === active} aria-label={`${label} tab`} onClick={() => onActivate(id)}>{label}</button>
          </div>
        ))}
        <span style={{ flex: 1 }} />
        <button className="x" aria-label="Close dock" onClick={onClose}>×</button>
      </div>
      <div className="dock-body">
        {seen.includes("symbols") && <div hidden={active !== "symbols"}><SymbolsPanel listSymbols={searches.listSymbols} {...P} /></div>}
        {seen.includes("strings") && <div hidden={active !== "strings"}><StringsPanel listStrings={searches.listStrings} {...P} /></div>}
        {seen.includes("changes") && <div hidden={active !== "changes"}><ChangesPanel onGo={onGo} /></div>}
        {seen.includes("calls") && <div hidden={active !== "calls"}><CallsPanel calls={calls.op} entry={calls.entry} name={calls.name} {...P} /></div>}
        {seen.includes("bookmarks") && <div hidden={active !== "bookmarks"}><BookmarksPanel bookmarks={bookmarks} {...P} /></div>}
        {seen.includes("coverage") && <div hidden={active !== "coverage"}><CoveragePanel {...cov} onGo={onGo} /></div>}
        {seen.includes("memsearch") && <div hidden={active !== "memsearch"}><MemSearchPanel searchMemory={searches.searchMemory} {...P} /></div>}
      </div>
    </section>
  );
}

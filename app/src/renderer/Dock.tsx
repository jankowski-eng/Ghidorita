import type { Capability } from "../../../protocol";
import type { Searches } from "./backend";
import { dockCapability } from "../capabilities";
import { useState } from "react";
import type { Address, FunctionInfo, PatchedRange } from "../../../protocol";
import { StringsPanel } from "./StringsPanel";
import { SymbolsPanel } from "./SymbolsPanel";
import { MemSearchPanel } from "./MemSearchPanel";
import { ChangesPanel } from "./ChangesPanel";
import { CoveragePanel } from "./CoveragePanel";
import { CallsPanel } from "./CallsPanel";
import { BookmarksPanel } from "./BookmarksPanel";
import { RegistersPanel } from "./RegistersPanel";
import { LocalsPanel } from "./LocalsPanel";
import { MemoryPanel } from "./MemoryPanel";
import { StackPanel } from "./StackPanel";
import { UndefinedPanel } from "./UndefinedPanel";
import { HexPanel } from "./HexPanel";
import type { AddrMap } from "./addrmap";
import type { Bookmarks, FunctionNavigation, ListingReads, References } from "./backend";
import type { StackSlot } from "../../../protocol";

export type DockId = "strings" | "symbols" | "memsearch" | "changes" | "coverage" | "calls" | "bookmarks" | "registers" | "locals" | "memory" | "stack" | "undefined" | "hex";
const TABS: [DockId, string][] = [["symbols", "Symbol Table"], ["strings", "Defined Strings"], ["undefined", "Undefined"], ["memsearch", "Search Memory"], ["changes", "Changes"], ["calls", "Calls"], ["stack", "Stack"], ["bookmarks", "Bookmarks"], ["hex", "Bytes"], ["coverage", "Coverage"], ["registers", "Registers"], ["locals", "Locals"], ["memory", "Target Memory"]];

/** Bottom dock with the navigate-and-find windows. A panel keeps its filter/results while another tab is shown (hidden, not unmounted). */
export function Dock({ searches, capabilities, active, onActivate, onClose, version, onGo, onError, cov, calls, stack, bookmarks, hex }: {
  hex: { read: ListingReads["bytes"]; patches?: () => Promise<PatchedRange[]>; unit: (a: Address) => Promise<{ address: Address; length: number } | null>; map: AddrMap; cursor: Address | null };
  stack: { read: FunctionNavigation["stackFrame"]; entry: Address | null; name: string; onRename?: (entry: Address, s: StackSlot) => void; onRetype?: (entry: Address, s: StackSlot) => void };
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
        {seen.includes("undefined") && <div hidden={active !== "undefined"}><UndefinedPanel listUndefinedRefs={searches.listUndefinedRefs} {...P} /></div>}
        {seen.includes("changes") && <div hidden={active !== "changes"}><ChangesPanel onGo={onGo} /></div>}
        {seen.includes("calls") && <div hidden={active !== "calls"}><CallsPanel calls={calls.op} entry={calls.entry} name={calls.name} {...P} /></div>}
        {seen.includes("stack") && <div hidden={active !== "stack"}><StackPanel stackFrame={stack.read} entry={stack.entry} name={stack.name} version={version} onError={onError} onRename={stack.onRename} onRetype={stack.onRetype} /></div>}
        {seen.includes("bookmarks") && <div hidden={active !== "bookmarks"}><BookmarksPanel bookmarks={bookmarks} {...P} /></div>}
        {seen.includes("hex") && <div hidden={active !== "hex"}><HexPanel {...hex} {...P} /></div>}
        {seen.includes("coverage") && <div hidden={active !== "coverage"}><CoveragePanel {...cov} onGo={onGo} /></div>}
        {seen.includes("registers") && <div hidden={active !== "registers"}><RegistersPanel /></div>}
        {seen.includes("locals") && <div hidden={active !== "locals"}><LocalsPanel /></div>}
        {seen.includes("memory") && <div hidden={active !== "memory"}><MemoryPanel /></div>}
        {seen.includes("memsearch") && <div hidden={active !== "memsearch"}><MemSearchPanel searchMemory={searches.searchMemory} {...P} /></div>}
      </div>
    </section>
  );
}

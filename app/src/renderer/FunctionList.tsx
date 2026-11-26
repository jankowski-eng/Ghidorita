import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FunctionInfo, Address } from "../../../protocol";
import type { Searches } from "./backend";
import { latest } from "./latest";
import { useDebounced } from "./hooks";
import { notRenamed } from "./names";

const SRC_TITLE: Record<string, string> = { user: "named by you", analysis: "named by analysis (a guess)", imported: "name from the file", default: "default name, not yet named", other: "" };

/** Listbox: click/Enter opens a preview tab, double-click/Shift+Enter pins; arrows move the cursor (also from the filter box). */
export function FunctionList({ searchSymbols, funcs, selected, onSelect, onPin }: { searchSymbols?: Searches["searchSymbols"]; funcs: FunctionInfo[]; selected: Address | null; onSelect: (e: Address) => void; onPin?: (e: Address) => void }) {
  const [filter, setFilter] = useState("");
  const dq = useDebounced(filter.trim(), 150);
  const [hits, setHits] = useState<FunctionInfo[] | null>(null); // null = no filter: show everything
  const [err, setErr] = useState("");
  const run = useRef(latest()).current;
  useEffect(() => {
    if (!dq || !searchSymbols) { run(Promise.resolve(null)); setHits(null); setErr(""); return; }
    const job = searchSymbols({ query: dq, limit: 5000 });
    run(job.result).then((r) => { if (r) { setErr(r.length >= 5000 ? "more than 5000 symbols match; showing the first 5000 (refine the filter)" : ""); setHits(r.filter((h) => h.kind === "function").map((h) => ({ name: h.name, entry: h.address, size: 0 }))); } },
      (e) => setErr(e instanceof Error ? e.message : String(e)));
    return () => { void run(Promise.resolve(null)); job.cancel(); };
  }, [dq, funcs, searchSymbols]); // eslint-disable-line
  const base = useMemo(() => {
    if (searchSymbols || !dq) return hits ?? funcs;
    const query = dq.toLowerCase();
    return funcs.filter((f) => f.name.toLowerCase().includes(query));
  }, [searchSymbols, dq, hits, funcs]);
  const [todo, setTodo] = useState(false); // "Not yet renamed": hide what a person already named
  const src = useMemo(() => new Map(funcs.map((f) => [f.entry, f.source])), [funcs]); // filter hits come from search_symbols, which has no source
  const shown = useMemo(() => (todo ? base.filter((f) => notRenamed(f.source ?? src.get(f.entry))) : base), [todo, base, src]);
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: shown.length, getScrollElement: () => ref.current, estimateSize: () => 20, overscan: 10 });
  useEffect(() => { const i = shown.findIndex((f) => f.entry === selected); if (i >= 0) { setCursor(i); v.scrollToIndex(i); } }, [selected]); // eslint-disable-line
  useEffect(() => setCursor(0), [hits, todo]);
  const move = (i: number) => { const c = Math.max(0, Math.min(shown.length - 1, i)); setCursor(c); v.scrollToIndex(c); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(cursor + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(cursor - 1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(cursor + 15); }
    else if (e.key === "PageUp") { e.preventDefault(); move(cursor - 15); }
    else if (e.key === "Enter" && shown[cursor]) { e.preventDefault(); (e.shiftKey && onPin ? onPin : onSelect)(shown[cursor].entry); }
  };
  return (
    <div className="funcs" onKeyDown={onKey}>
      <input aria-label="Filter functions" placeholder={`filter ${funcs.length} functions`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <label className="chip todo"><input type="checkbox" aria-label="Not yet renamed" checked={todo} onChange={(e) => setTodo(e.target.checked)} /> not yet renamed{todo ? ` (${shown.length})` : ""}</label>
      {!funcs.length && <div className="empty">No functions</div>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="scroll" ref={ref} style={{ flex: 1 }} role="listbox" tabIndex={0} aria-label="Functions" aria-activedescendant={shown[cursor] ? `fn-${shown[cursor].entry}` : undefined}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((it) => {
            const f = shown[it.index];
            return (
              <div key={f.entry} id={`fn-${f.entry}`} role="option" aria-selected={f.entry === selected}
                className={"frow" + (f.entry === selected ? " sel" : "") + (it.index === cursor ? " cur" : "")}
                onClick={() => { setCursor(it.index); onSelect(f.entry); }} onDoubleClick={onPin ? () => onPin(f.entry) : undefined}
                style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${it.start}px)` }}>
                <span className={"psrc " + (f.source ?? src.get(f.entry) ?? "other")} title={SRC_TITLE[f.source ?? src.get(f.entry) ?? "other"]} />{f.name} <span style={{ color: "#777" }}>{f.entry}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

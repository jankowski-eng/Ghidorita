import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isCancelled, isNoProgram } from "./scan";

export interface Col<T> { key: string; label: string; width?: number; sort?: string; render: (r: T) => ReactNode }
export interface Sort { key: string; desc: boolean }
const ROW_H = 20;

/**
 * Virtualized table over `count` rows that may not be loaded: `rowAt(i)` returns undefined for a row still in flight (shown as a placeholder)
 * and `onVisible(first, last)` tells the owner which rows to fetch. Arrow keys / Page keys / Home / End move the cursor, Enter or a click activates.
 */
export function VirtualTable<T>({ label, count, rowAt, onVisible, cols, sort, onSort, onActivate, empty }: {
  label: string; count: number; rowAt: (i: number) => T | undefined; onVisible: (first: number, last: number) => void; cols: Col<T>[];
  sort?: Sort; onSort?: (key: string) => void; onActivate: (r: T, i: number) => void; empty?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(-1);
  const v = useVirtualizer({ count, getScrollElement: () => ref.current, estimateSize: () => ROW_H, overscan: 10 });
  const items = v.getVirtualItems();
  const first = items[0]?.index ?? 0, last = items[items.length - 1]?.index ?? -1;
  useEffect(() => { if (last >= first) onVisible(first, last); }); // every render: rows may have arrived or been reset
  useEffect(() => { setCur(-1); }, [count === 0]);
  const move = (i: number) => { const c = Math.max(0, Math.min(count - 1, i)); setCur(c); v.scrollToIndex(c); };
  const onKey = (e: React.KeyboardEvent) => {
    const page = Math.max(1, Math.floor((ref.current?.clientHeight ?? 200) / ROW_H) - 1);
    if (e.key === "ArrowDown") { e.preventDefault(); move(cur + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(cur < 0 ? 0 : cur - 1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(cur + page); }
    else if (e.key === "PageUp") { e.preventDefault(); move(cur - page); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(count - 1); }
    else if (e.key === "Enter" && cur >= 0) { const r = rowAt(cur); if (r) { e.preventDefault(); onActivate(r, cur); } }
  };
  const cell = (c: Col<T>) => ({ flex: c.width ? `0 0 ${c.width}px` : "1 1 0", minWidth: 0 });
  return (
    <div className="vt" role="grid" aria-label={label} aria-rowcount={count} onKeyDown={onKey}>
      <div className="vt-head" role="row">
        {cols.map((c) => {
          const s = sort && c.sort && sort.key === c.sort ? (sort.desc ? "descending" : "ascending") : undefined;
          return (
            <div key={c.key} role="columnheader" aria-sort={s ?? (c.sort ? "none" : undefined)} style={cell(c)}>
              {c.sort && onSort ? <button onClick={() => onSort(c.sort!)} aria-label={`Sort by ${c.label}`}>{c.label}{s ? (s === "ascending" ? " ▲" : " ▼") : ""}</button> : c.label}
            </div>
          );
        })}
      </div>
      <div className="vt-body" ref={ref} tabIndex={0}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {items.map((it) => {
            const r = rowAt(it.index);
            return (
              <div key={it.index} role="row" aria-rowindex={it.index + 1} aria-selected={it.index === cur} className={"vt-row" + (it.index === cur ? " cur" : "") + (r ? "" : " ph")}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${it.start}px)` }}
                onClick={() => { setCur(it.index); ref.current?.focus(); if (r) onActivate(r, it.index); }}>
                {cols.map((c) => <div key={c.key} role="gridcell" style={cell(c)} className={"c-" + c.key}>{r ? c.render(r) : c === cols[0] ? "…" : ""}</div>)}
              </div>
            );
          })}
        </div>
        {count === 0 && empty && <div className="vt-empty">{empty}</div>}
      </div>
    </div>
  );
}

const PAGE = 100;
/**
 * Server-paged rows: page 0 is fetched on every reset (it carries `total`), further pages when `onVisible` asks. `resetKey` changes
 * (query, sort, program version) drop everything; replies of an older generation are ignored. Cancelled/NoProgram errors are not errors.
 */
export function usePaged<T>(fetch: (offset: number, limit: number) => Promise<{ total: number; items: T[] }>, resetKey: string, onError: (e: unknown) => void, cancel: () => void) {
  const st = useRef({ gen: 0, pages: new Map<number, T[]>(), loading: new Set<number>() });
  const fetchRef = useRef(fetch); fetchRef.current = fetch;
  const [state, setState] = useState({ total: 0, ready: false, busy: false });
  const [, tick] = useState(0);
  const load = (p: number) => {
    const s = st.current, gen = s.gen;
    if (s.pages.has(p) || s.loading.has(p)) return;
    s.loading.add(p);
    fetchRef.current(p * PAGE, PAGE).then((r) => {
      if (gen !== s.gen) return;
      s.loading.delete(p); s.pages.set(p, r.items);
      setState({ total: r.total, ready: true, busy: s.loading.size > 0 });
      tick((n) => n + 1);
    }, (e) => {
      if (gen !== s.gen) return;
      s.loading.delete(p); setState((x) => ({ ...x, busy: s.loading.size > 0 }));
      if (!isCancelled(e) && !isNoProgram(e)) onError(e);
    });
  };
  useEffect(() => {
    const s = st.current;
    cancel(); s.gen++; s.pages.clear(); s.loading.clear();
    setState({ total: 0, ready: false, busy: true }); load(0);
  }, [resetKey]); // eslint-disable-line
  useEffect(() => () => { st.current.gen++; cancel(); }, []); // eslint-disable-line
  return {
    ...state,
    rowAt: (i: number) => st.current.pages.get(Math.floor(i / PAGE))?.[i % PAGE],
    onVisible: (a: number, b: number) => { for (let p = Math.floor(a / PAGE); p <= Math.floor(b / PAGE); p++) load(p); },
  };
}

import { coverage } from "./coverage";
import { useEffect, useRef, useState } from "react";
import type { ListingRow, Address, DataPart } from "../../../protocol";
import type { AddrMap } from "./addrmap";
import type { ListingReads } from "./backend";
import { FIRST_LISTING_PAGE as FIRST } from "./session";
import { listingKey, type EditAction } from "./editActions";
import { parseAddr } from "./address";
import { indexAt, RunCache, spliceRows, type Range, type Run } from "./rowcache";

const ROW_H = 16;
// Fixed pixel height of the listing scrollbar, independent of binary size (Chromium caps elements near 33.5M px).
const SCROLL_H = 10_000_000;
// rows per fetch, prefetch margin in lines, max buffered rows. Round 8: 100/60 left 17% of frames of a 12k lines/s fling waiting for data
// (SPIKE_REPORT round 2); a fling eats ~100 lines per frame, so the margin is now several frames of lookahead and a fetch refills several frames.
const MAXBUF = 3000;
// BENCH=1 compares settings in one run through window.__tune = {batch, margin}
const tune = () => ({ batch: 250, margin: 400, ...(window as any).__tune }) as { batch: number; margin: number };

type Kind = "plate" | "pre" | "header" | "label" | "xref" | "main" | "part" | "more" | "post";
type Line = { row: ListingRow; kind: Kind; key: string; text?: string; part?: DataPart };
type Built = { lines: Line[]; first: number[]; main: number[] }; // per row: index of its first line and of its main line

/** Lines of a row: plate, function header, labels, xref annotation, pre comment, the unit, its unfolded components, post comment. */
function build(rows: ListingRow[], unfolded: Set<string>): Built {
  const lines: Line[] = [], first: number[] = [], main: number[] = [];
  for (const row of rows) {
    first.push(lines.length);
    const add = (kind: Kind, extra: Partial<Line> = {}) => lines.push({ row, kind, key: `${row.address}:${kind}:${lines.length - first[first.length - 1]}`, ...extra });
    for (const t of row.plate?.split("\n") ?? []) add("plate", { text: t });
    if (row.header) add("header");
    for (const n of row.labels ?? (row.label ? [row.label] : [])) add("label", { text: n });
    if (row.xrefs) add("xref");
    for (const t of row.pre?.split("\n") ?? []) add("pre", { text: t });
    main.push(lines.length); add("main");
    if (row.parts && unfolded.has(row.address)) {
      for (const p of row.parts) add("part", { part: p });
      if (row.partsTotal && row.partsTotal > row.parts.length) add("more", { text: `… ${row.partsTotal - row.parts.length} more components` });
    }
    for (const t of row.post?.split("\n") ?? []) add("post", { text: t });
  }
  return { lines, first, main };
}
const XK: Record<string, string> = { call: "c", jump: "j", read: "r", write: "w", readwrite: "rw", data: "d", flow: "f", other: "o" };
const bytesText = (r: ListingRow) => r.bytes + (r.bytesMore ? ` …+${r.bytesMore}` : "");

/**
 * Address-based listing. Buffer = a contiguous run of rows around an anchor; fetched forward/backward by address. Runs left behind by a jump are
 * kept (RunCache), so jumping back into them needs no fetch. Wheel scrolls by lines inside the buffer; the (fixed-height) scrollbar maps
 * fraction -> byte position -> address and jumps. Edits: `change` carries the program_changed ranges, only buffered rows intersecting them are
 * refetched (rowcache.ts spliceRows); no ranges (type edits) refetches from the top row. Neither moves the view or cancels a navigation.
 */
export function Listing({ reader, initialRows, map, scrollReq, change, topAddrRef, cursorRef, rowRef, testMode, canEdit, onLatency, onError, onRowClick, onGo, onEdit, onXrefs }: {
  reader: Pick<ListingReads, "rows">; initialRows: ListingRow[]; map: AddrMap;
  rowRef: { current: (() => ListingRow | undefined) | null }; testMode: boolean; canEdit: (a: EditAction) => boolean; scrollReq: { address: Address; n: number }; change: { n: number; ranges: Range[] | null };
  topAddrRef: { current: Address }; cursorRef: { current: Address };
  onLatency: (ms: number) => void; onError: (e: unknown) => void; onRowClick?: (address: Address) => void; onGo?: (address: Address) => void; onEdit?: (a: EditAction) => void; onXrefs?: (address: Address) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  const cache = useRef(new RunCache(4)).current;
  const [st] = useState(() => ({
    rows: initialRows, built: build(initialRows, new Set()), unfolded: new Set<string>(), top: 0, atStart: true, atEnd: initialRows.length < FIRST,
    busy: false, failed: false, gen: 0, view: 30, lastSet: -1, acc: 0, cur: "" as Address, dragging: false, pend: undefined as { r: Range[] | null } | undefined, prefetch: undefined as ReturnType<typeof setTimeout> | undefined,
  }));
  const render = () => tick((n) => n + 1);
  const lines = () => st.built.lines;

  const maxTop = () => (st.atEnd ? Math.max(0, lines().length - st.view) : Math.max(0, lines().length - 1));
  const syncThumb = () => {
    const el = bar.current, line = lines()[st.top];
    if (!el || !line || st.dragging) return; // while the user holds the thumb it stays where they put it
    const f = map.total > 1 ? map.posOf(line.row.address) / (map.total - 1) : 0;
    el.scrollTop = f * (SCROLL_H - el.clientHeight);
    st.lastSet = el.scrollTop;
  };
  const setRows = (rows: ListingRow[]) => { st.rows = rows; st.built = build(rows, st.unfolded); };
  const setTopAddr = () => { topAddrRef.current = lines()[st.top]?.row.address ?? topAddrRef.current; };
  const active = (): Run => ({ rows: st.rows, atStart: st.atStart, atEnd: st.atEnd });
  const load = (run: Run) => { st.atStart = run.atStart; st.atEnd = run.atEnd; setRows(run.rows); };
  /** the line under the view's top as (row address, line offset in the row), to find it again after the rows changed */
  const anchor = () => {
    const l = lines()[st.top];
    if (!l) return null;
    const k = st.rows.indexOf(l.row);
    return { address: l.row.address, off: st.top - st.built.first[k] };
  };
  const restore = (a: { address: Address; off: number } | null) => {
    if (!a || !st.rows.length) { st.top = 0; return; }
    let k = st.rows.findIndex((r) => r.address === a.address);
    if (k < 0) { const p = parseAddr(a.address); k = p ? st.rows.findIndex((r) => { const q = parseAddr(r.address); return q && q.space === p.space && q.off >= p.off; }) : -1; }
    if (k < 0) k = st.rows.length - 1;
    const n = (st.built.first[k + 1] ?? lines().length) - st.built.first[k];
    st.top = st.built.first[k] + Math.min(a.off, n - 1);
  };

  const fetchRows = async (address: Address, direction: "forward" | "backward", count = tune().batch) => {
    const t0 = performance.now();
    const rows = await reader.rows({ address, count, direction });
    const ms = performance.now() - t0;
    onLatency(Math.round(ms));
    if (testMode) ((window as any).__lst ??= []).push({ ms, direction, count, address, rows: rows.length, where: new Error().stack?.split("\n").slice(2, 5).map((x) => x.trim().slice(0, 60)).join(" | ") });
    return rows;
  };

  // keep the buffer filled around the top line; loops until satisfied
  const ensure = async () => {
    if (st.busy || st.failed || !st.rows.length) return; // after an error, wait for the next user action instead of retrying in a loop
    const gen = st.gen;
    const { batch, margin } = tune();
    const needFwd = !st.atEnd && st.top + st.view + margin > lines().length;
    const needBack = !st.atStart && st.top < margin;
    if (!needFwd && !needBack) { void drain(); return; }
    st.busy = true;
    try {
      if (needBack) {
        const a = anchor();
        const rows = await fetchRows(st.rows[0].address, "backward");
        if (gen !== st.gen) return;
        if (rows.length < batch) st.atStart = true;
        setRows([...rows, ...st.rows]);
        restore(a);
      } else {
        const last = st.rows[st.rows.length - 1];
        const next = map.posOf(last.address) + last.length;
        const rows = next < map.total ? await fetchRows(map.addr(next), "forward") : [];
        if (gen !== st.gen) return;
        if (rows.length < batch) st.atEnd = true;
        setRows([...st.rows, ...rows]);
      }
      trim();
      setTopAddr();
      render();
    } catch (e) { if (gen === st.gen) { st.failed = true; onError(e); } }
    finally { if (gen === st.gen) { st.busy = false; ensure(); } }
  };

  // drop rows far from the top line so the buffer stays small
  const trim = () => {
    if (st.rows.length <= MAXBUF) return;
    const k = st.rows.length - MAXBUF, a = anchor();
    if (st.top > lines().length / 2) { st.atStart = false; setRows(st.rows.slice(k)); }
    else { st.atEnd = false; setRows(st.rows.slice(0, MAXBUF)); }
    restore(a);
  };

  // ---- invalidation after edits ----
  const queue = (r: Range[] | null) => { st.pend = st.pend ? { r: st.pend.r && r ? [...st.pend.r, ...r] : null } : { r }; void drain(); }; // a null (address-less change) wins over ranges
  const drain = async () => {
    if (st.busy || !st.pend || !st.rows.length) return; // no rows yet: the jump that fetches them calls drain() when it lands
    const { r } = st.pend;
    st.pend = undefined;
    const gen = st.gen;
    const rows0 = st.rows;
    let stale = false; // the buffer was replaced by a jump while we fetched: this result must not be applied
    st.busy = true;
    try {
      cache.invalidate(r);
      const a = anchor();
      if (r === null) { // no addresses (type edits): refetch from the top row; shortcut: rows above it are refetched when scrolled to, not now
        const rows = a ? await fetchRows(a.address, "forward") : [];
        stale = gen !== st.gen || st.rows !== rows0;
        if (!stale && rows.length) { st.atStart = false; st.atEnd = rows.length < tune().batch; setRows(rows); st.top = Math.min(a!.off, lines().length - 1); setTopAddr(); render(); }
      } else {
        const res = await spliceRows(rows0, r, (ad, c) => fetchRows(ad, "forward", c), st.atEnd);
        stale = gen !== st.gen || st.rows !== rows0;
        if (!stale && res) { st.atEnd = res.atEnd; setRows(res.rows); restore(a); setTopAddr(); render(); }
      }
    } catch (e) { if (gen === st.gen) { st.failed = true; onError(e); } }
    finally {
      if (gen === st.gen) st.busy = false;
      // a jump replaced the buffer meanwhile (the new rows may have been fetched before the edit; and a refetch started from the old top must not
      // undo the navigation): drop this result, apply the change to the new rows too
      if (gen !== st.gen || stale) { if (box.current) queue(r); return; }
      ensure(); void drain();
    }
  };

  // Row cursor: an address (not an index), so it survives buffer shifts and refreshes; it highlights the row whose unit contains it.
  const setCur = (a: Address) => { st.cur = a; cursorRef.current = a; };
  const curIndex = () => { const p = st.cur ? parseAddr(st.cur) : null; return p ? indexAt(st.rows, p) : -1; };
  const moveCursor = (n: number) => {
    if (!st.rows.length) return;
    st.failed = false;
    let i = curIndex();
    if (i < 0) { const top = lines()[st.top]?.row; i = Math.max(0, top ? st.rows.indexOf(top) : 0); n = 0; } // cursor not buffered: start at the top row
    const ni = Math.max(0, Math.min(st.rows.length - 1, i + n)), row = st.rows[ni];
    setCur(row.address);
    const li = st.built.first[ni], last = st.top + st.view - 2; // show the label/comment lines with their row
    if (li < st.top) st.top = li; else if (st.built.main[ni] > last) st.top = Math.min(st.built.main[ni] - st.view + 2, maxTop());
    st.top = Math.max(0, st.top);
    setTopAddr();
    syncThumb(); render(); ensure();
  };

  const jump = async (address: Address, thumb: boolean) => {
    if (!map.total) return;
    const gen = ++st.gen;
    st.busy = false; st.failed = false;
    clearTimeout(st.prefetch);
    // after a fetch the top-up prefetch waits a moment: a burst of jumps (scrollbar drag, typing a go-to) must not queue prefetches ahead of the next jump's fetch
    const settle = (fetched = false) => { st.top = Math.min(st.top, maxTop()); setTopAddr(); if (thumb) syncThumb(); render(); if (fetched) st.prefetch = setTimeout(ensure, 40); else ensure(); void drain(); };
    const p = parseAddr(address);
    let k = p ? indexAt(st.rows, p) : -1;
    if (k >= 0) { st.top = st.built.first[k]; settle(); return; } // already buffered: no fetch
    const run = p && cache.take(p);
    if (run) { cache.put(active()); load(run); k = indexAt(st.rows, p!); st.top = st.built.first[k]; settle(); return; } // a run shown earlier
    try {
      const rows = await fetchRows(address, "forward", FIRST); // small first fetch: the view shows after one cheap round trip, the prefetch tops up
      if (gen !== st.gen) return;
      cache.put(active());
      st.atStart = false; st.atEnd = rows.length < FIRST;
      setRows(rows);
      st.top = 0;
      settle(true);
    } catch (e) { if (gen === st.gen) onError(e); }
  };

  const scrollLines = (n: number) => {
    const before = st.top;
    st.failed = false;
    st.top = Math.max(0, Math.min(st.top + n, maxTop()));
    setTopAddr();
    syncThumb(); render(); ensure();
    return st.top - before;
  };
  const toggleFold = (row: ListingRow) => {
    if (!row.parts) return;
    const a = anchor();
    if (!st.unfolded.delete(row.address)) st.unfolded.add(row.address);
    setRows(st.rows); restore(a); render();
  };
  rowRef.current = () => st.cur ? st.rows[curIndex()] : lines()[st.top]?.row;
  if (testMode) (window as any).__listing = {
    rowAt: (a: Address) => { const p = parseAddr(a); return p ? st.rows[indexAt(st.rows, p)] : undefined; },
    jump: (a: Address) => jump(a, true), scrollLines, top: () => topAddrRef.current,
    lines: () => lines().map((l) => ({ kind: l.kind, address: l.row.address, text: l.text })), unfold: (a: Address) => { const r = st.rows.find((x) => x.address === a); if (r) toggleFold(r); },
    runs: () => cache.runs.length, buffered: () => st.rows.length, thumb: () => bar.current?.scrollTop ?? 0, dragging: (v: boolean) => { st.dragging = v; },
    busy: () => st.busy,
  };

  useEffect(() => { if (scrollReq.address) { setCur(scrollReq.address); jump(scrollReq.address, true); } }, [scrollReq]); // eslint-disable-line
  useEffect(() => { if (change.n) queue(change.ranges); }, [change]); // eslint-disable-line
  useEffect(() => { // first view: start of the listing
    if (!scrollReq.address) { setTopAddr(); syncThumb(); ensure(); }
  }, [map]); // eslint-disable-line

  useEffect(() => {
    const el = box.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      st.acc += e.deltaY / ROW_H;
      const n = Math.trunc(st.acc); st.acc -= n;
      if (n) scrollLines(n);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    const ro = new ResizeObserver(() => { st.view = Math.ceil(el.clientHeight / ROW_H) + 1; render(); ensure(); });
    ro.observe(el);
    const up = () => { st.dragging = false; };
    window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
    return () => { ++st.gen; clearTimeout(st.prefetch); rowRef.current = null; el.removeEventListener("wheel", wheel); ro.disconnect(); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
  }, []); // eslint-disable-line

  const onBar = () => { // user dragged the scrollbar: fraction -> byte position -> address
    const el = bar.current!;
    if (!map.total) return;
    if (Math.abs(el.scrollTop - st.lastSet) <= 1) return;
    const f = Math.max(0, Math.min(1, el.scrollTop / (SCROLL_H - el.clientHeight)));
    jump(map.addr(f * (map.total - 1)), false);
  };

  const onKey = (e: React.KeyboardEvent) => { // arrows/page move the row cursor (scrolling into view); letters are Ghidra's edit keys
    const n = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "PageDown" ? st.view - 1 : e.key === "PageUp" ? 1 - st.view : 0;
    if (n) { e.preventDefault(); moveCursor(n); return; }
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) { // unfold / fold the components of the cursor row
      const row = st.rows[curIndex()];
      if (row?.parts && st.unfolded.has(row.address) === (e.key === "ArrowLeft")) { e.preventDefault(); toggleFold(row); }
      return;
    }
    if (e.key.toLowerCase() === "x" && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) && st.cur && onXrefs) { e.preventDefault(); onXrefs(st.rows[curIndex()]?.address ?? st.cur); return; } // references to the cursor row
    const a = listingKey(e.nativeEvent);
    if (a && canEdit(a)) { e.preventDefault(); onEdit?.(a); }
  };
  const cp = st.cur ? parseAddr(st.cur) : null;
  const isCur = (r: ListingRow) => { const p = cp && parseAddr(r.address); return !!cp && !!p && p.space === cp.space && cp.off >= p.off && cp.off < p.off + BigInt(Math.max(r.length, 1)); };
  const vis = lines().slice(st.top, st.top + st.view);
  const body = (l: Line) => {
    const r = l.row;
    switch (l.kind) {
      case "plate": return <span className="c pl">; {l.text}</span>;
      case "pre": case "post": return <span className="c">; {l.text}</span>;
      case "header": return (<><span className="hd">{r.header!.signature}</span><span className="hi">{[r.header!.convention, `${r.header!.params} param${r.header!.params === 1 ? "" : "s"}`, `args 0x${r.header!.paramBytes.toString(16)}`, `locals 0x${r.header!.localBytes.toString(16)}`, r.header!.noReturn && "noreturn", r.header!.thunk && "thunk"].filter(Boolean).join(" · ")}</span></>);
      case "label": return <span className="l">{l.text}:</span>;
      case "xref": return (<>
        <span className="xh">XREF[{r.xrefs!.count}]:</span>
        {r.xrefs!.items.map((x) => <a key={x.from} className="xl2" role="link" aria-label={`Go to reference ${x.from}`} onClick={(e) => { e.stopPropagation(); onGo?.(x.from); }}>{x.from}({XK[x.kind] ?? "o"})</a>)}
        {onXrefs && r.xrefs!.count > r.xrefs!.items.length && <a className="xl2 xm" role="link" aria-label="Show all references" onClick={(e) => { e.stopPropagation(); onXrefs?.(r.address); }}>… +{r.xrefs!.count - r.xrefs!.items.length}</a>}
      </>);
      case "part": return (<><span className="a">+{l.part!.offset.toString(16)}</span><span className="m pt">{l.part!.type}</span><span>{l.part!.name} = {l.part!.value}</span></>);
      case "more": return <span className="c">{l.text}</span>;
      default: return (<>
        <span className="a">{r.parts ? <b className="fold" role="button" aria-label={st.unfolded.has(r.address) ? "Fold components" : "Unfold components"} onClick={(e) => { e.stopPropagation(); toggleFold(r); }}>{st.unfolded.has(r.address) ? "▾" : "▸"}</b> : null}{r.address}</span>
        <span className="b" title={bytesText(r)}>{bytesText(r)}</span><span className="m">{r.mnemonic}</span>
        <span>{r.operands}</span>{r.comment && <span className="c">; {r.comment}</span>}{r.repeatable && <span className="c rp">; {r.repeatable}</span>}
      </>);
    }
  };
  return (
    <div className="lbox" ref={box} tabIndex={0} aria-label="Listing" onKeyDown={onKey}>
      <div className="lpane">
        {vis.map((l, i) => (
          <div key={l.key} className={`lrow k-${l.kind}` + (l.kind === "main" ? "" : " lbl") + (isCur(l.row) ? " cursor" : "") + (l.kind === "main" && coverage.current?.has(l.row.address, l.row.length) ? " cov" : "")} style={{ top: i * ROW_H }} aria-current={isCur(l.row) && l.kind === "main" ? "true" : undefined}
            onClick={() => { setCur(l.row.address); box.current?.focus(); render(); onRowClick?.(l.row.address); }}>
            {body(l)}
          </div>
        ))}
        {!vis.length && <div className="lrow ph" style={{ top: 0 }}><span>{map.total ? "…" : "No listing rows"}</span></div>}
      </div>
      <div className="lbar" ref={bar} onScroll={onBar} onPointerDown={() => { st.dragging = true; }}><div style={{ height: SCROLL_H }} /></div>
    </div>
  );
}

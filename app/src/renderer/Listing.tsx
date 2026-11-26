import { useEffect, useRef, useState } from "react";
import type { ListingRow, Address } from "../../../protocol";
import type { AddrMap } from "./addrmap";
import { rpc } from "./client";

const ROW_H = 16;
// Fixed pixel height of the listing scrollbar, independent of binary size (Chromium caps elements near 33.5M px).
const SCROLL_H = 10_000_000;
const BATCH = 100, MARGIN = 60, MAXBUF = 1500; // rows per fetch, prefetch margin in lines, max buffered rows

type Line = { row: ListingRow; label: boolean };
const toLines = (rows: ListingRow[]): Line[] => rows.flatMap((row) => (row.label ? [{ row, label: true }, { row, label: false }] : [{ row, label: false }]));
const nextAddr = (r: ListingRow): Address => "0x" + (BigInt(r.address) + BigInt(r.length)).toString(16);

/**
 * Address-based listing. Buffer = a contiguous run of rows around an anchor; fetched forward/backward by address.
 * Wheel scrolls by lines inside the buffer; the (fixed-height) scrollbar maps fraction -> byte position -> address and jumps.
 * shortcut: no cache beyond the one contiguous buffer; a jump refetches even if the target is already buffered.
 */
export function Listing({ map, scrollReq, topAddrRef, onLatency, onError }: {
  map: AddrMap; scrollReq: { address: Address; n: number }; topAddrRef: { current: Address };
  onLatency: (ms: number) => void; onError: (e: unknown) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  const b = useRef({ rows: [] as ListingRow[], lines: [] as Line[], top: 0, atStart: false, atEnd: false, busy: false, gen: 0, view: 30, lastSet: -1, acc: 0 });
  const st = b.current;
  const render = () => tick((n) => n + 1);

  const maxTop = () => (st.atEnd ? Math.max(0, st.lines.length - st.view) : Math.max(0, st.lines.length - 1));
  const syncThumb = () => {
    const el = bar.current, line = st.lines[st.top];
    if (!el || !line) return;
    const f = map.total > 1 ? map.pos(BigInt(line.row.address)) / (map.total - 1) : 0;
    el.scrollTop = f * (SCROLL_H - el.clientHeight);
    st.lastSet = el.scrollTop;
  };
  const setRows = (rows: ListingRow[], top: number) => { st.rows = rows; st.lines = toLines(rows); st.top = top; };

  const fetchRows = async (address: Address, direction: "forward" | "backward", count = BATCH) => {
    const t0 = performance.now();
    const rows = await rpc.call("listing_rows", { address, count, direction });
    const ms = performance.now() - t0;
    onLatency(Math.round(ms));
    ((window as any).__lst ??= []).push({ ms, direction });
    return rows;
  };

  // keep the buffer filled around the top line; loops until satisfied
  const ensure = async () => {
    if (st.busy || !st.rows.length) return;
    const gen = st.gen;
    const needFwd = !st.atEnd && st.top + st.view + MARGIN > st.lines.length;
    const needBack = !st.atStart && st.top < MARGIN;
    if (!needFwd && !needBack) return;
    st.busy = true;
    try {
      if (needBack) {
        const rows = await fetchRows(st.rows[0].address, "backward");
        if (gen !== st.gen) return;
        if (rows.length < BATCH) st.atStart = true;
        const added = toLines(rows).length;
        setRows([...rows, ...st.rows], st.top + added);
      } else {
        const rows = await fetchRows(nextAddr(st.rows[st.rows.length - 1]), "forward");
        if (gen !== st.gen) return;
        if (rows.length < BATCH) st.atEnd = true;
        setRows([...st.rows, ...rows], st.top);
      }
      trim();
      topAddrRef.current = st.lines[st.top]?.row.address ?? topAddrRef.current;
      render();
    } catch (e) { onError(e); }
    finally { if (gen === st.gen) { st.busy = false; ensure(); } }
  };

  // drop rows far from the top line so the buffer stays small
  const trim = () => {
    if (st.rows.length <= MAXBUF) return;
    const k = st.rows.length - MAXBUF;
    if (st.top > st.lines.length / 2) {
      const removed = toLines(st.rows.slice(0, k)).length;
      st.atStart = false; setRows(st.rows.slice(k), Math.max(0, st.top - removed));
    } else { st.atEnd = false; setRows(st.rows.slice(0, MAXBUF), st.top); }
  };

  const jump = async (address: Address, thumb: boolean) => {
    const gen = ++st.gen;
    st.busy = false;
    try {
      const rows = await fetchRows(address, "forward");
      if (gen !== st.gen) return;
      st.atStart = false; st.atEnd = rows.length < BATCH;
      setRows(rows, 0);
      st.top = Math.min(st.top, maxTop());
      topAddrRef.current = st.lines[st.top]?.row.address ?? "";
      if (thumb) syncThumb();
      render(); ensure();
    } catch (e) { onError(e); }
  };

  const scrollLines = (n: number) => {
    const before = st.top;
    st.top = Math.max(0, Math.min(st.top + n, maxTop()));
    topAddrRef.current = st.lines[st.top]?.row.address ?? topAddrRef.current;
    syncThumb(); render(); ensure();
    return st.top - before;
  };
  (window as any).__listing = { jump: (a: Address) => jump(a, true), scrollLines, top: () => topAddrRef.current };

  useEffect(() => { if (scrollReq.address) jump(scrollReq.address, true); }, [scrollReq]); // eslint-disable-line
  useEffect(() => { // first view: start of the listing
    if (!scrollReq.address) jump(map.addr(0), true);
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
    return () => { el.removeEventListener("wheel", wheel); ro.disconnect(); };
  }, []); // eslint-disable-line

  const onBar = () => { // user dragged the scrollbar: fraction -> byte position -> address
    const el = bar.current!;
    if (Math.abs(el.scrollTop - st.lastSet) <= 1) return;
    const f = Math.max(0, Math.min(1, el.scrollTop / (SCROLL_H - el.clientHeight)));
    jump(map.addr(f * (map.total - 1)), false);
  };

  const vis = st.lines.slice(st.top, st.top + st.view);
  return (
    <div className="lbox" ref={box}>
      <div className="lpane">
        {vis.map((l, i) => (
          <div key={l.row.address + (l.label ? "L" : "")} className={"lrow" + (l.label ? " lbl" : "")} style={{ top: i * ROW_H }}>
            {l.label ? <span className="l">{l.row.label}:</span> : (<>
              <span className="a">{l.row.address}</span><span className="b">{l.row.bytes}</span><span className="m">{l.row.mnemonic}</span>
              <span>{l.row.operands}</span>{l.row.comment && <span className="c">; {l.row.comment}</span>}
            </>)}
          </div>
        ))}
        {!vis.length && <div className="lrow ph" style={{ top: 0 }}><span>…</span></div>}
      </div>
      <div className="lbar" ref={bar} onScroll={onBar}><div style={{ height: SCROLL_H }} /></div>
    </div>
  );
}

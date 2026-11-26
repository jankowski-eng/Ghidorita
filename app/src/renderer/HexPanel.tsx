import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "../../../protocol";
import type { ListingReads } from "./backend";
import type { AddrMap } from "./addrmap";
import { fmtAddr, parseAddr } from "./address";
import { formatRow, hexLayout, parseHex, ROW, rowOf, segAt, type HexSeg } from "./hex";
import { isFailure, isObsolete } from "./backend";

const RH = 18, CHUNK_ROWS = 256, CHUNK = CHUNK_ROWS * ROW, MAX_H = 8_000_000, CACHE = 128; // 4 KiB per request; the scroll height is capped, a bigger layout scales
type Chunk = { lo: bigint; bytes: number[] | null };

/**
 * Hex view (read-only): offset, 16 bytes per row, ASCII; follows the shared cursor and highlights the bytes of the code unit under it.
 * Rows come from `get_bytes` in 4 KiB pages as the view scrolls; only mapped ranges are requested, the rest shows as gaps. Clicking a byte moves the cursor.
 */
export function HexPanel({ read, unit, map, cursor, version, onGo, onError }: {
  read: ListingReads["bytes"]; unit: (a: Address) => Promise<{ address: Address; length: number } | null>; map: AddrMap; cursor: Address | null; version: number;
  onGo: (a: Address) => void; onError: (e: unknown) => void;
}) {
  const layout = useMemo(() => hexLayout(map.ranges), [map]);
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0), [view, setView] = useState(24), [tick, setTick] = useState(0);
  const [mark, setMark] = useState<{ space: string; lo: bigint; hi: bigint } | null>(null);
  const cache = useRef(new Map<string, Chunk>()), asked = useRef(new Set<string>()), gen = useRef(0);
  const spacer = Math.min(layout.rows * RH, MAX_H), scaled = layout.rows * RH > MAX_H;
  const rowAtScroll = (st: number, ch: number) => {
    const span = Math.max(1, spacer - ch);
    return Math.max(0, Math.min(layout.rows - 1, scaled ? Math.round((st / span) * Math.max(0, layout.rows - Math.floor(ch / RH))) : Math.floor(st / RH)));
  };
  const scrollToRow = (r: number) => {
    const el = box.current; if (!el) return;
    const span = Math.max(1, spacer - el.clientHeight);
    el.scrollTop = scaled ? (r / Math.max(1, layout.rows - Math.floor(el.clientHeight / RH))) * span : r * RH;
  };
  const onScroll = () => { const el = box.current; if (el) setTop(rowAtScroll(el.scrollTop, el.clientHeight)); };
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => { setView(Math.max(1, Math.ceil(el.clientHeight / RH))); onScroll(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]); // eslint-disable-line

  useEffect(() => { gen.current++; cache.current.clear(); asked.current.clear(); setTick((t) => t + 1); }, [version, layout]);

  // fetch the pages of the rows in view and one screen around them
  useEffect(() => {
    const g = gen.current, want = new Map<string, [HexSeg, number]>();
    for (let r = Math.max(0, top - view); r < Math.min(layout.rows, top + 2 * view + 1); r++) {
      const s = segAt(layout, r);
      if (!s || s.kind === "gap") continue;
      const c = Math.floor((r - s.row) / CHUNK_ROWS), key = `${s.space}|${s.base}|${c}`;
      if (!asked.current.has(key)) want.set(key, [s, c]);
    }
    for (const [key, [s, c]] of want) {
      asked.current.add(key);
      const lo = s.base + BigInt(c * CHUNK) > s.lo ? s.base + BigInt(c * CHUNK) : s.lo, end = s.base + BigInt((c + 1) * CHUNK), hi = end < s.hi ? end : s.hi;
      const length = Number(hi - lo);
      read({ address: fmtAddr(s.space, lo), length }).then((r) => parseHex(r.bytes, length), (e) => {
        if (g === gen.current && !isFailure(e, "notFound") && !isObsolete(e)) onError(e);
        return null; // NotFound (a page that is not all initialized memory) shows as unreadable, not as a failure
      }).then((bytes) => {
        if (g !== gen.current) return;
        cache.current.set(key, { lo, bytes });
        while (cache.current.size > CACHE) { const old = cache.current.keys().next().value!; cache.current.delete(old); asked.current.delete(old); }
        setTick((t) => t + 1);
      });
    }
  }, [top, view, layout, version]); // eslint-disable-line

  // the cursor: the bytes of its code unit, scrolled into view when they are not
  useEffect(() => {
    const p = cursor ? parseAddr(cursor) : null;
    let live = true;
    if (!p) { setMark(null); return; }
    setMark({ space: p.space, lo: p.off, hi: p.off + 1n });
    unit(cursor!).then((u) => {
      const q = u && parseAddr(u.address);
      if (live && q && q.space === p.space && q.off <= p.off && q.off + BigInt(u!.length) > p.off) setMark({ space: p.space, lo: q.off, hi: q.off + BigInt(u!.length) });
    }, () => {});
    const r = rowOf(layout, p.space, p.off), el = box.current;
    if (r !== null && el) {
      const rows = Math.max(1, Math.floor(el.clientHeight / RH));
      if (r < top || r >= top + rows - 1) scrollToRow(Math.max(0, r - Math.floor(rows / 3)));
    }
    return () => { live = false; };
  }, [cursor, layout]); // eslint-disable-line

  const lines = [];
  for (let r = top; r < Math.min(layout.rows, top + view + 1); r++) {
    const s = segAt(layout, r);
    if (!s) break;
    const k = r - s.row, c = Math.floor(k / CHUNK_ROWS);
    const ch = cache.current.get(`${s.space}|${s.base}|${c}`);
    const line = formatRow(s, k, (o) => (!ch ? undefined : ch.bytes ? ch.bytes[Number(o - ch.lo)] : null));
    if (line.gap) { lines.push(<div key={r} className="hx-row hx-gap" role="row" aria-label={line.gap}>{line.gap}</div>); continue; }
    const on = (i: number) => !!mark && mark.space === s.space && line.base + BigInt(i) >= mark.lo && line.base + BigInt(i) < mark.hi;
    const inRange = (i: number) => line.cells[i] !== "  ";
    const go = (i: number) => { if (inRange(i)) onGo(fmtAddr(s.space, line.base + BigInt(i))); };
    lines.push(
      <div key={r} className="hx-row" role="row" aria-rowindex={r + 1}>
        <span className="hx-off">{line.address}</span>
        <span className="hx-bytes">{line.cells.map((t, i) => <span key={i} role="gridcell" className={"hx-b" + (on(i) ? " cur" : "") + (t === "??" ? " bad" : "") + (i === 8 ? " mid" : "")} onClick={() => go(i)}>{t}</span>)}</span>
        <span className="hx-ascii">{[...line.ascii].map((t, i) => <span key={i} className={on(i) ? "cur" : undefined} onClick={() => go(i)}>{t}</span>)}</span>
      </div>,
    );
  }
  void tick; // re-render when a page arrives
  return (
    <div className="panel" role="region" aria-label="Bytes">
      <div className="ph-bar"><span role="status" aria-label="Bytes state">{layout.rows ? `${map.total} bytes in ${layout.segs.filter((s) => s.kind === "data").length} range(s)` : "no mapped memory"}</span></div>
      <div className="hx-scroll" ref={box} tabIndex={0} onScroll={onScroll}>
        <div style={{ height: spacer, position: "relative" }}>
          <div className="hx-view" role="grid" aria-label="Hex dump" aria-rowcount={layout.rows}>{lines}</div>
        </div>
      </div>
    </div>
  );
}

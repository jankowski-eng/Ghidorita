import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FunctionInfo, ListingRow, Token, Address } from "../../../protocol";
import { Rpc, RpcError } from "./rpc";
import { AddrMap } from "./addrmap";

const ROW_H = 16;
// Fixed pixel height of the listing scrollbar, independent of binary size (Chromium caps elements near 33.5M px).
const SCROLL_H = 10_000_000;
const BATCH = 100, MARGIN = 60, MAXBUF = 1500; // rows per fetch, prefetch margin in lines, max buffered rows
const rpc = new Rpc();
type Progress = { phase: string; pct: number; message: string };
type Stats = { listingMs?: number; decompileMs?: number };

export function App() {
  const [path, setPath] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [opened, setOpened] = useState(false);
  const [funcs, setFuncs] = useState<FunctionInfo[]>([]);
  const [map, setMap] = useState<AddrMap | null>(null);
  const [selected, setSelected] = useState<Address | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [text, setText] = useState("");
  const [history, setHistory] = useState<Address[]>([]);
  const [scrollReq, setScrollReq] = useState({ address: "" as Address, n: 0 });
  const [stats, setStats] = useState<Stats>({});
  const [error, setError] = useState("");
  const decompileSeq = useRef(0);
  const inflightId = useRef<number | null>(null);
  const selectedRef = useRef<Address | null>(null);
  const topAddrRef = useRef<Address>("");
  const errors = useRef<string[]>([]);
  const tokensRef = useRef<Token[]>([]);
  tokensRef.current = tokens;

  const fail = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); errors.current.push(m); setError(m); };

  const select = useCallback(async (entry: Address, push = true) => {
    const seq = ++decompileSeq.current;
    if (inflightId.current !== null) rpc.call("cancel_decompile", { id: inflightId.current }).catch(() => {});
    if (push && selectedRef.current && selectedRef.current !== entry) { const prev = selectedRef.current; setHistory((h) => [...h, prev]); }
    selectedRef.current = entry;
    setSelected(entry);
    setScrollReq((s) => ({ address: entry, n: s.n + 1 }));
    const t0 = performance.now();
    const p = rpc.call("decompile", { entry });
    const myId = inflightId.current = rpc.lastId;
    try {
      const r = await p;
      if (seq !== decompileSeq.current) return; // stale
      setText(r.text); setTokens(r.tokens);
      setStats((s) => ({ ...s, decompileMs: Math.round(performance.now() - t0) }));
    } catch (e) {
      if (seq !== decompileSeq.current || (e instanceof RpcError && e.code === -32002)) return; // cancelled/stale
      fail(e);
    } finally { if (inflightId.current === myId) inflightId.current = null; }
  }, []);

  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    select(prev, false);
  };

  const open = useCallback(async (p: string) => {
    setOpened(false); setError(""); setProgress({ phase: "import", pct: 0, message: "starting" });
    try {
      await rpc.call("open_binary", { path: p });
      const [fl, info] = await Promise.all([rpc.call("list_functions", {}), rpc.call("listing_info", {})]);
      setFuncs(fl); setMap(new AddrMap(info.ranges)); setHistory([]); setOpened(true);
      return fl;
    } catch (e) { fail(e); } finally { setProgress(null); }
  }, []);

  // Monaco token click -> navigate
  const clickAt = useCallback((line1: number, col1: number) => {
    const t = tokensRef.current.find((t) => t.targetFunction && t.line + 1 === line1 && col1 >= t.colStart + 1 && col1 < t.colEnd + 1);
    if (t?.targetFunction) return select(t.targetFunction);
  }, [select]);
  const clickAtRef = useRef(clickAt); clickAtRef.current = clickAt;

  const decorations = useRef<any>(null);
  const editorRef = useRef<any>(null);
  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    decorations.current = editor.createDecorationsCollection();
    editor.onMouseDown((e) => { if (e.target.position) clickAtRef.current(e.target.position.lineNumber, e.target.position.column); });
    void monaco;
  };
  useEffect(() => {
    decorations.current?.set(tokens.filter((t) => t.targetFunction).map((t) => ({
      range: { startLineNumber: t.line + 1, startColumn: t.colStart + 1, endLineNumber: t.line + 1, endColumn: t.colEnd + 1 },
      options: { inlineClassName: "call-token" },
    })));
  }, [tokens, text]);

  // startup: connect, optional autotest
  useEffect(() => {
    (async () => {
      const cfg = await window.host.getConfig();
      await rpc.connect(cfg.port, cfg.token);
      rpc.onNotification = (m, p) => {
        if (m === "progress") setProgress(p as Progress);
        else if (m === "error") fail((p as { message: string }).message);
      };
      if (cfg.autotest) runAutotest(cfg.autotest);
    })().catch(fail);
  }, []);

  async function runAutotest(file: string) {
    const result: Record<string, unknown> = { ok: false };
    try {
      setPath(file);
      const fl = await open(file);
      if (!fl?.length) throw new Error("no functions");
      // pick main (or first), else walk the first few functions until one has a call token
      const order = [...fl.filter((f) => f.name === "main"), ...fl.slice(0, 10)];
      let clicked = false;
      for (const f of order) {
        const r = await rpc.call("decompile", { entry: f.entry });
        const tok = r.tokens.find((t) => t.targetFunction && t.targetFunction !== f.entry); // a real call to another function
        if (!tok) continue;
        await select(f.entry);
        await new Promise((r) => setTimeout(r, 300));
        result.startFunction = f.name;
        result.clickedToken = { line: tok.line, colStart: tok.colStart, target: tok.targetFunction };
        await clickAtRef.current(tok.line + 1, tok.colStart + 2); // same path as a Monaco mouse click
        clicked = true;
        break;
      }
      if (!clicked) throw new Error("no call token found");
      await new Promise((r) => setTimeout(r, 1000));
      result.selectedEntry = selectedRef.current;
      result.expectedEntry = (result.clickedToken as any).target;
      result.listingTopAddress = topAddrRef.current;
      result.editorFirstLine = (editorRef.current?.getValue() ?? "").split("\n")[0];
      result.functions = fl.length; result.totalBytes = (await rpc.call("listing_info", {})).totalBytes;
      result.ok = result.expectedEntry !== fl.find((f) => f.name === result.startFunction)?.entry && result.selectedEntry === result.expectedEntry && result.listingTopAddress === result.selectedEntry && errors.current.length === 0;
    } catch (e) { fail(e); }
    result.errors = errors.current;
    window.host.autotestDone(result);
  }

  return (
    <div className="app">
      <div className="bar">
        <button onClick={async () => { const p = await window.host.pickFile(); if (p) { setPath(p); open(p); } }}>Open binary…</button>
        <input type="text" placeholder="or type a path and press Enter" value={path} onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && path && open(path)} />
        <button onClick={back} disabled={!history.length}>← Back</button>
      </div>
      {progress && (
        <div className="progress">
          <div style={{ width: progress.pct < 0 ? "100%" : `${progress.pct}%`, opacity: progress.pct < 0 ? 0.4 : 1 }} />
          <span>{progress.phase}: {progress.message}{progress.pct >= 0 ? ` (${progress.pct}%)` : ""}</span>
        </div>
      )}
      {opened ? (
        <div className="main">
          <FuncList funcs={funcs} selected={selected} onSelect={(e) => select(e)} />
          <div className="right">
            <div className="editor">
              <Editor language="c" theme="vs-dark" value={text} onMount={onMount}
                options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }} />
            </div>
            <div className="listing"><Listing map={map!} scrollReq={scrollReq} topAddrRef={topAddrRef} onLatency={(ms) => setStats((s) => ({ ...s, listingMs: ms }))} onError={fail} /></div>
          </div>
        </div>
      ) : <div style={{ flex: 1, padding: 16 }}>Open a binary to begin.</div>}
      <div className="status">
        <span>selected: {selected ?? "-"} | bytes: {map?.total ?? 0} | funcs: {funcs.length} | last listing page: {stats.listingMs ?? "-"} ms | last decompile: {stats.decompileMs ?? "-"} ms</span>
        {error && <span className="err"> | {error}</span>}
      </div>
    </div>
  );
}

function FuncList({ funcs, selected, onSelect }: { funcs: FunctionInfo[]; selected: Address | null; onSelect: (e: Address) => void }) {
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

type Line = { row: ListingRow; label: boolean };
const toLines = (rows: ListingRow[]): Line[] => rows.flatMap((row) => (row.label ? [{ row, label: true }, { row, label: false }] : [{ row, label: false }]));
const nextAddr = (r: ListingRow): Address => "0x" + (BigInt(r.address) + BigInt(r.length)).toString(16);

/**
 * Address-based listing. Buffer = a contiguous run of rows around an anchor; fetched forward/backward by address.
 * Wheel scrolls by lines inside the buffer; the (fixed-height) scrollbar maps fraction -> byte position -> address and jumps.
 * shortcut: no cache beyond the one contiguous buffer; a jump refetches even if the target is already buffered.
 */
function Listing({ map, scrollReq, topAddrRef, onLatency, onError }: {
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
    st.top = Math.max(0, Math.min(st.top + n, maxTop()));
    topAddrRef.current = st.lines[st.top]?.row.address ?? topAddrRef.current;
    syncThumb(); render(); ensure();
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

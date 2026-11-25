import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FunctionInfo, ListingRow, Token, Address } from "../../../protocol";
import { Rpc, RpcError } from "./rpc";

const PAGE = 200;
// shortcut: 16px * rowCount must stay under Chromium's ~33.5M px element height (~2.09M rows); beyond that needs a scaled virtual scrollbar
const ROW_H = 16;
const rpc = new Rpc();
type Progress = { phase: string; pct: number; message: string };
type Stats = { listingMs?: number; decompileMs?: number };

export function App() {
  const [path, setPath] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [opened, setOpened] = useState(false);
  const [funcs, setFuncs] = useState<FunctionInfo[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [selected, setSelected] = useState<Address | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [text, setText] = useState("");
  const [history, setHistory] = useState<Address[]>([]);
  const [scrollReq, setScrollReq] = useState({ index: -1, n: 0 });
  const [stats, setStats] = useState<Stats>({});
  const [error, setError] = useState("");
  const decompileSeq = useRef(0);
  const inflightDecompile = useRef(false);
  const selectedRef = useRef<Address | null>(null);
  const topRowRef = useRef(0);
  const errors = useRef<string[]>([]);
  const tokensRef = useRef<Token[]>([]);
  tokensRef.current = tokens;

  const fail = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); errors.current.push(m); setError(m); };

  const select = useCallback(async (entry: Address, push = true) => {
    const seq = ++decompileSeq.current;
    if (inflightDecompile.current) rpc.call("cancel_decompile", {}).catch(() => {});
    if (push && selectedRef.current && selectedRef.current !== entry) { const prev = selectedRef.current; setHistory((h) => [...h, prev]); }
    selectedRef.current = entry;
    setSelected(entry);
    rpc.call("address_to_row", { address: entry }).then((r) => seq === decompileSeq.current && setScrollReq((s) => ({ index: r.index, n: s.n + 1 })), fail);
    inflightDecompile.current = true;
    const t0 = performance.now();
    try {
      const r = await rpc.call("decompile", { entry });
      if (seq !== decompileSeq.current) return; // stale
      setText(r.text); setTokens(r.tokens);
      setStats((s) => ({ ...s, decompileMs: Math.round(performance.now() - t0) }));
    } catch (e) {
      if (seq !== decompileSeq.current || (e instanceof RpcError && e.code === -32002)) return; // cancelled/stale
      fail(e);
    } finally { if (seq === decompileSeq.current) inflightDecompile.current = false; }
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
      setFuncs(fl); setRowCount(info.rowCount); setHistory([]); setOpened(true);
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
        const tok = r.tokens.find((t) => t.targetFunction);
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
      result.listingTopRow = topRowRef.current;
      result.listingTopAddress = (await rpc.call("row_to_address", { index: topRowRef.current })).address;
      result.editorFirstLine = (editorRef.current?.getValue() ?? "").split("\n")[0];
      result.functions = fl.length; result.rowCount = rowCount || (await rpc.call("listing_info", {})).rowCount;
      result.ok = result.selectedEntry === result.expectedEntry && result.listingTopAddress === result.selectedEntry && errors.current.length === 0;
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
            <div className="listing"><Listing rowCount={rowCount} scrollReq={scrollReq} topRowRef={topRowRef} onLatency={(ms) => setStats((s) => ({ ...s, listingMs: ms }))} onError={fail} /></div>
          </div>
        </div>
      ) : <div style={{ flex: 1, padding: 16 }}>Open a binary to begin.</div>}
      <div className="status">
        <span>selected: {selected ?? "-"} | rows: {rowCount} | funcs: {funcs.length} | last listing page: {stats.listingMs ?? "-"} ms | last decompile: {stats.decompileMs ?? "-"} ms</span>
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

function Listing({ rowCount, scrollReq, topRowRef, onLatency, onError }: {
  rowCount: number; scrollReq: { index: number; n: number }; topRowRef: { current: number };
  onLatency: (ms: number) => void; onError: (e: unknown) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<number, ListingRow[]>());
  const inflight = useRef(new Set<number>());
  const [, tick] = useState(0);
  const v = useVirtualizer({ count: rowCount, getScrollElement: () => ref.current, estimateSize: () => ROW_H, overscan: 20 });

  useEffect(() => { if (scrollReq.index >= 0) v.scrollToIndex(scrollReq.index, { align: "start" }); }, [scrollReq]); // eslint-disable-line

  const items = v.getVirtualItems();
  topRowRef.current = Math.round((v.scrollOffset ?? 0) / ROW_H);

  // fetch only pages touched by the rendered range (visible + overscan); no cache eviction
  // shortcut: unbounded page cache, add LRU eviction if memory matters for huge listings
  const first = items.length ? Math.floor(items[0].index / PAGE) : -1;
  const last = items.length ? Math.floor(items[items.length - 1].index / PAGE) : -1;
  useEffect(() => {
    for (let p = first; p >= 0 && p <= last; p++) {
      if (pages.current.has(p) || inflight.current.has(p)) continue;
      inflight.current.add(p);
      const t0 = performance.now();
      rpc.call("listing_rows", { startIndex: p * PAGE, count: PAGE }).then((rows) => {
        pages.current.set(p, rows); onLatency(Math.round(performance.now() - t0)); tick((n) => n + 1);
      }, onError).finally(() => inflight.current.delete(p));
    }
  }, [first, last]); // eslint-disable-line

  return (
    <div className="scroll" ref={ref}>
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {items.map((it) => {
          const r = pages.current.get(Math.floor(it.index / PAGE))?.[it.index % PAGE];
          return (
            <div key={it.index} className={"lrow" + (r ? "" : " ph")} style={{ top: it.start }}>
              {r ? (<>
                <span className="a">{r.address}</span><span className="b">{r.bytes}</span><span className="m">{r.mnemonic}</span>
                <span>{r.operands}</span>{r.label && <span className="l">{r.label}:</span>}{r.comment && <span className="c">; {r.comment}</span>}
              </>) : <span>…</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

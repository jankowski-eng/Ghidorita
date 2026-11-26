import { useEffect, useRef, useState, useCallback } from "react";
import type { FunctionInfo, Token, Address } from "../../../protocol";
import { RpcError } from "./rpc";
import { rpc } from "./client";
import { AddrMap } from "./addrmap";
import { Listing } from "./Listing";
import { FunctionList } from "./FunctionList";
import { Decompiler } from "./Decompiler";
import { Toolbar, ProgressBar, type Progress } from "./Toolbar";
import { StatusBar, type Stats } from "./StatusBar";
import { runAutotest, runBench } from "./autotest";

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
  const editorRef = useRef<any>(null);

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

  // startup: connect, optional autotest
  useEffect(() => {
    (async () => {
      const cfg = await window.host.getConfig();
      await rpc.connect(cfg.port, cfg.token);
      rpc.onNotification = (m, p) => {
        if (m === "progress") setProgress(p as Progress);
        else if (m === "error") fail((p as { message: string }).message);
      };
      if (cfg.autotest) (cfg.bench ? runBench : runAutotest)(cfg.autotest, {
        open, select, clickAt, setPath, fail, errors: errors.current,
        selected: () => selectedRef.current, topAddr: () => topAddrRef.current, editorText: () => editorRef.current?.getValue() ?? "",
      });
    })().catch(fail);
  }, []);

  return (
    <div className="app">
      <Toolbar path={path} setPath={setPath} canBack={!!history.length} onBack={back} onOpen={() => open(path)}
        onPick={async () => { const p = await window.host.pickFile(); if (p) { setPath(p); open(p); } }} />
      {progress && <ProgressBar progress={progress} />}
      {opened ? (
        <div className="main">
          <FunctionList funcs={funcs} selected={selected} onSelect={(e) => select(e)} />
          <div className="right">
            <div className="editor"><Decompiler text={text} tokens={tokens} onCallClick={clickAt} editorRef={editorRef} /></div>
            <div className="listing"><Listing map={map!} scrollReq={scrollReq} topAddrRef={topAddrRef} onLatency={(ms) => setStats((s) => ({ ...s, listingMs: ms }))} onError={fail} /></div>
          </div>
        </div>
      ) : <div style={{ flex: 1, padding: 16 }}>Open a binary to begin.</div>}
      <StatusBar selected={selected} bytes={map?.total ?? 0} funcs={funcs.length} stats={stats} error={error} />
    </div>
  );
}

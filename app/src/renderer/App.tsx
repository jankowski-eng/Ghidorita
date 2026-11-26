import { useEffect, useMemo, useRef, useState } from "react";
import type { FunctionInfo, Address } from "../../../protocol";
import { rpc } from "./client";
import { AddrMap } from "./addrmap";
import { Listing } from "./Listing";
import { FunctionList } from "./FunctionList";
import { Decompiler } from "./Decompiler";
import { Toolbar } from "./Toolbar";
import { OpenDialog, type Progress } from "./OpenDialog";
import { SearchPanel } from "./SearchPanel";
import { XrefPanel } from "./XrefPanel";
import { RpcError } from "./rpc";
import { onProgramChanged } from "./changes";
import { latest } from "./latest";
import { StatusBar, type Stats } from "./StatusBar";
import { TabStrip } from "./TabStrip";
import { GoTo } from "./GoTo";
import { Panes, type PaneId } from "./Layout";
import { runAutotest, runBench } from "./autotest";
import { emptyNav, push, goBack, goForward, type Nav, type Loc, type Source } from "./nav";
import { containingFunction, clearFunctionCache, searchSymbols, type FuncAt } from "./symbols";
import { useTabs } from "./useTabs";

export function App() {
  const [path, setPath] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [opened, setOpened] = useState(false);
  const [funcs, setFuncs] = useState<FunctionInfo[]>([]);
  const [map, setMap] = useState<AddrMap | null>(null);
  const [nav, setNavState] = useState<Nav>(emptyNav);
  const [scrollReq, setScrollReq] = useState({ address: "" as Address, n: 0 });
  const [stats, setStats] = useState<Stats>({});
  const [error, setError] = useState("");
  const [gotoOpen, setGotoOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [opening, setOpening] = useState<{ path: string; startedAt: number; cancelling: boolean } | null>(null);
  const [notice, setNoticeState] = useState("");
  const noticeRef = useRef("");
  const setNotice = (m: string) => { noticeRef.current = m; setNoticeState(m); };
  const [fn, setFn] = useState<FuncAt | null>(null);
  const [xrefVersion, setXrefVersion] = useState(0);
  const [visible, setVisible] = useState<Record<PaneId, boolean>>({ functions: true, listing: true, decompiler: true });
  const navRef = useRef(nav);
  const openingRef = useRef(false);
  const openedRef = useRef(false);
  const cancellingRef = useRef(false);
  const goSeq = useRef(0);
  const refetch = useRef(latest()).current;
  const topAddrRef = useRef<Address>("");
  const errors = useRef<string[]>([]);
  const autotestRef = useRef(false);
  const editorRef = useRef<any>(null);

  const fail = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); errors.current.push(m); setError(m); };
  const tabs = useTabs(fail, (ms) => setStats((s) => ({ ...s, decompileMs: ms })));
  const names = useMemo(() => new Map(funcs.map((f) => [f.entry, f.name])), [funcs]);

  const setNav = (n: Nav) => { navRef.current = n; setNavState(n); };
  // Every navigation ends here: scroll the listing (except for a click inside it) and show the containing function.
  // Only the newest navigation may open a tab (goSeq), so a slow get_function_at can't override a later click.
  const applyLoc = async (loc: Loc, viaHistory: boolean, seq: number): Promise<void> => {
    if (viaHistory || loc.source !== "listing") setScrollReq((s) => ({ address: loc.address, n: s.n + 1 }));
    let f: FuncAt | null = null;
    let err: unknown = null;
    try { f = await containingFunction(loc.address); } catch (e) { err = e; }
    if (seq !== goSeq.current) return;
    if (err && !(err instanceof RpcError && err.code === -32001)) fail(err);
    setFn(f);
    if (f) await tabs.show(f.entry);
  };
  const go = async (address: Address, source: Source) => {
    if (openingRef.current || !openedRef.current) return;
    const seq = ++goSeq.current;
    const loc: Loc = { address, source }, cur = navRef.current.current;
    // reading in the listing must not flood the history: clicks within one function replace the current entry
    let sameFn = false;
    if (cur?.source === "listing" && source === "listing") {
      try { const [a, b] = await Promise.all([containingFunction(cur.address), containingFunction(address)]); sameFn = !!a && a.entry === b?.entry; } catch { /* treat as different */ }
      if (seq !== goSeq.current) return;
    }
    setNav(sameFn ? { ...navRef.current, current: loc } : push(navRef.current, loc));
    await applyLoc(loc, false, seq);
  };
  const goTab = (entry: Address | null) => { if (entry) void go(entry, "functions"); }; // keep list/status/listing in step with the visible tab
  const back = () => { const n = goBack(navRef.current); if (n !== navRef.current && !openingRef.current) { setNav(n); void applyLoc(n.current!, true, ++goSeq.current); } };
  const forward = () => { const n = goForward(navRef.current); if (n !== navRef.current && !openingRef.current) { setNav(n); void applyLoc(n.current!, true, ++goSeq.current); } };

  const open = async (p: string) => {
    if (openingRef.current) return; // the sidecar would answer Busy
    openingRef.current = true; openedRef.current = false; cancellingRef.current = false; setSearchOpen(false); setGotoOpen(false);
    setOpened(false); setError(""); setNotice(""); setProgress(null); setOpening({ path: p, startedAt: Date.now(), cancelling: false });
    tabs.reset(); setNav(emptyNav); setFuncs([]); setMap(null); setFn(null); clearFunctionCache(); ++goSeq.current;
    try {
      await rpc.call("open_binary", { path: p });
      const [fl, info] = await Promise.all([rpc.call("list_functions", {}), rpc.call("listing_info", {})]);
      setFuncs(fl); setMap(new AddrMap(info.ranges)); setOpened(true); openedRef.current = true;
      if (!autotestRef.current) window.host.recentAdd(p).catch(() => {});
      return fl;
    } catch (e) {
      if (e instanceof RpcError && e.code === -32002) setNotice("Open cancelled."); // not an error
      else { fail(e); setNotice("Could not open " + p); }
    } finally { openingRef.current = false; setOpening(null); setProgress(null); }
  };
  const cancelOpen = () => {
    if (!openingRef.current) return;
    cancellingRef.current = true;
    setOpening((o) => (o ? { ...o, cancelling: true } : o));
    rpc.call("cancel_open", {}).then((r) => { if (!r.cancelled) cancellingRef.current = false; if (!r.cancelled) setOpening((o) => (o ? { ...o, cancelling: false } : o)); }, fail); // false: open not cancellable yet, let the user retry
  };

  // program_changed: one subscription, all reactions in changes.ts
  const programChanged = (p: Parameters<typeof onProgramChanged>[0]) => {
    if (!openedRef.current) return;
    clearFunctionCache();
    onProgramChanged(p, {
      refetchFunctions: async () => { const fl = await refetch(rpc.call("list_functions", {})); if (fl) setFuncs(fl); return fl ?? []; },
      tabs: () => tabsRef.current().tabs,
      reloadTab: (id) => tabs.reload(id),
      refreshListing: () => { const a = topAddrRef.current; if (a) setScrollReq((s) => ({ address: a, n: s.n + 1 })); },
      refreshXrefs: () => setXrefVersion((v) => v + 1),
    }).catch((e) => { if (!(e instanceof RpcError && e.code === -32001)) fail(e); });
  };

  // Monaco token click -> navigate
  const clickAt = (line1: number, col1: number) => {
    const d = tabs.data[tabs.state.active ?? -1];
    const t = d?.tokens.find((t) => t.targetFunction && t.line + 1 === line1 && col1 >= t.colStart + 1 && col1 < t.colEnd + 1);
    if (t?.targetFunction) go(t.targetFunction, "decompiler");
  };

  // Handlers registered once (startup, menu, mouse) call the latest closures through this.
  const apiNow = { go, back, forward, clickAt, open, cancelOpen, programChanged, closeTab: () => goTab(tabs.closeActive()) };
  const api = useRef(apiNow);
  api.current = apiNow;

  useEffect(() => {
    (async () => {
      const cfg = await window.host.getConfig();
      await rpc.connect(cfg.port, cfg.token);
      rpc.onNotification = (m, p) => {
        if (m === "progress") { if (openingRef.current && !cancellingRef.current) setProgress(p as Progress); } // late progress after cancel is dropped
        else if (m === "program_changed") api.current.programChanged(p as Parameters<typeof onProgramChanged>[0]);
        else if (m === "error") fail((p as { message: string }).message);
      };
      autotestRef.current = !!cfg.autotest;
      if (cfg.autotest) (cfg.bench ? runBench : runAutotest)(cfg.autotest, {
        open: (p) => api.current.open(p), cancelOpen: () => api.current.cancelOpen(), cancelFile: cfg.cancelFile,
        status: () => ({ opened: openedRef.current, opening: openingRef.current, phase: progressRef.current?.phase ?? "", notice: noticeRef.current }),
        searchAndGo: async (q) => { const h = (await searchSymbols(q, 100)).find((x) => x.kind === "function"); if (!h) return null; await api.current.go(h.address, "search"); return h.address; },
        select: async (e) => { await api.current.go(e, "functions"); }, clickAt: (l, c) => api.current.clickAt(l, c),
        back: () => api.current.back(), forward: () => api.current.forward(), setPath, fail, errors: errors.current,
        selected: () => { const t = tabsRef.current(); return t.tabs.find((x) => x.id === t.active)?.entry ?? null; },
        topAddr: () => topAddrRef.current, editorText: () => editorRef.current?.getValue() ?? "",
      });
    })().catch(fail);
    const off = window.host.onMenu((c) => {
      if (c.type === "open-path") { if (!openingRef.current) { setPath(c.path); api.current.open(c.path); } }
      else if (c.type === "search") { if (openedRef.current) setSearchOpen(true); }
      else if (c.type === "nav-back") api.current.back();
      else if (c.type === "nav-forward") api.current.forward();
      else if (c.type === "goto") { if (openedRef.current) setGotoOpen(true); }
      else if (c.type === "close-tab") api.current.closeTab();
      else if (c.type === "toggle-pane") setVisible((v) => ({ ...v, [c.pane]: c.visible }));
    });
    const mouse = (e: MouseEvent) => { // buttons 4/5 = back/forward
      if (e.button === 3) { e.preventDefault(); api.current.back(); } else if (e.button === 4) { e.preventDefault(); api.current.forward(); }
    };
    window.addEventListener("mouseup", mouse);
    return () => { off(); window.removeEventListener("mouseup", mouse); };
  }, []);

  const tabsRef = useRef(() => tabs.state); tabsRef.current = () => tabs.state;
  const canBack = nav.back.length > 0, canForward = nav.forward.length > 0;
  useEffect(() => { window.host.setMenuState({ canBack, canForward }).catch(() => {}); }, [canBack, canForward]);

  const progressRef = useRef(progress); progressRef.current = progress;
  const here = nav.current?.address ?? null;
  const active = tabs.state.tabs.find((t) => t.id === tabs.state.active) ?? null;
  const ad = active ? tabs.data[active.id] : undefined;

  return (
    <div className="app">
      <Toolbar path={path} setPath={setPath} canBack={canBack} canForward={canForward} canGoto={opened} busy={!!opening}
        onBack={back} onForward={forward} onGoto={() => setGotoOpen(true)} onOpen={() => open(path)}
        onPick={async () => { const p = await window.host.pickFile(); if (p) { setPath(p); open(p); } }} />
      {opening && <OpenDialog path={opening.path} progress={progress} startedAt={opening.startedAt} cancelling={opening.cancelling} onCancel={cancelOpen} />}
      {searchOpen && opened && <SearchPanel onGo={(a) => go(a, "search")} onClose={() => setSearchOpen(false)} />}
      {gotoOpen && opened && <GoTo onGo={(a) => go(a, "goto")} onClose={() => setGotoOpen(false)} />}
      {opened ? (
        <Panes visible={visible}>{{
          functions: (
            <div className="funcs-col">
              <FunctionList funcs={funcs} selected={fn?.entry ?? null} onSelect={(e) => go(e, "functions")} onPin={(e) => { void go(e, "functions"); void tabs.show(e, true); }} />
              <XrefPanel address={here} version={xrefVersion} onGo={(a) => go(a, "xrefs")} />
            </div>
          ),
          listing: <Listing map={map!} scrollReq={scrollReq} topAddrRef={topAddrRef} onLatency={(ms) => setStats((s) => ({ ...s, listingMs: ms }))} onError={(e) => { if (!(e instanceof RpcError && e.code === -32001)) fail(e); }} onRowClick={(a) => go(a, "listing")} />,
          decompiler: (
            <div className="dec">
              <TabStrip tabs={tabs.state} name={(e) => names.get(e) ?? e} onActivate={(id) => goTab(tabs.activate(id))} onClose={(id) => goTab(tabs.close(id))} onPin={tabs.pin} />
              {!active && <div className="empty">Select a function, click an address in the listing, or press Cmd+G.</div>}
              {ad?.status === "loading" && <div className="empty">Decompiling…</div>}
              {ad?.status === "error" && <div className="empty err">{ad.error}</div>}
              <div className="editor" style={{ display: active ? undefined : "none" }}>
                <Decompiler tabId={active?.id ?? null} liveIds={tabs.state.tabs.map((t) => t.id)} text={ad?.text ?? ""} tokens={ad?.tokens ?? []} onCallClick={clickAt} editorRef={editorRef} />
              </div>
            </div>
          ),
        }}</Panes>
      ) : <div className="notice">{notice && <p role="status">{notice}</p>}<p>Open a binary to begin (File → Open Binary…, Cmd+O).</p></div>}
      <StatusBar address={here} func={fn?.name ?? null} bytes={map?.total ?? 0} funcs={funcs.length} stats={stats} error={error} />
    </div>
  );
}

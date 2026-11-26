import { useEffect, useMemo, useRef, useState } from "react";
import type { FunctionInfo, Address } from "../../../protocol";
import { rpc } from "./client";
import { AddrMap } from "./addrmap";
import { Listing } from "./Listing";
import { FunctionList } from "./FunctionList";
import { Decompiler } from "./Decompiler";
import { Toolbar, ProgressBar, type Progress } from "./Toolbar";
import { StatusBar, type Stats } from "./StatusBar";
import { TabStrip } from "./TabStrip";
import { GoTo } from "./GoTo";
import { Panes, type PaneId } from "./Layout";
import { runAutotest, runBench } from "./autotest";
import { emptyNav, push, goBack, goForward, type Nav, type Loc, type Source } from "./nav";
import { FuncIndex, containingFunction } from "./funcs";
import { useTabs } from "./useTabs";

const noIndex = new FuncIndex([]);

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
  const [visible, setVisible] = useState<Record<PaneId, boolean>>({ functions: true, listing: true, decompiler: true });
  const navRef = useRef(nav);
  const idxRef = useRef(noIndex);
  const topAddrRef = useRef<Address>("");
  const errors = useRef<string[]>([]);
  const editorRef = useRef<any>(null);

  const fail = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); errors.current.push(m); setError(m); };
  const tabs = useTabs(fail, (ms) => setStats((s) => ({ ...s, decompileMs: ms })));
  const idx = useMemo(() => new FuncIndex(funcs), [funcs]);
  idxRef.current = idx;
  const names = useMemo(() => new Map(funcs.map((f) => [f.entry, f.name])), [funcs]);

  const setNav = (n: Nav) => { navRef.current = n; setNavState(n); };
  // Every navigation ends here: scroll the listing (except for a click inside it) and show the containing function.
  const applyLoc = (loc: Loc, viaHistory: boolean) => {
    if (viaHistory || loc.source !== "listing") setScrollReq((s) => ({ address: loc.address, n: s.n + 1 }));
    const fn = containingFunction(idxRef.current, loc.address);
    if (fn) tabs.show(fn.entry);
  };
  const go = (address: Address, source: Source) => { const n = push(navRef.current, { address, source }); setNav(n); applyLoc(n.current!, false); };
  const back = () => { const n = goBack(navRef.current); if (n !== navRef.current) { setNav(n); applyLoc(n.current!, true); } };
  const forward = () => { const n = goForward(navRef.current); if (n !== navRef.current) { setNav(n); applyLoc(n.current!, true); } };

  const open = async (p: string) => {
    setOpened(false); setError(""); setProgress({ phase: "import", pct: 0, message: "starting" });
    try {
      await rpc.call("open_binary", { path: p });
      const [fl, info] = await Promise.all([rpc.call("list_functions", {}), rpc.call("listing_info", {})]);
      idxRef.current = new FuncIndex(fl);
      tabs.reset(); setNav(emptyNav);
      setFuncs(fl); setMap(new AddrMap(info.ranges)); setOpened(true);
      window.host.recentAdd(p).catch(() => {});
      return fl;
    } catch (e) { fail(e); } finally { setProgress(null); }
  };

  // Monaco token click -> navigate
  const clickAt = (line1: number, col1: number) => {
    const d = tabs.data[tabs.state.active ?? -1];
    const t = d?.tokens.find((t) => t.targetFunction && t.line + 1 === line1 && col1 >= t.colStart + 1 && col1 < t.colEnd + 1);
    if (t?.targetFunction) go(t.targetFunction, "decompiler");
  };

  // Handlers registered once (startup, menu, mouse) call the latest closures through this.
  const api = useRef({ go, back, forward, clickAt, open, closeTab: tabs.closeActive });
  api.current = { go, back, forward, clickAt, open, closeTab: tabs.closeActive };

  useEffect(() => {
    (async () => {
      const cfg = await window.host.getConfig();
      await rpc.connect(cfg.port, cfg.token);
      rpc.onNotification = (m, p) => {
        if (m === "progress") setProgress(p as Progress);
        else if (m === "error") fail((p as { message: string }).message);
      };
      if (cfg.autotest) (cfg.bench ? runBench : runAutotest)(cfg.autotest, {
        open: (p) => api.current.open(p), select: async (e) => api.current.go(e, "functions"), clickAt: (l, c) => api.current.clickAt(l, c),
        back: () => api.current.back(), forward: () => api.current.forward(), setPath, fail, errors: errors.current,
        selected: () => { const t = tabsRef.current(); return t.tabs.find((x) => x.id === t.active)?.entry ?? null; },
        topAddr: () => topAddrRef.current, editorText: () => editorRef.current?.getValue() ?? "",
      });
    })().catch(fail);
    const off = window.host.onMenu((c) => {
      if (c.type === "open-path") { setPath(c.path); api.current.open(c.path); }
      else if (c.type === "nav-back") api.current.back();
      else if (c.type === "nav-forward") api.current.forward();
      else if (c.type === "goto") setGotoOpen(true);
      else if (c.type === "close-tab") api.current.closeTab();
      else if (c.type === "toggle-pane") setVisible((v) => ({ ...v, [c.pane]: !v[c.pane] }));
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

  const here = nav.current?.address ?? null;
  const fn = here ? containingFunction(idx, here) : null;
  const active = tabs.state.tabs.find((t) => t.id === tabs.state.active) ?? null;
  const ad = active ? tabs.data[active.id] : undefined;

  return (
    <div className="app">
      <Toolbar path={path} setPath={setPath} canBack={canBack} canForward={canForward} canGoto={opened}
        onBack={back} onForward={forward} onGoto={() => setGotoOpen(true)} onOpen={() => open(path)}
        onPick={async () => { const p = await window.host.pickFile(); if (p) { setPath(p); open(p); } }} />
      {progress && <ProgressBar progress={progress} />}
      {gotoOpen && opened && <GoTo funcs={funcs} onGo={(a) => go(a, "goto")} onClose={() => setGotoOpen(false)} />}
      {opened ? (
        <Panes visible={visible}>{{
          functions: <FunctionList funcs={funcs} selected={fn?.entry ?? null} onSelect={(e) => go(e, "functions")} onPin={(e) => { go(e, "functions"); const t = tabsRef.current().tabs.find((x) => x.id === tabsRef.current().active); if (t) tabs.pin(t.id); }} />,
          listing: <Listing map={map!} scrollReq={scrollReq} topAddrRef={topAddrRef} onLatency={(ms) => setStats((s) => ({ ...s, listingMs: ms }))} onError={fail} onRowClick={(a) => go(a, "listing")} />,
          decompiler: (
            <div className="dec">
              <TabStrip tabs={tabs.state} name={(e) => names.get(e) ?? e} onActivate={tabs.activate} onClose={tabs.close} onPin={tabs.pin} />
              {!active && <div className="empty">Select a function, click an address in the listing, or press Cmd+G.</div>}
              {ad?.status === "loading" && <div className="empty">Decompiling…</div>}
              {ad?.status === "error" && <div className="empty err">{ad.error}</div>}
              <div className="editor" style={{ display: active ? undefined : "none" }}>
                <Decompiler tabId={active?.id ?? null} liveIds={tabs.state.tabs.map((t) => t.id)} text={ad?.text ?? ""} tokens={ad?.tokens ?? []} onCallClick={clickAt} editorRef={editorRef} />
              </div>
            </div>
          ),
        }}</Panes>
      ) : <div style={{ flex: 1, padding: 16 }}>Open a binary to begin (File → Open Binary…, Cmd+O).</div>}
      <StatusBar address={here} func={fn?.name ?? null} bytes={map?.total ?? 0} funcs={funcs.length} stats={stats} error={error} />
    </div>
  );
}

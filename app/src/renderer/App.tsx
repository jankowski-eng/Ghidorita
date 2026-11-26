import { useEffect, useMemo, useRef, useState } from "react";
import type { FunctionInfo, Address, ImportOptions, ProgramEntry } from "../../../protocol";
import { rpc } from "./client";
import { AddrMap } from "./addrmap";
import { Listing } from "./Listing";
import { FunctionList } from "./FunctionList";
import { Decompiler } from "./Decompiler";
import { Toolbar } from "./Toolbar";
import { OpenDialog, type Progress } from "./OpenDialog";
import { Confirm } from "./Confirm";
import { ImportDialog } from "./ImportDialog";
import { Welcome } from "./Welcome";
import { needsPrompt, windowTitle } from "./session";
import { reopenParams } from "./openOptions";
import type { MenuCommand, MenuState } from "../preload/index";
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
  const [programName, setProgramName] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const setDirty = (d: boolean) => { dirtyRef.current = d; setDirtyState(d); };
  const [prompt, setPrompt] = useState<{ reason: string; error: string; busy: boolean } | null>(null);
  const promptRef = useRef<((ok: boolean) => void) | null>(null);
  const [importFor, setImportFor] = useState<string | null>(null);
  const importRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [progs, setProgs] = useState<{ list: ProgramEntry[]; loading: boolean; error: string }>({ list: [], loading: false, error: "" });
  const [progsVersion, setProgsVersion] = useState(0);
  const [deleting, setDeleting] = useState<{ entry: ProgramEntry; error: string; busy: boolean } | null>(null);
  const progsRun = useRef(latest()).current;
  const menuRef = useRef<MenuState | null>(null);
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
  const funcsCountRef = useRef(0);
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

  // Forget everything about the current program. Called on open and close; bumping goSeq/refetch makes in-flight replies no-ops.
  const clearProgram = () => {
    openedRef.current = false; setOpened(false); setSearchOpen(false); setGotoOpen(false); setProgramName(null); setDirty(false);
    tabs.reset(); setNav(emptyNav); setFuncs([]); setMap(null); setFn(null); setStats({}); setXrefVersion(0); topAddrRef.current = "";
    clearFunctionCache(); ++goSeq.current; void refetch(Promise.resolve(null)); funcsCountRef.current = 0;
  };
  const open = async (p: string, opts: ImportOptions = {}) => {
    if (openingRef.current) return; // the sidecar would answer Busy
    openingRef.current = true; cancellingRef.current = false;
    setError(""); setNotice(""); setProgress(null); setOpening({ path: p, startedAt: Date.now(), cancelling: false });
    clearProgram();
    try {
      const r = await rpc.call("open_binary", { path: p, ...opts });
      const [fl, info, u] = await Promise.all([rpc.call("list_functions", {}), rpc.call("listing_info", {}), rpc.call("undo_state", {})]);
      funcsCountRef.current = fl.length; setFuncs(fl); setMap(new AddrMap(info.ranges)); setProgramName(r.name); setDirty(u.dirty); setOpened(true); openedRef.current = true;
      if (!autotestRef.current) window.host.recentAdd(p).catch(() => {});
      return fl;
    } catch (e) {
      // the UI already forgot the old program; a rejected open (NotFound/InvalidArgument/Busy) leaves it open in the sidecar. close_program is idempotent.
      await rpc.call("close_program", {}).catch(() => {});
      if (e instanceof RpcError && e.code === -32002) setNotice("Open cancelled."); // not an error
      else { fail(e); setNotice("Could not open " + p); }
    } finally { openingRef.current = false; setOpening(null); setProgress(null); }
  };

  // Resolves true when it is fine to discard the open program (clean, or the user chose Save / Don't Save); false = abort the operation.
  const guard = (reason: string) => new Promise<boolean>((resolve) => {
    if (!needsPrompt(openedRef.current, dirtyRef.current)) return resolve(true);
    if (promptRef.current) return resolve(false); // one prompt at a time
    promptRef.current = resolve; setPrompt({ reason, error: "", busy: false });
  });
  const answer = (ok: boolean) => { const r = promptRef.current; promptRef.current = null; setPrompt(null); r?.(ok); };
  const saveNow = async (): Promise<string | null> => {
    try { await rpc.call("save", {}); setDirty(false); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
  };
  const promptSave = async () => {
    setPrompt((p) => p && { ...p, busy: true, error: "" });
    const err = await saveNow();
    if (err) setPrompt((p) => p && { ...p, busy: false, error: "Save failed: " + err }); // program stays open, user may retry, discard or cancel
    else answer(true);
  };
  const menuSave = async () => { if (!openedRef.current || !dirtyRef.current) return; const err = await saveNow(); if (err) fail("Save failed: " + err); };

  // Open entry point for Open, Open Recent and the path box: pick import options first; the dirty prompt comes when the user confirms.
  const requestOpen = (p: string) => {
    if (openingRef.current || importRef.current) return;
    importRef.current = true; setPath(p); setImportFor(p);
  };
  const confirmImport = async (p: string, opts: ImportOptions | undefined) => {
    if (!(await guard("open another binary"))) return;
    importRef.current = false; setImportFor(null);
    void open(p, opts);
  };
  const cancelImport = () => { importRef.current = false; setImportFor(null); };
  const openStored = (e: ProgramEntry) => {
    const r = reopenParams(e);
    if (!r) { setProgs((x) => ({ ...x, error: `${e.name} has no stored source path; open the file with File > Open.` })); return; }
    const { path: p, ...o } = r;
    setPath(p); void open(p, o);
  };
  const closeProgram = async () => {
    if (!openedRef.current || openingRef.current) return;
    if (!(await guard("close the program")) || !openedRef.current) return;
    try { await rpc.call("close_program", {}); } catch (e) { fail(e); return; }
    clearProgram(); setNotice("");
  };
  const deleteStored = async () => {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: "" });
    try { await rpc.call("delete_program", { programId: deleting.entry.programId }); setDeleting(null); setProgsVersion((v) => v + 1); }
    catch (e) {
      if (e instanceof RpcError && e.code === -32004) { setDeleting(null); setProgsVersion((v) => v + 1); } // already gone
      else setDeleting((d) => d && { ...d, busy: false, error: e instanceof RpcError && e.code === -32005 ? "The sidecar is busy; try again in a moment." : e instanceof Error ? e.message : String(e) });
    }
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
    setDirty(p.undo.dirty);
    if (p.ranges && !p.ranges.length && !p.kinds.length) return; // save: only `dirty` changed
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
  const handleMenu = (c: MenuCommand) => {
    if (c.type === "open-path") requestOpen(c.path);
    else if (c.type === "save") void menuSave();
    else if (c.type === "close-program") void closeProgram();
    else if (c.type === "search") { if (openedRef.current) setSearchOpen(true); }
    else if (c.type === "nav-back") back();
    else if (c.type === "nav-forward") forward();
    else if (c.type === "goto") { if (openedRef.current) setGotoOpen(true); }
    else if (c.type === "close-tab") goTab(tabs.closeActive());
    else if (c.type === "toggle-pane") setVisible((v) => ({ ...v, [c.pane]: c.visible }));
  };
  const apiNow = { go, back, forward, clickAt, open, cancelOpen, programChanged, guard, handleMenu };
  const api = useRef(apiNow);
  api.current = apiNow;

  useEffect(() => {
    (async () => {
      const cfg = await window.host.getConfig();
      await rpc.connect(cfg.port, cfg.token);
      setConnected(true);
      rpc.onNotification = (m, p) => {
        if (m === "progress") { if (openingRef.current && !cancellingRef.current) setProgress(p as Progress); } // late progress after cancel is dropped
        else if (m === "program_changed") api.current.programChanged(p as Parameters<typeof onProgramChanged>[0]);
        else if (m === "error") fail((p as { message: string }).message);
      };
      autotestRef.current = !!cfg.autotest;
      if (cfg.autotest) (cfg.bench ? runBench : runAutotest)(cfg.autotest, {
        open: (p) => api.current.open(p), menu: (c) => api.current.handleMenu(c), lastMenu: () => menuRef.current, title: () => document.title, cancelFile: cfg.cancelFile,
        status: () => ({ funcs: funcsCountRef.current, opened: openedRef.current, opening: openingRef.current, phase: progressRef.current?.phase ?? "", notice: noticeRef.current }),
        select: async (e) => { await api.current.go(e, "functions"); }, clickAt: (l, c) => api.current.clickAt(l, c),
        back: () => api.current.back(), forward: () => api.current.forward(), setPath, fail, errors: errors.current,
        selected: () => { const t = tabsRef.current(); return t.tabs.find((x) => x.id === t.active)?.entry ?? null; },
        topAddr: () => topAddrRef.current, editorText: () => editorRef.current?.getValue() ?? "",
      });
    })().catch(fail);
    const off = window.host.onMenu((c) => api.current.handleMenu(c));
    const offQuit = window.host.onQuitRequest(() => { void api.current.guard("quit").then((ok) => window.host.quitAnswer(ok)); });
    const mouse = (e: MouseEvent) => { // buttons 4/5 = back/forward
      if (e.button === 3) { e.preventDefault(); api.current.back(); } else if (e.button === 4) { e.preventDefault(); api.current.forward(); }
    };
    window.addEventListener("mouseup", mouse);
    return () => { off(); offQuit(); window.removeEventListener("mouseup", mouse); };
  }, []);

  const tabsRef = useRef(() => tabs.state); tabsRef.current = () => tabs.state;
  const canBack = nav.back.length > 0, canForward = nav.forward.length > 0, busy = !!opening || !!importFor;
  useEffect(() => {
    const s = { canBack: canBack && !busy, canForward: canForward && !busy, canOpen: !busy, canSave: opened && dirty && !busy, canClose: opened && !busy };
    menuRef.current = s; window.host.setMenuState(s).catch(() => {});
  }, [canBack, canForward, busy, opened, dirty]);
  useEffect(() => { document.title = windowTitle(opened ? programName : null, opened && dirty); }, [opened, programName, dirty]);
  // program browser: refresh whenever the welcome state is (re)entered (start, after close, after a failed open)
  useEffect(() => {
    if (opened || opening || !connected) return;
    setProgs((x) => ({ ...x, loading: true, error: "" }));
    progsRun(rpc.call("list_programs", {})).then((l) => { if (l) setProgs({ list: l, loading: false, error: "" }); }, (e) => setProgs({ list: [], loading: false, error: e instanceof Error ? e.message : String(e) }));
  }, [opened, !!opening, connected, progsVersion]); // eslint-disable-line

  const progressRef = useRef(progress); progressRef.current = progress;
  const here = nav.current?.address ?? null;
  const active = tabs.state.tabs.find((t) => t.id === tabs.state.active) ?? null;
  const ad = active ? tabs.data[active.id] : undefined;

  return (
    <div className="app">
      <Toolbar path={path} setPath={setPath} canBack={canBack} canForward={canForward} canGoto={opened} busy={busy}
        onBack={back} onForward={forward} onGoto={() => setGotoOpen(true)} onSearch={() => setSearchOpen(true)} onOpen={() => requestOpen(path)}
        onPick={async () => { const p = await window.host.pickFile(); if (p) requestOpen(p); }} />
      {opening && <OpenDialog path={opening.path} progress={progress} startedAt={opening.startedAt} cancelling={opening.cancelling} onCancel={cancelOpen} />}
      {importFor && !opening && <ImportDialog key={importFor} path={importFor} onOpen={(o) => void confirmImport(importFor, o)} onCancel={cancelImport} />}
      {prompt && <Confirm title="Save changes?" message={`Save changes to ${programName ?? "the program"} before you ${prompt.reason}? Unsaved changes are lost otherwise.`} error={prompt.error} busy={prompt.busy}
        actions={[{ label: "Save", primary: true, onClick: () => void promptSave() }, { label: "Don't Save", onClick: () => answer(true) }]} onCancel={() => answer(false)} />}
      {deleting && <Confirm title="Delete program?" message={`Remove ${deleting.entry.name} from the project? Its analysis is deleted; the original file is not touched.`} error={deleting.error} busy={deleting.busy}
        actions={[{ label: "Delete", onClick: () => void deleteStored() }]} onCancel={() => setDeleting(null)} />}
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
      ) : <div className="notice">{notice && <p role="status">{notice}</p>}<p>Open a binary to begin (File → Open Binary…, Cmd+O), or reopen a program below.</p>
        <Welcome programs={progs.list} loading={progs.loading} error={progs.error} onOpen={openStored} onDelete={(entry) => setDeleting({ entry, error: "", busy: false })} /></div>}
      <StatusBar address={here} func={fn?.name ?? null} bytes={map?.total ?? 0} funcs={funcs.length} stats={stats} error={error} />
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { FunctionInfo, Address, ImportOptions, ProgramEntry } from "../../../protocol";
import { rpc, ws } from "./client";
import { AddrMap } from "./addrmap";
import { Listing } from "./Listing";
import { FunctionList } from "./FunctionList";
import { Decompiler } from "./Decompiler";
import { Toolbar } from "./Toolbar";
import { OpenDialog, type Progress } from "./OpenDialog";
import { Confirm } from "./Confirm";
import { ImportDialog } from "./ImportDialog";
import { Welcome } from "./Welcome";
import { windowTitle } from "./session";
import { reopenParams } from "./openOptions";
import type { MenuCommand, MenuState } from "../preload/index";
import { SearchPanel } from "./SearchPanel";
import { XrefPanel } from "./XrefPanel";
import { Dock, type DockId } from "./Dock";
import { RpcError } from "./backend";
import { onProgramChanged } from "./changes";
import { latest } from "./latest";
import { StatusBar, type Stats } from "./StatusBar";
import { TabStrip } from "./TabStrip";
import { GoTo } from "./GoTo";
import { Panes, type PaneId } from "./Layout";
import { runAutotest, runBench } from "./autotest";
import { emptyNav, push, goBack, goForward, type Nav, type Loc, type Source } from "./nav";
import { containingFunction, clearFunctionCache, searchSymbols, type FuncAt } from "./symbols";
import { useTabs, canForce } from "./useTabs";
import { EditDialog, type EditSpec } from "./EditDialog";
import { renameTarget, retypeTarget, tokenAt, undoRoute, isOwnName, xrefTargetOf, type EditAction, type Focus, type XrefTarget } from "./editActions";
import { FormDialog, type FormField } from "./FormDialog";
import { DataTypes } from "./DataTypes";
import type { CommentKind, UndoState } from "../../../protocol";

export function App() {
  const [path, setPath] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [opened, setOpened] = useState(false);
  const [funcs, setFuncs] = useState<FunctionInfo[]>([]);
  const [map, setMap] = useState<AddrMap | null>(null);
  const [nav, setNavState] = useState<Nav>(emptyNav);
  const [scrollReq, setScrollReq] = useState<{ address: Address; n: number }>({ address: "" as Address, n: 0 });
  const [listingChange, setListingChange] = useState<{ n: number; ranges: { start: Address; end: Address }[] | null }>({ n: 0, ranges: null });
  const [stats, setStats] = useState<Stats>({});
  const [error, setError] = useState("");
  const [gotoOpen, setGotoOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [opening, setOpening] = useState<{ path: string; startedAt: number; cancelling: boolean } | null>(null);
  const [programName, setProgramName] = useState<string | null>(null);
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
  const [xrefTarget, setXrefTarget] = useState<XrefTarget | null>(null); // pinned "show references" target; null = follow the cursor
  const [dock, setDock] = useState<DockId | null>(null);
  const [dataVersion, setDataVersion] = useState(0); // bumped on every program change: the dock windows refetch
  const [visible, setVisible] = useState<Record<PaneId, boolean>>({ functions: true, listing: true, decompiler: true });
  const navRef = useRef(nav);
  const openingRef = useRef(false);
  const openedRef = useRef(false);
  const cancellingRef = useRef(false);
  const funcsCountRef = useRef(0);
  const funcsRef = useRef<FunctionInfo[]>([]);
  const goSeq = useRef(0);
  const refetch = useRef(latest()).current;
  const topAddrRef = useRef<Address>("");
  const errors = useRef<string[]>([]);
  const autotestRef = useRef(false);
  const editorRef = useRef<any>(null);
  const cursorRef = useRef<Address>("");
  const [undo, setUndo] = useState<UndoState>({ canUndo: false, canRedo: false, dirty: false });
  const [saving, setSaving] = useState(false);
  const [flash, setFlashState] = useState("");
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setFlash = (m: string) => { setFlashState(m); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlashState(""), 5000); };
  const [dlg, setDlg] = useState<{ spec: EditSpec; submit: (v: string, k: CommentKind) => Promise<void> } | null>(null);
  const dlgRef = useRef<unknown>(null); dlgRef.current = dlg;
  const [formDlg, setFormDlg] = useState<{ title: string; submit: string; fields: FormField[]; go: (v: Record<string, string>) => Promise<void> } | null>(null);
  const formRef = useRef(formDlg); formRef.current = formDlg;
  const [typesOpen, setTypesOpen] = useState(false);
  const [typesVersion, setTypesVersion] = useState(0);
  const lastPane = useRef<"listing" | "decompiler">("listing");

  const fail = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); errors.current.push(m); setError(m); };
  const tabs = useTabs(fail, (ms) => setStats((s) => ({ ...s, decompileMs: ms })), (entry) => funcsRef.current.find((f) => f.entry === entry)?.size ?? 0);
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
    openedRef.current = false; setOpened(false); setSearchOpen(false); setGotoOpen(false); setDock(null); setXrefTarget(null); setProgramName(null); setUndo({ canUndo: false, canRedo: false, dirty: false }); setDlg(null); setFormDlg(null); setTypesOpen(false); funcsRef.current = [];
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
      const [fl, info] = await Promise.all([rpc.call("list_functions", {}), rpc.call("listing_info", {})]);
      funcsCountRef.current = fl.length; funcsRef.current = fl; setFuncs(fl); rpc.call("undo_state", {}).then(setUndo, fail); setMap(new AddrMap(info.ranges)); setProgramName(r.name); setOpened(true); openedRef.current = true;
      if (!autotestRef.current) window.host.recentAdd(p).catch(() => {});
      return fl;
    } catch (e) {
      // the UI already forgot the old program; a rejected open (NotFound/InvalidArgument/Busy) leaves it open in the sidecar. close_program is idempotent.
      await rpc.call("close_program", {}).catch(() => {});
      if (e instanceof RpcError && e.code === -32002) setNotice("Open cancelled."); // not an error
      else {
        fail(e); setNotice("Could not open " + p);
        if (/save failed before closing/.test(e instanceof Error ? e.message : "")) { // the old program (with its unsaved edits) is still open: show it again
          try {
            const [fl, info] = await Promise.all([rpc.call("list_functions", {}), rpc.call("listing_info", {})]);
            funcsCountRef.current = fl.length; funcsRef.current = fl; setFuncs(fl); setMap(new AddrMap(info.ranges)); setOpened(true); openedRef.current = true;
            rpc.call("undo_state", {}).then(setUndo, fail);
          } catch { /* stays closed */ }
        }
      }
    } finally { openingRef.current = false; setOpening(null); setProgress(null); }
  };

  // Open entry point for Open, Open Recent and the path box: pick import options first. Unsaved edits of the open program are autosaved by the sidecar when it is replaced.
  const requestOpen = (p: string) => {
    if (openingRef.current || importRef.current) return;
    importRef.current = true; setPath(p); setImportFor(p);
  };
  const confirmImport = async (p: string, opts: ImportOptions | undefined) => {
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
    if (p.ranges && !p.ranges.length && !p.kinds.length) { setUndo(p.undo); return; } // save: only `dirty` changed
    clearFunctionCache(); setDataVersion((v) => v + 1); setTypesVersion((v) => v + 1);
    onProgramChanged(p, {
      refetchFunctions: async () => { const fl = await refetch(rpc.call("list_functions", {})); if (fl) { funcsRef.current = fl; funcsCountRef.current = fl.length; setFuncs(fl); } return fl ?? funcsRef.current; },
      tabs: () => tabsRef.current().tabs,
      reloadTab: (id) => tabs.reload(id),
      refreshListing: (ranges) => setListingChange((c) => ({ n: c.n + 1, ranges })),
      currentFunctions: () => funcsRef.current, setUndo,
      refreshXrefs: () => setXrefVersion((v) => v + 1),
    }).catch((e) => { if (!(e instanceof RpcError && e.code === -32001)) fail(e); });
  };

  // Monaco token click -> navigate
  const clickAt = (line1: number, col1: number) => {
    const d = tabs.data[tabs.state.active ?? -1];
    const t = d?.tokens.find((t) => t.targetFunction && t.line + 1 === line1 && col1 >= t.colStart + 1 && col1 < t.colEnd + 1);
    if (t?.targetFunction) go(t.targetFunction, "decompiler");
  };

  // ---- editing ----
  const focusKind = (el: Element | null): Focus => {
    if (!el) return "other";
    // Monaco's hidden textarea is the editor itself; only its find/replace widget inputs are real text inputs
    if (el.matches("input, textarea, select, [contenteditable]") && (!el.closest(".monaco-editor") || el.closest(".find-widget"))) return "input";
    if (el.closest(".monaco-editor")) return "decompiler";
    return el.closest(".lbox") ? "listing" : "other";
  };
  const activeTab = () => { const t = tabsRef.current(); return t.tabs.find((x) => x.id === t.active) ?? null; };
  const send = async (f: () => Promise<unknown>) => { try { await f(); } catch (e) { fail(e); } };
  const ask = (spec: EditSpec, submit: (v: string, k: CommentKind) => Promise<void>) => setDlg({ spec, submit });
  const refreshUndo = () => rpc.call("undo_state", {}).then(setUndo, fail);
  const doSave = async () => {
    if (saving) return;
    setSaving(true);
    try { await rpc.call("save", {}); await refreshUndo(); } catch (e) { fail(e); } finally { setSaving(false); }
  };
  const doUndo = (kind: "undo" | "redo") => send(async () => { setUndo(await rpc.call(kind, {})); });
  const editSignature = async (entry: Address) => {
    const f = await rpc.call("get_function_at", { address: entry });
    if (!f) return setFlash("No function here.");
    ask({ title: "Edit function signature", label: "Signature", field: "text", initial: f.signature, submit: "Apply" },
      async (v) => { await rpc.call("set_function_signature", { entry: f.entry, signature: v.trim() }); });
  };
  const listingEdit = async (a: EditAction) => {
    const addr = cursorRef.current || topAddrRef.current;
    if (!addr) return;
    const row = (window as any).__listing?.rowAt(addr) as { address: Address; length: number; label?: string; comment?: string } | undefined;
    if (!row) return setFlash("Cursor row not loaded.");
    const at = row.address;
    if (a === "rename") {
      const f = await containingFunction(at);
      if (row.label || (f && f.entry === at)) ask({ title: "Rename", label: "New name", field: "text", initial: row.label ?? f!.name, submit: "Rename" },
        async (v) => { await rpc.call("rename_symbol", { address: at, newName: v.trim() }); });
      else ask({ title: "Create label", label: "Label name", field: "text", initial: "", submit: "Create label" }, // nothing to rename here: L creates the label
        async (v) => { await rpc.call("create_label", { address: at, name: v.trim() }); });
    } else if (a === "comment") {
      const comments = await rpc.call("get_comments", { address: at });
      ask({ title: "Set comment", label: "Comment", field: "comment", initial: comments.eol ?? "", submit: "Set comment", kind: "eol", comments },
        async (v, kind) => { await rpc.call("set_comment", { address: at, kind, text: v }); });
    } else if (a === "createFunction") await rpc.call("create_function", { address: at });
    else if (a === "clear") await rpc.call("clear_code", { address: at });
    else if (a === "defineData") ask({ title: "Define data", label: "Data type", field: "datatype", initial: "", submit: "Define" },
      async (v) => { await rpc.call("define_data", { address: at, dataType: v.trim() }); });
    else if (a === "createStruct") setFormDlg({ title: "Create structure", submit: "Create", fields: [{ key: "name", label: "Structure name" }, { key: "length", label: "Length (bytes)", initial: String(row.length) }],
      go: async (v) => { await rpc.call("create_struct_from_data", { address: at, length: Number(v.length), name: v.name.trim() }); } });
    else if (a === "signature") { const f = await containingFunction(at); if (f) await editSignature(f.entry); else setFlash("No function here."); }
    else if (a === "retype") setFlash("Retype works on a variable in the decompiler.");
  };
  const decompEdit = async (a: EditAction) => {
    const tab = activeTab(), d = tab ? tabs.data[tab.id] : undefined, ed = editorRef.current;
    if (!tab || !d || !ed) return;
    const pos = ed.getPosition();
    const tok = pos ? tokenAt(d.tokens, pos.lineNumber, pos.column) : undefined;
    const text = tok ? (d.text.split("\n")[tok.line] ?? "").slice(tok.colStart, tok.colEnd) : "";
    const entry = tab.entry, fnName = names.get(entry) ?? "";
    if (a === "rename") {
      const t = renameTarget(tok, text, { entry, name: fnName });
      if (!t) return setFlash("Nothing to rename at the cursor.");
      if (t.kind === "variable") ask({ title: "Rename variable", label: "New name", field: "text", initial: t.name, submit: "Rename" },
        async (v) => { await rpc.call("rename_variable", { entry, name: t.name, newName: v.trim() }); });
      else ask({ title: "Rename function", label: "New name", field: "text", initial: t.current, submit: "Rename" },
        async (v) => { await rpc.call("rename_symbol", { address: t.address, newName: v.trim() }); });
    } else if (a === "retype") {
      const name = retypeTarget(tok);
      if (!name) return setFlash("Put the cursor on a variable to retype it.");
      ask({ title: "Retype variable", label: "Data type", field: "datatype", initial: "", submit: "Retype" },
        async (v) => { await rpc.call("retype_variable", { entry, name, dataType: v.trim() }); });
    } else if (a === "autoStruct") {
      const name = retypeTarget(tok);
      if (!name) return setFlash("Put the cursor on a variable to auto create a structure for it.");
      setFormDlg({ title: "Auto create structure", submit: "Create", fields: [{ key: "name", label: "Structure name (empty = automatic)" }],
        go: async (v) => { await rpc.call("auto_create_structure", { entry, name, structName: v.name.trim() || undefined }); } });
    } else if (a === "signature") await editSignature(entry);
    else if (a === "comment") {
      const line0 = (pos?.lineNumber ?? 1) - 1;
      const at = d.tokens.find((t) => t.line === line0 && t.address)?.address;
      if (!at) return setFlash("No address on this line.");
      const comments = await rpc.call("get_comments", { address: at });
      ask({ title: "Set comment", label: "Comment", field: "comment", initial: comments.pre ?? "", submit: "Set comment", kind: "pre", comments },
        async (v, kind) => { await rpc.call("set_comment", { address: at, kind, text: v }); });
    } else setFlash("Use the listing for this action.");
  };
  const edit = async (a: EditAction) => {
    if (!openedRef.current || openingRef.current) return;
    const kind = focusKind(document.activeElement);
    if (a === "undo" || a === "redo") {
      if (undoRoute(kind) === "text") { document.execCommand(a); return; } // a text input keeps its own undo
      if (dlgRef.current || formRef.current) return; // no program undo under an open dialog
      return doUndo(a);
    }
    if (a === "save") return doSave();
    if (dlgRef.current || formRef.current) return;
    await send(() => ((kind === "decompiler" || (kind !== "listing" && lastPane.current === "decompiler")) ? decompEdit(a) : listingEdit(a)));
  };
  // X: references to the listing cursor row, or to the decompiler token under the cursor (pinned in the xref panel)
  const showXrefs = () => {
    if (!openedRef.current || openingRef.current) return;
    const kind = focusKind(document.activeElement);
    if (kind === "decompiler" || (kind !== "listing" && lastPane.current === "decompiler")) {
      const tab = activeTab(), d = tab ? tabs.data[tab.id] : undefined, pos = editorRef.current?.getPosition();
      if (!tab || !d || !pos) return;
      const tok = tokenAt(d.tokens, pos.lineNumber, pos.column);
      const text = tok ? (d.text.split("\n")[tok.line] ?? "").slice(tok.colStart, tok.colEnd) : "";
      const t = xrefTargetOf(tok, text, { entry: tab.entry, name: names.get(tab.entry) ?? "" });
      if (t) setXrefTarget(t); else setFlash("No references for the token at the cursor.");
    } else {
      const a = cursorRef.current || topAddrRef.current;
      if (a) { const at = ((window as any).__listing?.rowAt(a)?.address as Address | undefined) ?? a; setXrefTarget({ type: "address", address: at, label: at }); }
    }
  };
  const canAt = (line1: number, col1: number) => {
    const tab = activeTab(), d = tab ? tabs.data[tab.id] : undefined;
    const tok = d ? tokenAt(d.tokens, line1, col1) : undefined;
    const text = tok && d ? (d.text.split("\n")[tok.line] ?? "").slice(tok.colStart, tok.colEnd) : "";
    const fn = tab ? { entry: tab.entry, name: names.get(tab.entry) ?? "" } : null;
    return { rename: !!renameTarget(tok, text, fn), retype: !!retypeTarget(tok), signature: isOwnName(tok, text, fn), xrefs: !!xrefTargetOf(tok, text, fn) };
  };

  // Handlers registered once (startup, menu, mouse) call the latest closures through this.
  const handleMenu = (c: MenuCommand) => {
    if (c.type === "open-path") requestOpen(c.path);
    else if (c.type === "close-program") void closeProgram();
    else if (c.type === "search") { if (openedRef.current) setSearchOpen(true); }
    else if (c.type === "nav-back") back();
    else if (c.type === "nav-forward") forward();
    else if (c.type === "goto") { if (openedRef.current) setGotoOpen(true); }
    else if (c.type === "close-tab") goTab(tabs.closeActive());
    else if (c.type === "edit") void edit(c.action);
    else if (c.type === "dock") { if (openedRef.current) setDock(c.panel); }
    else if (c.type === "xrefs") showXrefs();
    else if (c.type === "datatypes") { if (openedRef.current) setTypesOpen((o) => !o); }
    else if (c.type === "toggle-pane") setVisible((v) => ({ ...v, [c.pane]: c.visible }));
  };
  const apiNow = { go, back, forward, clickAt, open, cancelOpen, programChanged, edit, handleMenu };
  const api = useRef(apiNow);
  api.current = apiNow;

  useEffect(() => {
    (async () => {
      const cfg = await window.host.getConfig();
      await ws.connect(cfg.port, cfg.token);
      setConnected(true);
      rpc.onNotification = (m, p) => {
        if (m === "progress") { if (openingRef.current && !cancellingRef.current) setProgress(p as Progress); } // late progress after cancel is dropped
        else if (m === "program_changed") api.current.programChanged(p as Parameters<typeof onProgramChanged>[0]);
        else if (m === "error") fail((p as { message: string }).message);
      };
      autotestRef.current = !!cfg.autotest;
      window.addEventListener("securitypolicyviolation", (e) => (window as any).__expectCsp || fail("CSP blocked " + e.violatedDirective + ": " + e.blockedURI)); // the policy in index.html must stay as tight as Monaco allows
      if (cfg.autotest) (cfg.bench ? runBench : runAutotest)(cfg.autotest, {
        open: (p) => api.current.open(p), command: (c) => api.current.handleMenu(c), lastMenu: () => menuRef.current, title: () => document.title, cancelFile: cfg.cancelFile, only: cfg.only,
        status: () => ({ funcs: funcsCountRef.current, opened: openedRef.current, opening: openingRef.current, phase: progressRef.current?.phase ?? "", notice: noticeRef.current }),
        select: async (e) => { await api.current.go(e, "functions"); }, goAddr: async (a) => { await api.current.go(a, "goto"); }, clickAt: (l, c) => api.current.clickAt(l, c),
        back: () => api.current.back(), forward: () => api.current.forward(), setPath, fail, errors: errors.current,
        selected: () => { const t = tabsRef.current(); return t.tabs.find((x) => x.id === t.active)?.entry ?? null; },
        editor: () => editorRef.current, menu: (id) => window.host.autotestMenu(id), expect: cfg.expect, funcCount: () => funcsCountRef.current, topAddr: () => topAddrRef.current, editorText: () => editorRef.current?.getValue() ?? "",
      });
    })().catch(fail);
    const off = window.host.onMenu((c) => api.current.handleMenu(c));
    const mouse = (e: MouseEvent) => { // buttons 4/5 = back/forward
      if (e.button === 3) { e.preventDefault(); api.current.back(); } else if (e.button === 4) { e.preventDefault(); api.current.forward(); }
    };
    window.addEventListener("mouseup", mouse);
    // Cmd+Z: the menu shows the accelerator without registering it, so the key arrives here. Text inputs keep their own undo.
    const undoKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z") return;
      if (undoRoute(focusKind(document.activeElement)) === "text") return;
      e.preventDefault(); e.stopPropagation();
      void api.current.edit(e.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", undoKey, true);
    const pane = (e: FocusEvent) => { const k = focusKind(e.target as Element); if (k === "listing" || k === "decompiler") lastPane.current = k; };
    window.addEventListener("focusin", pane);
    // quit: save first (the status bar shows "Saving…"), then main stops the sidecar
    const offQuit = window.host.onQuitRequested(() => {
      setSaving(true);
      (openedRef.current ? rpc.call("save", {}) : Promise.resolve({ saved: false })).then(
        () => window.host.quitReady({ ok: true }),
        (e) => {
          if (e instanceof RpcError && e.code === -32001) return window.host.quitReady({ ok: true });
          setSaving(false); // the user may cancel the quit in main's "Saving failed" dialog; the app must stay usable
          fail(e);
          return window.host.quitReady({ ok: false, error: e instanceof Error ? e.message : String(e) });
        });
    });
    return () => { off(); offQuit(); window.removeEventListener("mouseup", mouse); window.removeEventListener("keydown", undoKey, true); window.removeEventListener("focusin", pane); };
  }, []);

  const tabsRef = useRef(() => tabs.state); tabsRef.current = () => tabs.state;
  const canBack = nav.back.length > 0, canForward = nav.forward.length > 0, busy = !!opening || !!importFor;
  useEffect(() => {
    const s: MenuState = {
      canBack: canBack && !busy, canForward: canForward && !busy, canOpen: !busy, canEdit: opened && !busy && !saving,
      undoLabel: undo.canUndo ? "Undo " + (undo.undoName ?? "") : null, redoLabel: undo.canRedo ? "Redo " + (undo.redoName ?? "") : null, dirty: undo.dirty, canClose: opened && !busy && !saving,
    };
    menuRef.current = s; window.host.setMenuState(s).catch(() => {});
  }, [canBack, canForward, busy, opened, saving, undo.canUndo, undo.canRedo, undo.undoName, undo.redoName, undo.dirty]);
  useEffect(() => { document.title = windowTitle(opened ? programName : null, opened && undo.dirty); }, [opened, programName, undo.dirty]);
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
        onBack={back} onForward={forward} onGoto={() => setGotoOpen(true)} onSearch={() => setSearchOpen(true)} onTypes={() => { if (openedRef.current) setTypesOpen((o) => !o); }} typesOpen={typesOpen} onOpen={() => requestOpen(path)}
        onPick={async () => { const p = await window.host.pickFile(); if (p) requestOpen(p); }} />
      {opening && <OpenDialog path={opening.path} progress={progress} startedAt={opening.startedAt} cancelling={opening.cancelling} onCancel={cancelOpen} />}
      {importFor && !opening && <ImportDialog key={importFor} path={importFor} onOpen={(o) => void confirmImport(importFor, o)} onCancel={cancelImport} />}
      {deleting && <Confirm title="Delete program?" message={`Remove ${deleting.entry.name} from the project? Its analysis is deleted; the original file is not touched.`} error={deleting.error} busy={deleting.busy}
        actions={[{ label: "Delete", onClick: () => void deleteStored() }]} onCancel={() => setDeleting(null)} />}
      {searchOpen && opened && <SearchPanel onGo={(a) => go(a, "search")} onRun={(c) => api.current.handleMenu(c)} onClose={() => setSearchOpen(false)} />}
      {gotoOpen && opened && <GoTo onGo={(a) => go(a, "goto")} onClose={() => setGotoOpen(false)} />}
      {opened ? (
        <Panes visible={visible}>{{
          functions: (
            <div className="funcs-col">
              <FunctionList funcs={funcs} selected={fn?.entry ?? null} onSelect={(e) => go(e, "functions")} onPin={(e) => { void go(e, "functions"); void tabs.show(e, true); }} />
              <XrefPanel address={here} target={xrefTarget} version={xrefVersion} onGo={(a) => go(a, "xrefs")} onFollow={() => setXrefTarget(null)} />
            </div>
          ),
          listing: <Listing map={map!} scrollReq={scrollReq} change={listingChange} topAddrRef={topAddrRef} cursorRef={cursorRef} onEdit={(a) => void edit(a)} onLatency={(ms) => setStats((s) => ({ ...s, listingMs: ms }))} onError={(e) => { if (!(e instanceof RpcError && e.code === -32001)) fail(e); }} onRowClick={(a) => go(a, "listing")} onGo={(a) => go(a, "xrefs")} onXrefs={(a) => setXrefTarget({ type: "address", address: a, label: a })} />,
          decompiler: (
            <div className="dec">
              <TabStrip tabs={tabs.state} name={(e) => names.get(e) ?? e} onActivate={(id) => goTab(tabs.activate(id))} onClose={(id) => goTab(tabs.close(id))} onPin={tabs.pin} />
              {!active && <div className="empty">Select a function, click an address in the listing, or press Cmd+G.</div>}
              {ad?.status === "loading" && <div className="empty">Decompiling…{ad.long && <button aria-label="Cancel decompile" onClick={() => tabs.cancel(active!.id)}>Cancel</button>}</div>}
              {ad?.status === "large" && <div className="empty" role="status">This function is {Math.round((ad.size ?? 0) / 1024)} KB: decompiling can take a minute or more.
                <button aria-label="Decompile anyway" onClick={() => tabs.decompileAnyway(active!.id)}>Decompile anyway</button></div>}
              {ad?.status === "error" && <div className="empty err">{ad.error}{canForce(ad) && <button aria-label="Decompile anyway" onClick={() => tabs.decompileAnyway(active!.id)}>Decompile anyway</button>}</div>}
              <div className="editor" style={{ display: active ? undefined : "none" }}>
                <Decompiler tabId={active?.id ?? null} liveIds={tabs.state.tabs.map((t) => t.id)} text={ad?.text ?? ""} tokens={ad?.tokens ?? []} onCallClick={clickAt} editorRef={editorRef} onEdit={(a) => void edit(a)} canAt={canAt} onXrefs={showXrefs} />
              </div>
            </div>
          ),
        }}</Panes>
      ) : <div className="notice">{notice && <p role="status">{notice}</p>}<p>Open a binary to begin (File → Open Binary…, Cmd+O), or reopen a program below.</p>
        <Welcome programs={progs.list} loading={progs.loading} error={progs.error} onOpen={openStored} onDelete={(entry) => setDeleting({ entry, error: "", busy: false })} /></div>}
      {opened && dock && <Dock active={dock} onActivate={setDock} onClose={() => setDock(null)} version={dataVersion} onGo={(a) => go(a, "search")} onError={fail} />}
      <StatusBar address={here} func={fn?.name ?? null} bytes={map?.total ?? 0} funcs={funcs.length} stats={stats} error={error} dirty={undo.dirty} saving={saving} flash={flash} />
      {typesOpen && opened && <DataTypes version={typesVersion} cursorAddress={cursorRef.current || topAddrRef.current} onClose={() => setTypesOpen(false)} />}
      {dlg && <EditDialog spec={dlg.spec} onSubmit={dlg.submit} onClose={() => setDlg(null)} />}
      {formDlg && <FormDialog title={formDlg.title} submit={formDlg.submit} fields={formDlg.fields} onSubmit={formDlg.go} onClose={() => setFormDlg(null)} />}
    </div>
  );
}

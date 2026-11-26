import { useEffect, useMemo, useRef, useState } from "react";
import type { ActiveSession, FunctionInfo, Address, ImportOptions, ListingRow, ProgramEntry, SymbolHit } from "../../../protocol";
import { AddrMap } from "./addrmap";
import { Listing } from "./Listing";
import { FunctionList } from "./FunctionList";
import { Decompiler } from "./Decompiler";
import { Toolbar } from "./Toolbar";
import { OpenDialog, type Progress } from "./OpenDialog";
import { Confirm } from "./Confirm";
import { ImportDialog } from "./ImportDialog";
import { Welcome } from "./Welcome";
import { readBrowsing, resolveOpen, windowTitle, type BrowsingData } from "./session";
import { allowsCommand, allowsEdit } from "../capabilities";
import type { MenuCommand, MenuState } from "../preload/index";
import { SearchPanel } from "./SearchPanel";
import { coverage, Coverage } from "./coverage";
import { XrefPanel } from "./XrefPanel";
import { Dock, type DockId } from "./Dock";
import { isFailure, isObsolete, type ApplicationBackend, type OpenJob, type OpenProgress, type ProgramOperations } from "./backend";
import { onProgramChanged } from "./changes";
import { latest } from "./latest";
import { StatusBar, type Stats } from "./StatusBar";
import { TabStrip } from "./TabStrip";
import { GoTo } from "./GoTo";
import { Panes, type PaneId } from "./Layout";
import type { AutotestCtx, AutotestControls } from "./autotest";
import { emptyNav, push, goBack, goForward, type Nav, type Loc, type Source } from "./nav";
import { functionLookup, type FuncAt } from "./symbols";
import { useTabs, canForce } from "./useTabs";
import { EditDialog, type EditSpec } from "./EditDialog";
import { renameTarget, retypeTarget, tokenAt, undoRoute, isOwnName, xrefTargetOf, type EditAction, type Focus, type XrefTarget } from "./editActions";
import { FormDialog, type FormField } from "./FormDialog";
import { DataTypes } from "./DataTypes";
import type { CommentKind, UndoState } from "../../../protocol";

type TestDriver = Omit<AutotestCtx, "cancelFile" | "only" | "flow" | "expect" | keyof AutotestControls>;
type Program = { session: ActiveSession; api: ProgramOperations; lookup: ReturnType<typeof functionLookup> };
const cleanUndo = { canUndo: false, canRedo: false, dirty: false };

export function App({ backend, onReady }: { backend: ApplicationBackend; onReady?: (driver: TestDriver) => void }) {
  const { capabilities: caps, lifecycle } = backend;
  const [program, setProgram] = useState<Program | null>(null);
  const programRef = useRef<Program | null>(null);
  const openJob = useRef<OpenJob | null>(null);
  const programPath = useRef("");
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const [unavailable, setUnavailable] = useState(false);
  const unavailableRef = useRef(false);
  const [reading, setReading] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [initialRows, setInitialRows] = useState<ListingRow[]>([]);
  const listingRow = useRef<(() => ListingRow | undefined) | null>(null);
  const ops = program?.api;
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
  const [importFor, setImportFor] = useState<string | null>(null);
  const importRef = useRef(false);
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
  const [useHl, setUseHl] = useState<{ name: string; address: Address } | null>(null); // a clicked decompiler-variable use: its token is highlighted
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

  const fail = (e: unknown) => { if (isObsolete(e)) return; const m = e instanceof Error ? e.message : String(e); errors.current.push(m); setError(m); };
  const tabs = useTabs(caps.has("decompile") ? ops?.decompiler : undefined, fail, (ms) => setStats((s) => ({ ...s, decompileMs: ms })), (entry) => funcsRef.current.find((f) => f.entry === entry)?.size ?? 0);
  const names = useMemo(() => new Map(funcs.map((f) => [f.entry, f.name])), [funcs]);

  const containingFunction = (address: Address) => program?.lookup.containing(address) ?? Promise.resolve(null);
  const blocked = () => openingRef.current || closingRef.current || unavailableRef.current;
  const setNav = (n: Nav) => { navRef.current = n; setNavState(n); };
  // Every navigation ends here: scroll the listing (except for a click inside it) and show the containing function.
  // Only the newest navigation may open a tab (goSeq), so a slow get_function_at can't override a later click.
  const applyLoc = async (loc: Loc, viaHistory: boolean, seq: number): Promise<void> => {
    if (viaHistory || loc.source !== "listing") setScrollReq((s) => ({ address: loc.address, n: s.n + 1 }));
    let f: FuncAt | null = null;
    let err: unknown = null;
    try { f = await containingFunction(loc.address); } catch (e) { err = e; }
    if (seq !== goSeq.current) return;
    if (err) fail(err);
    setFn(f);
    if (f && caps.has("decompile")) await tabs.show(f.entry);
  };
  const go = async (address: Address, source: Source) => {
    if (blocked() || !openedRef.current) return;
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
  const back = () => { const n = goBack(navRef.current); if (n !== navRef.current && !blocked()) { setNav(n); void applyLoc(n.current!, true, ++goSeq.current); } };
  const forward = () => { const n = goForward(navRef.current); if (n !== navRef.current && !blocked()) { setNav(n); void applyLoc(n.current!, true, ++goSeq.current); } };

  const clearProgram = () => {
    coverage.current = null; openedRef.current = false; setOpened(false); setSearchOpen(false); setGotoOpen(false);
    setDock(null); setXrefTarget(null); setUseHl(null); setUndo(cleanUndo); setDlg(null); setFormDlg(null); setTypesOpen(false);
    tabs.reset(); setNav(emptyNav); setFuncs([]); setMap(null); setFn(null); setStats({}); setXrefVersion(0);
    setScrollReq((r) => ({ address: "", n: r.n + 1 })); setListingChange({ n: 0, ranges: null });
    topAddrRef.current = cursorRef.current = ""; editorRef.current = null; lastPane.current = "listing";
    setInitialRows([]); setBrowseError(""); setReading(false); funcsRef.current = []; funcsCountRef.current = 0;
    ++goSeq.current; void refetch(Promise.resolve(null));
  };

  // A failed replacement that retains the same session leaves its entire view intact.
  const selectSession = (session: ActiveSession | null) => {
    if (session?.sessionId === programRef.current?.session.sessionId) return programRef.current;
    clearProgram();
    const api = session ? backend.program(session) : null;
    const current = session && api ? { session, api, lookup: functionLookup(api.functions) } : null;
    programRef.current = current;
    setProgram(current);
    openedRef.current = !!current;
    setOpened(!!current);
    if (current && caps.has("undo")) void current.api.history.state().then((value) => {
      if (programRef.current === current) setUndo(value);
    }, (e) => { if (programRef.current === current) fail(e); });
    return current;
  };

  const loadBrowsing = async (current: Program) => {
    setReading(true); setBrowseError("");
    try {
      const data: BrowsingData = await readBrowsing(current.api);
      if (programRef.current !== current) return;
      funcsCountRef.current = data.functions.length; funcsRef.current = data.functions; setFuncs(data.functions);
      setMap(data.map); setInitialRows(data.rows);
      return data.functions;
    } catch (e) {
      if (programRef.current === current) setBrowseError(e instanceof Error ? e.message : String(e));
    } finally { if (programRef.current === current) setReading(false); }
  };

  const open = async (p: string, opts: ImportOptions = {}, stored?: ProgramEntry) => {
    if (blocked()) return;
    openingRef.current = true; cancellingRef.current = false;
    setError(""); setNotice(""); setProgress(null); setOpening({ path: p, startedAt: Date.now(), cancelling: false });
    const previous = programRef.current;
    try {
      const onProgress = (progress: OpenProgress) => {
        if (openingRef.current && !cancellingRef.current) setProgress(progress);
      };
      const job = openJob.current = stored ? backend.projects.reopen(stored, onProgress) : lifecycle.open(p, opts, onProgress);
      const outcome = await resolveOpen(job, lifecycle);
      if (outcome.kind === "unknown") {
        unavailableRef.current = true; setUnavailable(true);
        setNotice("Could not confirm the active program. Restart Ghidrette to reconnect.");
        fail(outcome.reconciliationError);
        return;
      }

      const current = selectSession(outcome.session);
      if (outcome.kind === "failed") {
        if (current && current === previous) setPath(programPath.current);
        if (isFailure(outcome.error, "cancelled")) setNotice("Open cancelled.");
        else { fail(outcome.error); setNotice("Could not open " + p); }
        return;
      }
      programPath.current = p; setPath(p);
      if (!onReady) window.host.recentAdd(p).catch(() => {});
      return await loadBrowsing(current!);
    } finally { openJob.current = null; openingRef.current = false; setOpening(null); setProgress(null); }
  };

  const requestOpen = (p: string) => {
    if (blocked() || importRef.current) return;
    setPath(p);
    if (!caps.has("importOptions")) { void open(p); return; }
    importRef.current = true; setImportFor(p);
  };
  const confirmImport = (p: string, opts: ImportOptions | undefined) => {
    importRef.current = false; setImportFor(null);
    void open(p, opts);
  };
  const cancelImport = () => {
    importRef.current = false; setImportFor(null);
    if (programRef.current) setPath(programPath.current);
  };
  const openStored = (entry: ProgramEntry) => { void open(entry.sourcePath ?? entry.name, {}, entry); };
  const closeProgram = async () => {
    const current = programRef.current;
    if (!current || blocked()) return;
    closingRef.current = true; setClosing(true);
    try {
      await lifecycle.close(current.session);
      selectSession(null); setNotice(""); setError("");
    } catch (e) { fail(e); }
    finally { closingRef.current = false; setClosing(false); }
  };
  const deleteStored = async () => {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: "" });
    try { await backend.projects.remove({ programId: deleting.entry.programId }); setDeleting(null); setProgsVersion((v) => v + 1); }
    catch (e) {
      if (isFailure(e, "notFound")) { setDeleting(null); setProgsVersion((v) => v + 1); } // already gone
      else setDeleting((d) => d && { ...d, busy: false, error: isFailure(e, "busy") ? "The sidecar is busy; try again in a moment." : e instanceof Error ? e.message : String(e) });
    }
  };
  const cancelOpen = () => {
    const job = openJob.current;
    if (!job) return;
    const setCancelling = (cancelling: boolean) => {
      if (openJob.current !== job) return;
      cancellingRef.current = cancelling;
      setOpening((o) => o && { ...o, cancelling });
    };
    setCancelling(true);
    job.cancel().then((cancelled) => { if (!cancelled) setCancelling(false); }, (e) => { setCancelling(false); fail(e); });
  };

  // program_changed: one subscription, all reactions in changes.ts
  const programChanged = (sessionId: string, p: Parameters<typeof onProgramChanged>[0]) => {
    const current = programRef.current;
    if (current?.session.sessionId !== sessionId) return;
    const isCurrent = () => programRef.current === current;
    if (p.ranges && !p.ranges.length && !p.kinds.length) { setUndo(p.undo); return; } // save: only `dirty` changed
    current.lookup.clear(); setDataVersion((v) => v + 1); setTypesVersion((v) => v + 1);
    onProgramChanged(p, {
      refetchFunctions: async () => { const fl = await refetch(current.api.functions.list()); if (fl && isCurrent()) { funcsRef.current = fl; funcsCountRef.current = fl.length; setFuncs(fl); } return fl ?? funcsRef.current; },
      tabs: () => isCurrent() ? tabsRef.current().tabs : [],
      reloadTab: (id) => { if (isCurrent()) tabs.reload(id); },
      refreshListing: (ranges) => isCurrent() && setListingChange((c) => ({ n: c.n + 1, ranges })),
      currentFunctions: () => funcsRef.current, setUndo: (value) => { if (isCurrent()) setUndo(value); },
      refreshXrefs: () => isCurrent() && setXrefVersion((v) => v + 1),
    }).catch((e) => { if (isCurrent()) fail(e); });
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
  const ask = (spec: EditSpec, submit: (v: string, k: CommentKind) => Promise<void>) => {
    if (programRef.current === program) setDlg({ spec, submit });
  };
  const refreshUndo = () => caps.has("undo") ? ops!.history.state().then((state) => {
    if (programRef.current === program) setUndo(state);
  }, fail) : Promise.resolve();
  const doSave = async () => {
    if (saving) return;
    setSaving(true);
    try { await ops!.history.save(); await refreshUndo(); } catch (e) { fail(e); } finally { setSaving(false); }
  };
  const doUndo = (kind: "undo" | "redo") => send(async () => {
    const state = await ops!.history[kind]();
    if (programRef.current === program) setUndo(state);
  });
  const editSignature = async (entry: Address) => {
    const f = await ops!.functions.containing({ address: entry });
    if (!f) return setFlash("No function here.");
    ask({ title: "Edit function signature", label: "Signature", field: "text", initial: f.signature, submit: "Apply" },
      async (v) => { await ops!.edits.setFunctionSignature({ entry: f.entry, signature: v.trim() }); });
  };
  const listingEdit = async (a: EditAction) => {
    const row = listingRow.current?.();
    if (!row) return setFlash("Cursor row not loaded.");
    const at = row.address;
    if (a === "rename") {
      const f = await containingFunction(at);
      if (row.label || (f && f.entry === at)) ask({ title: "Rename", label: "New name", field: "text", initial: row.label ?? f!.name, submit: "Rename" },
        async (v) => { await ops!.edits.renameSymbol({ address: at, newName: v.trim() }); });
      else ask({ title: "Create label", label: "Label name", field: "text", initial: "", submit: "Create label" }, // nothing to rename here: L creates the label
        async (v) => { await ops!.edits.createLabel({ address: at, name: v.trim() }); });
    } else if (a === "comment") {
      const comments = await ops!.edits.getComments({ address: at });
      ask({ title: "Set comment", label: "Comment", field: "comment", initial: comments.eol ?? "", submit: "Set comment", kind: "eol", comments },
        async (v, kind) => { await ops!.edits.setComment({ address: at, kind, text: v }); });
    } else if (a === "createFunction") await ops!.edits.createFunction({ address: at });
    else if (a === "clear") await ops!.edits.clearCode({ address: at });
    else if (a === "defineData") ask({ title: "Define data", label: "Data type", field: "datatype", initial: "", submit: "Define" },
      async (v) => { await ops!.edits.defineData({ address: at, dataType: v.trim() }); });
    else if (a === "createStruct") setFormDlg({ title: "Create structure", submit: "Create", fields: [{ key: "name", label: "Structure name" }, { key: "length", label: "Length (bytes)", initial: String(row.length) }],
      go: async (v) => { await ops!.edits.createStructFromData({ address: at, length: Number(v.length), name: v.name.trim() }); } });
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
        async (v) => { await ops!.edits.renameVariable({ entry, name: t.name, newName: v.trim() }); });
      else ask({ title: "Rename function", label: "New name", field: "text", initial: t.current, submit: "Rename" },
        async (v) => { await ops!.edits.renameSymbol({ address: t.address, newName: v.trim() }); });
    } else if (a === "retype") {
      const name = retypeTarget(tok);
      if (!name) return setFlash("Put the cursor on a variable to retype it.");
      ask({ title: "Retype variable", label: "Data type", field: "datatype", initial: "", submit: "Retype" },
        async (v) => { await ops!.edits.retypeVariable({ entry, name, dataType: v.trim() }); });
    } else if (a === "autoStruct") {
      const name = retypeTarget(tok);
      if (!name) return setFlash("Put the cursor on a variable to auto create a structure for it.");
      setFormDlg({ title: "Auto create structure", submit: "Create", fields: [{ key: "name", label: "Structure name (empty = automatic)" }],
        go: async (v) => { await ops!.edits.autoCreateStructure({ entry, name, structName: v.name.trim() || undefined }); } });
    } else if (a === "signature") await editSignature(entry);
    else if (a === "comment") {
      const line0 = (pos?.lineNumber ?? 1) - 1;
      const at = d.tokens.find((t) => t.line === line0 && t.address)?.address;
      if (!at) return setFlash("No address on this line.");
      const comments = await ops!.edits.getComments({ address: at });
      ask({ title: "Set comment", label: "Comment", field: "comment", initial: comments.pre ?? "", submit: "Set comment", kind: "pre", comments },
        async (v, kind) => { await ops!.edits.setComment({ address: at, kind, text: v }); });
    } else setFlash("Use the listing for this action.");
  };
  const edit = async (a: EditAction) => {
    if (!openedRef.current || blocked() || importRef.current || !allowsEdit(caps, a)) return;
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
    if (!openedRef.current || blocked() || !caps.has("references")) return;
    const kind = focusKind(document.activeElement);
    if (kind === "decompiler" || (kind !== "listing" && lastPane.current === "decompiler")) {
      const tab = activeTab(), d = tab ? tabs.data[tab.id] : undefined, pos = editorRef.current?.getPosition();
      if (!tab || !d || !pos) return;
      const tok = tokenAt(d.tokens, pos.lineNumber, pos.column);
      const text = tok ? (d.text.split("\n")[tok.line] ?? "").slice(tok.colStart, tok.colEnd) : "";
      const t = xrefTargetOf(tok, text, { entry: tab.entry, name: names.get(tab.entry) ?? "" });
      if (t && (t.type !== "variable" || caps.has("variableReferences"))) { setXrefTarget(t); setUseHl(null); } else setFlash("No references for the token at the cursor.");
    } else {
      const a = cursorRef.current || topAddrRef.current;
      if (a) { const at = listingRow.current?.()?.address ?? a; setXrefTarget({ type: "address", address: at, label: at }); }
    }
  };
  const canAt = (line1: number, col1: number) => {
    const tab = activeTab(), d = tab ? tabs.data[tab.id] : undefined;
    const tok = d ? tokenAt(d.tokens, line1, col1) : undefined;
    const text = tok && d ? (d.text.split("\n")[tok.line] ?? "").slice(tok.colStart, tok.colEnd) : "";
    const fn = tab ? { entry: tab.entry, name: names.get(tab.entry) ?? "" } : null;
    const reference = xrefTargetOf(tok, text, fn);
    return { rename: !!renameTarget(tok, text, fn), retype: !!retypeTarget(tok), signature: isOwnName(tok, text, fn), xrefs: !!reference && (reference.type !== "variable" || caps.has("variableReferences")) };
  };

  // Handlers registered once (startup, menu, mouse) call the latest closures through this.
  const apiNow_refresh = () => { const a = topAddrRef.current; if (a) setScrollReq((s) => ({ address: a, n: s.n + 1, refresh: true })); };
  const loadCoverage = async (path: string) => {
    if (!openedRef.current || blocked()) return;
    try {
      const { ranges } = await ops!.coverage.load({ path });
      if (programRef.current !== program) return;
      coverage.current = new Coverage(ranges);
      setFlash(`Coverage loaded: ${coverage.current.size} range${coverage.current.size === 1 ? "" : "s"} (green bar in the listing)`);
      apiNow_refresh();
    } catch (e) { fail(e); }
  };
  const handleMenu = (c: MenuCommand) => {
    if (!allowsCommand(caps, c) || blocked() || importRef.current) return;
    if (c.type === "open-path") requestOpen(c.path);
    else if (c.type === "coverage-path") void loadCoverage(c.path);
    else if (c.type === "coverage-clear") { coverage.current = null; apiNow_refresh(); }
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
    const offChanged = backend.events.onChange((id, p) => api.current.programChanged(id, p));
    const offError = backend.events.onError(fail);
    const policyViolation = (e: SecurityPolicyViolationEvent) => {
      if (!(window as any).__expectCsp) fail("CSP blocked " + e.violatedDirective + ": " + e.blockedURI);
    };
    window.addEventListener("securitypolicyviolation", policyViolation);
    onReady?.({
      backend, program: () => {
        const current = programRef.current;
        if (!current) throw new Error("No program open");
        return current.api;
      },
      open: (p) => api.current.open(p), command: (c) => api.current.handleMenu(c), lastMenu: () => menuRef.current, title: () => document.title,
      status: () => ({ funcs: funcsCountRef.current, opened: openedRef.current, opening: openingRef.current, phase: progressRef.current?.phase ?? "", notice: noticeRef.current }),
      select: (e) => api.current.go(e, "functions"), goAddr: (a) => api.current.go(a, "goto"), clickAt: (l, c) => api.current.clickAt(l, c),
      back: () => api.current.back(), forward: () => api.current.forward(), setPath, fail, errors: errors.current,
      selected: () => { const t = tabsRef.current(); return t.tabs.find((x) => x.id === t.active)?.entry ?? null; },
      editor: () => editorRef.current, menu: (id) => window.host.autotestMenu(id), funcCount: () => funcsCountRef.current, topAddr: () => topAddrRef.current, editorText: () => editorRef.current?.getValue() ?? "",
    });
    const off = window.host.onMenu((c) => api.current.handleMenu(c));
    const mouse = (e: MouseEvent) => { // buttons 4/5 = back/forward
      if (e.button === 3) { e.preventDefault(); api.current.back(); } else if (e.button === 4) { e.preventDefault(); api.current.forward(); }
    };
    window.addEventListener("mouseup", mouse);
    // Cmd+Z: the menu shows the accelerator without registering it, so the key arrives here. Text inputs keep their own undo.
    const undoKey = (e: KeyboardEvent) => {
      if (!caps.has("undo") || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z") return;
      if (undoRoute(focusKind(document.activeElement)) === "text") return;
      e.preventDefault(); e.stopPropagation();
      void api.current.edit(e.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", undoKey, true);
    const pane = (e: FocusEvent) => { const k = focusKind(e.target as Element); if (k === "listing" || k === "decompiler") lastPane.current = k; };
    window.addEventListener("focusin", pane);
    // quit: save first (the status bar shows "Saving…"), then main stops the sidecar
    const offQuit = window.host.onQuitRequested(() => {
      const current = programRef.current;
      if (!caps.has("save") || !current) { void window.host.quitReady({ ok: true }); return; }
      setSaving(true);
      current.api.history.save().then(
        () => window.host.quitReady({ ok: true }),
        (e) => {
          if (isObsolete(e)) return window.host.quitReady({ ok: true });
          setSaving(false); // the user may cancel the quit in main's "Saving failed" dialog; the app must stay usable
          fail(e);
          return window.host.quitReady({ ok: false, error: e instanceof Error ? e.message : String(e) });
        });
    });
    return () => { off(); offQuit(); offChanged(); offError(); window.removeEventListener("securitypolicyviolation", policyViolation); window.removeEventListener("mouseup", mouse); window.removeEventListener("keydown", undoKey, true); window.removeEventListener("focusin", pane); };
  }, []);

  const tabsRef = useRef(() => tabs.state); tabsRef.current = () => tabs.state;
  const canBack = nav.back.length > 0, canForward = nav.forward.length > 0, busy = !!opening || !!importFor || closing || unavailable;
  useEffect(() => {
    const s: MenuState = {
      canBack: canBack && !busy, canForward: canForward && !busy, canOpen: !busy, canEdit: opened && !busy && !saving && caps.has("editing"),
      hasProgram: opened && !busy && !saving, capabilities: [...caps], recovery: backend.recovery,
      undoLabel: undo.canUndo ? "Undo " + (undo.undoName ?? "") : null, redoLabel: undo.canRedo ? "Redo " + (undo.redoName ?? "") : null, dirty: undo.dirty, canClose: opened && !busy && !saving,
    };
    menuRef.current = s; window.host.setMenuState(s).catch(() => {});
  }, [canBack, canForward, busy, opened, saving, undo.canUndo, undo.canRedo, undo.undoName, undo.redoName, undo.dirty]);
  useEffect(() => { document.title = windowTitle(program?.session.name ?? null, opened && undo.dirty); }, [opened, program, undo.dirty]);
  // program browser: refresh whenever the welcome state is (re)entered (start, after close, after a failed open)
  useEffect(() => {
    if (opened || opening || !caps.has("projects")) return;
    setProgs((x) => ({ ...x, loading: true, error: "" }));
    progsRun(backend.projects.list()).then((l) => { if (l) setProgs({ list: l, loading: false, error: "" }); }, (e) => setProgs({ list: [], loading: false, error: e instanceof Error ? e.message : String(e) }));
  }, [opened, !!opening, caps, progsVersion]); // eslint-disable-line

  const progressRef = useRef(progress); progressRef.current = progress;
  const symbolSearch = caps.has("symbolSearch") ? ops?.searches.searchSymbols : undefined;
  const searchLocation = (q: string): Promise<SymbolHit[]> => symbolSearch
    ? symbolSearch({ query: q, limit: 100 }).result
    : Promise.resolve(funcs.filter((f) => f.name.toLowerCase().startsWith(q.toLowerCase()))
        .map((f) => ({ name: f.name, address: f.entry, kind: "function" })));
  const here = nav.current?.address ?? null;
  const active = tabs.state.tabs.find((t) => t.id === tabs.state.active) ?? null;
  const ad = active ? tabs.data[active.id] : undefined;
  const hlTokens = useMemo(() => (useHl && ad ? ad.tokens.filter((t) => t.varName === useHl.name && t.address === useHl.address) : []), [useHl, ad?.tokens]); // eslint-disable-line

  return (
    <div className="app">
      <Toolbar path={path} setPath={setPath} canBack={canBack} canForward={canForward} canGoto={!!map} canSearchSymbols={caps.has("symbolSearch")} busy={busy}
        onBack={back} onForward={forward} onGoto={() => setGotoOpen(true)} onSearch={() => setSearchOpen(true)} onTypes={caps.has("dataTypes") ? () => setTypesOpen((o) => !o) : undefined} typesOpen={typesOpen} onOpen={() => requestOpen(path)}
        onPick={async () => { const p = await window.host.pickFile(); if (p) requestOpen(p); }} />
      {opening && <OpenDialog path={opening.path} progress={progress} startedAt={opening.startedAt} cancelling={opening.cancelling} onCancel={cancelOpen} />}
      {importFor && !opening && <ImportDialog imports={backend.imports} key={importFor} path={importFor} onOpen={(o) => void confirmImport(importFor, o)} onCancel={cancelImport} />}
      {deleting && <Confirm title="Delete program?" message={`Remove ${deleting.entry.name} from the project? Its analysis is deleted; the original file is not touched.`} error={deleting.error} busy={deleting.busy}
        actions={[{ label: "Delete", onClick: () => void deleteStored() }]} onCancel={() => setDeleting(null)} />}
      {searchOpen && opened && <SearchPanel capabilities={caps} searchSymbols={symbolSearch} onGo={(a) => go(a, "search")} onRun={(c) => api.current.handleMenu(c)} onClose={() => setSearchOpen(false)} />}
      {gotoOpen && opened && <GoTo search={searchLocation} onGo={(a) => go(a, "goto")} onClose={() => setGotoOpen(false)} />}
      {opened ? (map ? (
        <Panes key={program!.session.sessionId} visible={{ ...visible, decompiler: visible.decompiler && caps.has("decompile") }}>{{
          functions: (
            <div className="funcs-col">
              <FunctionList searchSymbols={symbolSearch} funcs={funcs} selected={fn?.entry ?? null} onSelect={(e) => go(e, "functions")} onPin={caps.has("decompile") ? (e) => { void go(e, "functions"); void tabs.show(e, true); } : undefined} />
              {caps.has("references") && <XrefPanel references={ops!.references} variableReferences={caps.has("variableReferences")} address={here} target={xrefTarget} version={xrefVersion} onGo={(a, use) => { setUseHl(use ? { name: use.name, address: a } : null); void go(a, "xrefs"); }} onFollow={() => { setXrefTarget(null); setUseHl(null); }} />}
            </div>
          ),
          listing: <Listing reader={ops!.listing} initialRows={initialRows} testMode={!!onReady} rowRef={listingRow} canEdit={(action) => allowsEdit(caps, action)} map={map} scrollReq={scrollReq} change={listingChange} topAddrRef={topAddrRef} cursorRef={cursorRef} onEdit={(a) => void edit(a)} onLatency={(ms) => setStats((s) => ({ ...s, listingMs: ms }))} onError={fail} onRowClick={(a) => go(a, "listing")} onGo={(a) => go(a, "xrefs")} onXrefs={caps.has("references") ? (a) => setXrefTarget({ type: "address", address: a, label: a }) : undefined} />,
          decompiler: caps.has("decompile") && (
            <div className="dec">
              <TabStrip tabs={tabs.state} name={(e) => names.get(e) ?? e} onActivate={(id) => goTab(tabs.activate(id))} onClose={(id) => goTab(tabs.close(id))} onPin={tabs.pin} />
              {!active && <div className="empty">Select a function, click an address in the listing, or press Cmd+G.</div>}
              {ad?.status === "loading" && <div className="empty">Decompiling…{ad.long && <button aria-label="Cancel decompile" onClick={() => tabs.cancel(active!.id)}>Cancel</button>}</div>}
              {ad?.status === "large" && <div className="empty" role="status">This function is {Math.round((ad.size ?? 0) / 1024)} KB: decompiling can take a minute or more.
                <button aria-label="Decompile anyway" onClick={() => tabs.decompileAnyway(active!.id)}>Decompile anyway</button></div>}
              {ad?.status === "error" && <div className="empty err">{ad.error}{canForce(ad) && <button aria-label="Decompile anyway" onClick={() => tabs.decompileAnyway(active!.id)}>Decompile anyway</button>}</div>}
              <div className="editor" style={{ display: active ? undefined : "none" }}>
                <Decompiler canEdit={caps} tabId={active?.id ?? null} liveIds={tabs.state.tabs.map((t) => t.id)} text={ad?.text ?? ""} tokens={ad?.tokens ?? []} highlight={hlTokens} onCallClick={clickAt} editorRef={editorRef} onEdit={(a) => void edit(a)} canAt={canAt} onXrefs={showXrefs} />
              </div>
            </div>
          ),
        }}</Panes>
      ) : <div className="notice">
        {reading && <p role="status">Reading program…</p>}
        {browseError && <><p role="alert">Could not read the listing for {program?.session.name}. {browseError}</p>
          <button disabled={busy || reading} onClick={() => { if (program) void loadBrowsing(program); }}>Retry listing</button></>}
      </div>) : <div className="notice">
        <p>{caps.has("projects") ? "Open a binary to begin or reopen a program below." : "Open a file to browse its listing."}</p>
        {caps.has("projects") && <Welcome programs={progs.list} loading={progs.loading} error={progs.error} onOpen={openStored} onDelete={(entry) => setDeleting({ entry, error: "", busy: false })} />}
      </div>}
      {notice && <div className="flash" role="status">{notice}</div>}
      {opened && dock && <Dock searches={ops!.searches} capabilities={caps} active={dock} onActivate={setDock} onClose={() => setDock(null)} version={dataVersion} onGo={(a) => go(a, "search")} onError={fail} />}
      <StatusBar address={here} func={fn?.name ?? null} bytes={map?.total ?? 0} funcs={funcs.length} stats={stats} error={error} dirty={undo.dirty} saving={saving} flash={flash} />
      {typesOpen && opened && <DataTypes types={ops!.types} edits={caps.has("typeEditing") ? ops!.typeEdits : undefined} defineData={caps.has("typeEditing") ? ops!.edits.defineData : undefined} version={typesVersion} cursorAddress={cursorRef.current || topAddrRef.current} onClose={() => setTypesOpen(false)} />}
      {dlg && <EditDialog typeSearch={caps.has("dataTypes") ? ops?.types.listDataTypes : undefined} spec={dlg.spec} onSubmit={dlg.submit} onClose={() => { if (programRef.current === program) setDlg(null); }} />}
      {formDlg && <FormDialog typeSearch={caps.has("dataTypes") ? ops?.types.listDataTypes : undefined} title={formDlg.title} submit={formDlg.submit} fields={formDlg.fields} onSubmit={formDlg.go} onClose={() => { if (programRef.current === program) setFormDlg(null); }} />}
    </div>
  );
}

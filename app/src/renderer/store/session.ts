import { createContext, useContext } from "react";
import type { ActiveSession, AnalysisState, Address, DebugState, ImportOptions, ListingRow, ProgramEntry } from "../../../../protocol";
import { readBrowsing, resolveOpen } from "../session";
import { isFailure, isObsolete, type AnalysisMode, type ApplicationBackend, type OpenJob, type OpenProgress, type ProgramChange } from "../backend";
import { coverage } from "../coverage";
import { latest } from "../latest";
import { functionLookup } from "../symbols";
import { createStore, useStore } from "./createStore";
import { initialProgram, programReducer, type Program, type ProgramState } from "./program";
import { createViews } from "./views";

/** Mutable handles the panes fill in (the Monaco editor, the listing's cursor row and top address); read only by the features. */
export interface ViewRefs {
  listingRow: { current: (() => ListingRow | undefined) | null };
  editor: { current: any };
  topAddr: { current: Address };
  cursor: { current: Address };
  lastPane: { current: "listing" | "decompiler" };
}

/**
 * The program session. One store for the open program (store/program.ts) and the actions that move it: open, close, cancel, save, undo,
 * the function list. It is the only caller of the backend's lifecycle. Everything derived from the program subscribes:
 * `onReset` fires when the program is opened, replaced or closed, `onChanged` per program_changed (the reactions are in features/reactions.ts).
 */
export function createSession(backend: ApplicationBackend, opts: { autotest: boolean }) {
  const { capabilities: caps, lifecycle } = backend;
  const store = createStore(programReducer, initialProgram);
  const views = createViews();
  const { dispatch } = store;
  const get = () => store.getState();
  const errors: string[] = [];
  const resetSubs = new Set<() => void>();
  const changeSubs = new Set<(p: ProgramChange, current: Program) => void>();
  const refs: ViewRefs = { listingRow: { current: null }, editor: { current: null }, topAddr: { current: "" as Address }, cursor: { current: "" as Address }, lastPane: { current: "listing" } };
  const refetch = latest(); // function list refetches: only the newest reply counts; a reset cancels the ones in flight
  let openJob: OpenJob | null = null;
  let changeDuringOpen: { sessionId: string; p: ProgramChange } | null = null;

  const blocked = () => { const s = get(); return !!s.opening || s.closing || s.unavailable; };
  const fail = (e: unknown) => { if (isObsolete(e)) return; const m = e instanceof Error ? e.message : String(e); errors.push(m); dispatch({ type: "error", message: m }); };
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const flash = (m: string) => { dispatch({ type: "flash", message: m }); clearTimeout(flashTimer); flashTimer = setTimeout(() => dispatch({ type: "flash", message: "" }), 5000); };
  const setNotice = (message: string) => dispatch({ type: "notice", message });
  /** Run an action, show its failure in the status bar. */
  const send = async (f: () => Promise<unknown>) => { try { await f(); } catch (e) { fail(e); } };

  // Forget everything about the current program: views, coverage, in-flight refetches; subscribers drop their own state.
  const clearProgram = () => {
    coverage.clear();
    views.dispatch({ type: "reset" });
    refs.listingRow.current = null; refs.topAddr.current = refs.cursor.current = "" as Address; refs.editor.current = null; refs.lastPane.current = "listing";
    void refetch(Promise.resolve(null));
    for (const f of [...resetSubs]) f();
  };

  // A failed replacement that retains the same session leaves its entire view intact.
  const selectSession = (session: ActiveSession | null): Program | null => {
    const prev = get().program;
    if (session?.sessionId === prev?.session.sessionId) return prev;
    clearProgram();
    const api = session ? backend.program(session) : null;
    const current: Program | null = session && api ? { session, api, lookup: functionLookup(api.functions) } : null;
    dispatch({ type: "program", program: current });
    if (current && caps.has("undo")) void current.api.history.state().then((u) => {
      if (get().program === current) dispatch({ type: "undo", u });
    }, (e) => { if (get().program === current) fail(e); });
    return current;
  };

  const loadBrowsing = async (current: Program) => {
    dispatch({ type: "reading" });
    try {
      const data = await readBrowsing(current.api);
      if (get().program !== current) return;
      dispatch({ type: "browsed", funcs: data.functions, map: data.map, rows: data.rows });
      return data.functions;
    } catch (e) {
      if (get().program === current) dispatch({ type: "browseFailed", message: e instanceof Error ? e.message : String(e) });
    } finally { if (get().program === current) dispatch({ type: "readingDone" }); }
  };

  const open = async (p: string, options: ImportOptions = {}, stored?: ProgramEntry, mode?: AnalysisMode) => {
    if (blocked()) return;
    dispatch({ type: "openStarted", path: p, startedAt: Date.now() });
    try {
      const onProgress = (progress: OpenProgress) => dispatch({ type: "progress", p: progress });
      const m = mode ?? (opts.autotest ? "blocking" : undefined); // the autotest's older flows expect a finished analysis when open returns
      const job = openJob = stored ? backend.projects.reopen(stored, onProgress, m) : lifecycle.open(p, options, onProgress, m);
      const outcome = await resolveOpen(job, lifecycle);
      if (outcome.kind === "unknown") {
        dispatch({ type: "unavailable" });
        setNotice("Could not confirm the active program. Restart Ghidrette to reconnect.");
        fail(outcome.reconciliationError);
        return;
      }
      const current = selectSession(outcome.session);
      if (outcome.kind === "failed") {
        if (isFailure(outcome.error, "cancelled")) setNotice("Open cancelled.");
        else { fail(outcome.error); setNotice("Could not open " + p); }
        return;
      }
      dispatch({ type: "analysis", state: outcome.session.analysis ?? null });
      if (!opts.autotest) window.host.recentAdd(p).catch(() => {});
      return await loadBrowsing(current!);
    } finally {
      openJob = null; dispatch({ type: "openEnded" });
      const change = changeDuringOpen;
      changeDuringOpen = null;
      if (change && get().program?.session.sessionId === change.sessionId) programChanged(change.sessionId, change.p);
    }
  };

  /** Open a program from the browser; "full" also upgrades a finished fast analysis (a partial one resumes by itself when opened). */
  const openStored = (entry: ProgramEntry, then?: "full") =>
    open(entry.sourcePath ?? entry.name, {}, entry).then((fl) => { if (fl && then) void analysisAction("full"); });
  /** The status bar's analysis button, and Run full analysis. */
  const analysisAction = (a: "cancel" | "resume" | "full") => send(async () => {
    const current = get().program;
    if (!current) return;
    if (a === "cancel") await current.api.analysis.cancel();
    else { const state = await current.api.analysis.start(a === "full" ? "full" : undefined); if (get().program === current) dispatch({ type: "analysis", state }); }
  });
  const analysisChanged = (sessionId: string, state: AnalysisState) => { if (get().program?.session.sessionId === sessionId) dispatch({ type: "analysis", state }); };

  /** The debug menu (attach is a dialog, features/debug.ts): detach, continue, pause, step, toggle a breakpoint at `address`. The result is the debug_state that follows. */
  const debugChanged = (sessionId: string, state: DebugState) => { if (get().program?.session.sessionId === sessionId) dispatch({ type: "debug", state }); };
  const debugAction = (a: "detach" | "continue" | "pause" | "step" | "breakpoint", address?: Address) => send(async () => {
    const current = get().program;
    if (!current) return;
    const d = current.api.debug, st = get().debug?.state ?? "detached";
    if (a === "breakpoint") await d.breakpoint({ address: address! });
    else if (st === "detached") flash("Not attached to a target. Use Debug > Attach to QEMU…");
    else if (a === "detach") await d.detach();
    else if (a === "pause") { if (st === "running") await d.pause(); }
    else if (st === "stopped") await (a === "continue" ? d.continue() : d.step());
  });

  const closeProgram = async () => {
    const current = get().program;
    if (!current || blocked()) return;
    dispatch({ type: "closing", on: true });
    try {
      await lifecycle.close(current.session);
      selectSession(null); setNotice(""); dispatch({ type: "error", message: "" });
    } catch (e) { fail(e); }
    finally { dispatch({ type: "closing", on: false }); }
  };

  const cancelOpen = () => {
    const job = openJob;
    if (!job) return;
    const setCancelling = (on: boolean) => { if (openJob === job) dispatch({ type: "cancelling", on }); };
    setCancelling(true);
    job.cancel().then((cancelled) => { if (!cancelled) setCancelling(false); }, (e) => { setCancelling(false); fail(e); });
  };

  const refreshFunctions = async (current: Program) => {
    const fl = await refetch(current.api.functions.list());
    if (fl && get().program === current) dispatch({ type: "funcs", funcs: fl });
    return fl ?? get().funcs;
  };
  const refreshUndo = () => {
    const current = get().program;
    return caps.has("undo") && current ? current.api.history.state().then((u) => { if (get().program === current) dispatch({ type: "undo", u }); }, fail) : Promise.resolve();
  };
  const save = async () => {
    const current = get().program;
    if (!current || get().saving) return;
    dispatch({ type: "saving", on: true });
    try { await current.api.history.save(); await refreshUndo(); } catch (e) { fail(e); } finally { dispatch({ type: "saving", on: false }); }
  };
  const undoRedo = (kind: "undo" | "redo") => send(async () => {
    const current = get().program!;
    const u = await current.api.history[kind]();
    if (get().program === current) dispatch({ type: "undo", u });
  });

  /** program_changed: a save only flips `dirty`; everything else is announced to the reactions. While an open runs the change is held and coalesced. */
  function programChanged(sessionId: string, p: ProgramChange) {
    const current = get().program;
    if (current?.session.sessionId !== sessionId) return;
    if (get().opening) {
      // Program RPCs resume when the open finishes. Keep the last undo state and coalesce any required refresh.
      const refresh = changeDuringOpen?.p.ranges === null || !p.ranges || p.ranges.length > 0 || p.kinds.length > 0;
      changeDuringOpen = { sessionId, p: { ranges: refresh ? null : [], kinds: refresh ? ["other"] : [], undo: p.undo } };
      return;
    }
    if (p.ranges && !p.ranges.length && !p.kinds.length) { dispatch({ type: "undo", u: p.undo }); return; } // save: only `dirty` changed
    current.lookup.clear();
    views.dispatch({ type: "set", patch: (v) => ({ dataVersion: v.dataVersion + 1, typesVersion: v.typesVersion + 1 }) });
    for (const f of [...changeSubs]) f(p, current);
  }

  const session = {
    backend, caps, store, views, refs, errors, opts, menu: { current: null as import("../../preload/index").MenuState | null },
    blocked, fail, flash, setNotice, send, selectSession, loadBrowsing, open, openStored, analysisAction, analysisChanged, debugAction, debugChanged, closeProgram, cancelOpen, refreshFunctions, refreshUndo, save, undoRedo, programChanged,
    /** the program the UI shows right now (null if none) */
    program: () => get().program,
    onReset: (f: () => void) => { resetSubs.add(f); return () => { resetSubs.delete(f); }; },
    onChanged: (f: (p: ProgramChange, current: Program) => void) => { changeSubs.add(f); return () => { changeSubs.delete(f); }; },
  };
  return session;
}
export type Session = ReturnType<typeof createSession>;

const Ctx = createContext<Session>(null!);
export const SessionProvider = Ctx.Provider;
export const useSession = () => useContext(Ctx);
/** Select from the program store (primitives or stable references). */
export const useProgram = <T,>(select: (s: ProgramState) => T): T => useStore(useSession().store, select);
export const useViews = <T,>(select: (v: import("./views").Views) => T): T => useStore(useSession().views, select);

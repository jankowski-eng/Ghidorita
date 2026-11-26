import type { ActiveSession, Address, AnalysisState, DebugState, DebugValue, FunctionInfo, ListingRow, UndoState } from "../../../../protocol";
import type { AddrMap } from "../addrmap";
import { changedRegs, regValues, type DebugView } from "../debug";
const HISTORY = 500; // stops kept for stepping back
import type { ProgramOperations } from "../backend";
import type { Progress } from "../OpenDialog";
import type { Stats } from "../StatusBar";
import type { functionLookup } from "../symbols";

export const noUndo: UndoState = { canUndo: false, canRedo: false, dirty: false };
/** The active session with its operations and the containing-function lookup bound to it. */
export type Program = { session: ActiveSession; api: ProgramOperations; lookup: ReturnType<typeof functionLookup> };

export interface OpeningState { path: string; startedAt: number; cancelling: boolean }
/** What the UI knows about the open program and the open/close/save flows. `program` drops everything that belongs to one program (see "program"). */
export interface ProgramState {
  program: Program | null;
  opening: OpeningState | null;
  progress: Progress | null;
  closing: boolean;
  /** the active program could not be confirmed after a failed open: only a restart reconnects */
  unavailable: boolean;
  funcs: FunctionInfo[];
  map: AddrMap | null;
  initialRows: ListingRow[];
  reading: boolean;
  browseError: string;
  undo: UndoState;
  /** `analysis` capability: the background analysis of the open program (null = none known) */
  analysis: AnalysisState | null;
  /** `debugger` capability: the last debug_state (null = none yet) with the registers that changed at its stop; `debugLast` = the registers of the previous stop */
  debug: DebugView | null;
  debugLast: Record<string, string>;
  /** every stop since the attach (newest last) and which one the panes show: null = the live one */
  debugHistory: DebugView[];
  debugAt: number | null;
  saving: boolean;
  stats: Stats;
  /** `error` is the last failure (status bar), `notice` the welcome pane's line, `flash` a five second status bar hint */
  error: string; notice: string; flash: string;
}

export const initialProgram: ProgramState = {
  program: null, opening: null, progress: null, closing: false, unavailable: false, funcs: [], map: null, initialRows: [], reading: false, browseError: "",
  undo: noUndo, analysis: null, debug: null, debugLast: {}, debugHistory: [], debugAt: null, saving: false, stats: {}, error: "", notice: "", flash: "",
};

export type ProgramAction =
  | { type: "program"; program: Program | null }                            // another session: forgets what belongs to the old one (the messages stay)
  | { type: "openStarted"; path: string; startedAt: number }                 // also clears the messages and progress
  | { type: "openEnded" }
  | { type: "progress"; p: Progress }
  | { type: "cancelling"; on: boolean }
  | { type: "closing"; on: boolean } | { type: "unavailable" }
  | { type: "reading" } | { type: "browsed"; funcs: FunctionInfo[]; map: AddrMap; rows: ListingRow[] } | { type: "browseFailed"; message: string } | { type: "readingDone" }
  | { type: "funcs"; funcs: FunctionInfo[] }
  | { type: "undo"; u: UndoState }
  | { type: "analysis"; state: AnalysisState | null }
  | { type: "debug"; state: DebugState }
  | { type: "debugView"; to: "back" | "forward" | "live" }
  | { type: "debugFunction"; stop: number; entry: Address | null }
  | { type: "debugValues"; stop: number; entry: Address; items: DebugValue[] }
  | { type: "saving"; on: boolean }
  | { type: "stats"; patch: Stats }
  | { type: "error"; message: string } | { type: "notice"; message: string } | { type: "flash"; message: string };

export function programReducer(s: ProgramState, a: ProgramAction): ProgramState {
  switch (a.type) {
    case "program": return { ...s, program: a.program, funcs: [], map: null, initialRows: [], undo: noUndo, analysis: null, debug: null, debugLast: {}, debugHistory: [], debugAt: null, stats: {}, reading: false, browseError: "" };
    case "openStarted": return { ...s, error: "", notice: "", progress: null, opening: { path: a.path, startedAt: a.startedAt, cancelling: false } };
    case "openEnded": return { ...s, opening: null, progress: null };
    case "progress": return !s.opening || s.opening.cancelling ? s : { ...s, progress: a.p }; // late progress after cancel is dropped
    case "cancelling": return s.opening ? { ...s, opening: { ...s.opening, cancelling: a.on } } : s;
    case "closing": return { ...s, closing: a.on };
    case "unavailable": return { ...s, unavailable: true };
    case "reading": return { ...s, reading: true, browseError: "" };
    case "browsed": return { ...s, funcs: a.funcs, map: a.map, initialRows: a.rows };
    case "browseFailed": return { ...s, browseError: a.message };
    case "readingDone": return { ...s, reading: false };
    case "funcs": return { ...s, funcs: a.funcs };
    case "undo": return { ...s, undo: a.u };
    case "analysis": return { ...s, analysis: a.state };
    case "debug": {
      const st = a.state, prev = s.debug;
      if (st.state !== "stopped") {
        const gone = st.state === "detached";
        return { ...s, debug: { ...st, changed: prev?.changed ?? {} }, debugLast: gone ? {} : s.debugLast, debugHistory: gone ? [] : s.debugHistory, debugAt: gone ? null : s.debugAt };
      }
      if (prev?.state === "stopped" && prev.stop === st.stop) return { ...s, debug: { ...st, changed: prev.changed, values: prev.values, fn: prev.fn } }; // the same stop again (a breakpoint toggled)
      const regs = st.registers ?? [], view: DebugView = { ...st, changed: changedRegs(s.debugLast, regs) };
      return { ...s, debug: view, debugLast: regValues(regs), debugHistory: [...s.debugHistory, view].slice(-HISTORY), debugAt: null }; // a new stop returns the panes to the live state
    }
    case "debugView": {
      const n = s.debugHistory.length, at = s.debugAt ?? n - 1;
      if (a.to === "live") return { ...s, debugAt: null };
      const next = at + (a.to === "back" ? -1 : 1);
      return next < 0 || n === 0 ? s : { ...s, debugAt: next >= n - 1 ? null : next };
    }
    case "debugFunction": {
      const i = s.debugHistory.findIndex((v) => v.stop === a.stop);
      if (i < 0) return s;
      const history = s.debugHistory.map((v, k) => (k === i ? { ...v, fn: a.entry } : v));
      return { ...s, debugHistory: history, debug: s.debug?.stop === a.stop ? { ...s.debug, fn: a.entry } : s.debug };
    }
    case "debugValues": {
      const i = s.debugHistory.findIndex((v) => v.stop === a.stop);
      if (i < 0) return s;
      const before = s.debugHistory[i - 1]?.values, was = before && before.entry === a.entry ? Object.fromEntries(before.items.map((x) => [x.name, x.value])) : {};
      const view = { ...s.debugHistory[i], fn: a.entry, values: { entry: a.entry, items: a.items, was } }, history = s.debugHistory.map((v, k) => (k === i ? view : v));
      return { ...s, debugHistory: history, debug: s.debug?.stop === a.stop ? { ...s.debug, values: view.values } : s.debug };
    }
    case "saving": return { ...s, saving: a.on };
    case "stats": return { ...s, stats: { ...s.stats, ...a.patch } };
    case "error": return { ...s, error: a.message };
    case "notice": return { ...s, notice: a.message };
    case "flash": return { ...s, flash: a.message };
  }
}

/** The stop the panes show: the live one, or the recorded one the user stepped back to. */
export const shownDebug = (s: ProgramState): DebugView | null => (s.debugAt !== null ? s.debugHistory[s.debugAt] ?? s.debug : s.debug);

import type { ActiveSession, FunctionInfo, ListingRow, UndoState } from "../../../../protocol";
import type { AddrMap } from "../addrmap";
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
  saving: boolean;
  stats: Stats;
  /** `error` is the last failure (status bar), `notice` the welcome pane's line, `flash` a five second status bar hint */
  error: string; notice: string; flash: string;
}

export const initialProgram: ProgramState = {
  program: null, opening: null, progress: null, closing: false, unavailable: false, funcs: [], map: null, initialRows: [], reading: false, browseError: "",
  undo: noUndo, saving: false, stats: {}, error: "", notice: "", flash: "",
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
  | { type: "saving"; on: boolean }
  | { type: "stats"; patch: Stats }
  | { type: "error"; message: string } | { type: "notice"; message: string } | { type: "flash"; message: string };

export function programReducer(s: ProgramState, a: ProgramAction): ProgramState {
  switch (a.type) {
    case "program": return { ...s, program: a.program, funcs: [], map: null, initialRows: [], undo: noUndo, stats: {}, reading: false, browseError: "" };
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
    case "saving": return { ...s, saving: a.on };
    case "stats": return { ...s, stats: { ...s.stats, ...a.patch } };
    case "error": return { ...s, error: a.message };
    case "notice": return { ...s, notice: a.message };
    case "flash": return { ...s, flash: a.message };
  }
}

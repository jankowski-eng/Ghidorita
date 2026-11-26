import type {
  ActiveSession, AnalysisState, Address, AddrRange, Capability, CommentKind, DataTypeDetail, DataTypeHit, DecompileResult,
  DtSource, EnumOp, FunctionInfo, ImportChoices, ImportOptions, LanguageInfo, ListingRow, ListSymbolsParams,
  MemoryHit, OpenResult, ProgramEntry, SearchMemoryParams, StringItem, StructOp, SymbolHit, SymbolRow, UndoState, XrefFrom, XrefTo,
  BookmarkItem, CallGraph, ChangeKind, DebugMemory, DebugState, DebugValue, FunctionCalls, ListBookmarksParams, FunctionGraph, TopSymbol, StackFrame,
} from "../../../protocol";

export type Failure = "noProgram" | "cancelled" | "timeout" | "notFound" | "busy" | "projectLocked" | "stale" | "invalid" | "unsupported" | "target" | "connection" | "protocol" | "internal";
export class BackendError extends Error {
  constructor(public kind: Failure, message: string) { super(message); }
}
export const isFailure = (error: unknown, kind: Failure): boolean => error instanceof BackendError && error.kind === kind;
export const isObsolete = (error: unknown): boolean => isFailure(error, "stale") || isFailure(error, "noProgram");

export interface Job<T> { result: Promise<T>; cancel(): void }
export interface OpenJob { result: Promise<OpenResult>; cancel(): Promise<boolean> }
export interface OpenProgress { phase: string; pct: number; message: string; analyzer?: string; done?: number }
export interface ProgramChange { ranges: { start: Address; end: Address }[] | null; kinds: ChangeKind[]; undo: UndoState }

/** `analysis` capability: "background" (default) replies once the program is published and analyzes on; "blocking" replies when the analysis is done. */
export type AnalysisMode = "background" | "blocking";
export interface ProgramLifecycle {
  open(path: string, options: ImportOptions, onProgress: (progress: OpenProgress) => void, mode?: AnalysisMode): OpenJob;
  active(): Promise<ActiveSession | null>;
  close(session: ActiveSession): Promise<void>;
}
export interface ProviderEvents {
  onChange(listener: (sessionId: string, change: ProgramChange) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  onAnalysis(listener: (sessionId: string, state: AnalysisState) => void): () => void;
  onDebug(listener: (sessionId: string, state: DebugState) => void): () => void;
}

export interface ListingReads {
  info(): Promise<{ ranges: AddrRange[]; totalBytes: number }>;
  rows(params: { address: Address; count: number; direction?: "forward" | "backward" }): Promise<ListingRow[]>;
  /** hex bytes ("48 8b 05"), 1..65536; NotFound unless all are initialized memory. Capability "bytes". */
  bytes(params: { address: Address; length: number }): Promise<{ address: Address; length: number; bytes: string }>;
}

export interface FunctionNavigation {
  list(): Promise<FunctionInfo[]>;
  containing(params: { address: Address }): Promise<{ name: string; entry: Address; size: number; signature: string } | null>;
  /** the function's stack variables by offset (capability "stackFrame"); a quick read on thread R, not a Job */
  stackFrame(params: { entry: Address }): Promise<StackFrame>;
}

export interface Decompilation {
  decompile(params: { entry: Address; timeoutSecs?: number }): Job<DecompileResult>;
  /** Basic-block graph of one function; only with the controlFlowGraph capability. */
  graph(params: { entry: Address; timeoutSecs?: number }): Job<FunctionGraph>;
}

export interface References {
  xrefsTo(params: { address: Address; limit?: number }): Promise<XrefTo[]>;
  xrefsFrom(params: { address: Address }): Promise<XrefFrom[]>;
  xrefsToVariable(params: { entry: Address; name: string; limit?: number }): Promise<XrefTo[]>;
  variableUses(params: { entry: Address; name: string; timeoutSecs?: number }): Job<XrefTo[]>;
  /** Callers and callees around `entry`, or every route to `to` (callGraph capability). */
  callGraph(params: { entry: Address; depth?: number; to?: Address; maxDepth?: number }): Job<CallGraph>; // a scan: cancel it when the view's target changes
  /** callers and callees of a function; capability "calls" */
  calls(params: { entry: Address }): Job<FunctionCalls>;
}

export interface Searches {
  searchSymbols(params: { query: string; limit?: number }): Job<SymbolHit[]>;
  /** What an empty command bar suggests (suggestions capability): entry points, most used imports and functions (the client ranks them: rank.ts). */
  topSymbols(params: { limit?: number }): Job<TopSymbol[]>;
  listSymbols(params: ListSymbolsParams): Job<{ total: number; items: SymbolRow[] }>;
  listStrings(params: { offset?: number; limit?: number; minLength?: number; query?: string; referencedOnly?: boolean }): Job<{ total: number; items: StringItem[] }>;
  searchMemory(params: SearchMemoryParams): Job<{ items: MemoryHit[]; next: Address | null }>;
}

export interface TypeReads {
  listDataTypes(params: { query: string; limit?: number }): Job<DataTypeHit[]>;
  dtSources(): Promise<DtSource[]>;
  dtChildren(params: { source?: string; path?: string }): Promise<{ categories: { name: string; path: string }[]; types: DataTypeHit[] }>;
  getDataType(params: { path: string; source?: string }): Promise<DataTypeDetail>;
}

export interface TypeEdits {
  createDataType(params: { kind: "struct" | "union" | "enum" | "typedef" | "pointer" | "category"; name?: string; category?: string; size?: number; base?: string }): Promise<{ path: string }>;
  deleteDataType(params: { path: string; category?: boolean }): Promise<{}>;
  renameDataType(params: { path: string; newName: string }): Promise<{ path: string }>;
  editStruct(params: { path: string; op: StructOp }): Promise<{}>;
  editEnum(params: { path: string; op: EnumOp }): Promise<{}>;
}

export interface Bookmarks {
  /** a scan: cancel it when the query changes (cancel_search) */
  list(params: ListBookmarksParams): Job<{ total: number; types: { type: string; count: number }[]; items: BookmarkItem[] }>;
  /** a Note bookmark; one undo step */
  set(params: { address: Address; category: string; comment: string }): Promise<{}>;
  /** category omitted = every category of that type at the address; a row always passes its own (one undo step) */
  remove(params: { address: Address; type: string; category?: string }): Promise<{}>;
}

export interface ProgramEdits {
  getComments(params: { address: Address }): Promise<Partial<Record<CommentKind, string>>>;
  renameSymbol(params: { address: Address; newName: string }): Promise<{}>;
  createLabel(params: { address: Address; name: string }): Promise<{}>;
  setComment(params: { address: Address; kind: CommentKind; text: string }): Promise<{}>;
  createFunction(params: { address: Address; name?: string }): Promise<{ entry: Address; name: string }>;
  setFunctionSignature(params: { entry: Address; signature: string }): Promise<{}>;
  renameVariable(params: { entry: Address; name: string; newName: string; timeoutSecs?: number }): Promise<{}>;
  retypeVariable(params: { entry: Address; name: string; dataType: string; timeoutSecs?: number }): Promise<{}>;
  /** decompilerEdits: one operand's equate; value/size are the const token's constValue/constSize, address its address */
  setEquate(params: { address: Address; value: string; size: number; name: string; enum?: string }): Promise<{}>;
  /** the callers' decompile caches are dropped by the provider */
  setFunctionNoReturn(params: { entry: Address; noReturn?: boolean }): Promise<{}>;
  splitVariable(params: { entry: Address; name: string; address: Address; newName: string; timeoutSecs?: number }): Promise<{}>;
  /** union tokens carry `union` and `unionAt`; field null = no field */
  forceUnionField(params: { entry: Address; address: Address; text: string; field: string | null; occurrence?: number; timeoutSecs?: number }): Promise<{}>;
  defineData(params: { address: Address; dataType: string }): Promise<{}>;
  clearCode(params: { address: Address; length?: number }): Promise<{}>;
  createStructFromData(params: { address: Address; length: number; name: string; category?: string; apply?: boolean }): Promise<{ path: string }>;
  autoCreateStructure(params: { entry: Address; name: string; structName?: string }): Promise<{ path: string }>;
}

export interface ProgramHistory {
  state(): Promise<UndoState>;
  undo(): Promise<UndoState>;
  redo(): Promise<UndoState>;
  save(): Promise<{ saved: boolean; undoHistoryCleared: boolean }>;
}

export interface CoverageReads {
  load(params: { path: string }): Promise<{ ranges: { start: Address; end: Address }[] }>;
}

export interface Exports {
  symbols(params: { path: string }): Promise<{ path: string; functions: number; labels: number; data: number; comments: number }>;
  header(params: { path: string }): Promise<{ path: string; types: number; functions: number; skipped: number }>;
  gzf(params: { path: string }): Promise<{ path: string; bytes: number }>;
}

export interface ProjectCatalog {
  list(): Promise<ProgramEntry[]>;
  remove(params: { programId: string }): Promise<{}>;
  /** Opens the stored program by its programId, whatever became of its source file. */
  reopen(entry: ProgramEntry, progress: (event: OpenProgress) => void, mode?: AnalysisMode): OpenJob;
}

export interface ImportSelection {
  choices(params: { path: string }): Promise<ImportChoices>;
  languages(): Promise<LanguageInfo[]>;
}

/** Analysis of the open program (`analysis` capability). start without a profile = the recorded one; fast to full on a finished fast program keeps the programId. */
export interface AnalysisControl {
  status(): Promise<AnalysisState>;
  start(profile?: "full" | "fast"): Promise<AnalysisState>;
  cancel(): Promise<{ cancelled: boolean }>;
}

/** `debugger` capability: a GDB remote stub (QEMU). The calls return nothing: the state arrives through `events.onDebug`. */
export interface DebugControl {
  attach(params: { host?: string; port?: number; offset?: string }): Promise<{}>;
  detach(): Promise<{}>;
  breakpoint(params: { address: Address }): Promise<{}>;
  continue(): Promise<{}>;
  /** mode "statement": run to the next of `boundaries` (program addresses where a statement of the pc's function starts) */
  step(params?: { mode?: "instruction" | "statement" | "into" | "out"; boundaries?: Address[] }): Promise<{}>;
  memory(params: { address: Address; length?: number; dataType?: string }): Promise<DebugMemory>;
  values(params: { entry: Address }): Job<{ pc: Address | null; items: DebugValue[] }>;
  pause(): Promise<{}>;
  status(): Promise<DebugState>;
}

/** Operations bound to one active session. A retained callback continues to address that session. */
export interface ProgramOperations {
  listing: ListingReads;
  functions: FunctionNavigation;
  decompiler: Decompilation;
  references: References;
  searches: Searches;
  types: TypeReads;
  typeEdits: TypeEdits;
  edits: ProgramEdits;
  bookmarks: Bookmarks;
  history: ProgramHistory;
  coverage: CoverageReads;
  exports: Exports;
  analysis: AnalysisControl;
  debug: DebugControl;
}
export interface ApplicationBackend {
  capabilities: ReadonlySet<Capability>;
  recovery?: { snapshotIntervalSeconds: number };
  lifecycle: ProgramLifecycle;
  events: ProviderEvents;
  projects: ProjectCatalog;
  imports: ImportSelection;
  program(session: ActiveSession): ProgramOperations;
}

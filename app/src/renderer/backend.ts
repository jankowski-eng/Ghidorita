import type {
  ActiveSession, AnalysisState, Address, AddrRange, Capability, CommentKind, DataTypeDetail, DataTypeHit, DecompileResult,
  DtSource, EnumOp, FunctionInfo, ImportChoices, ImportOptions, LanguageInfo, ListingRow, ListSymbolsParams,
  MemoryHit, OpenResult, ProgramEntry, SearchMemoryParams, StringItem, StructOp, SymbolHit, SymbolRow, UndoState, XrefFrom, XrefTo,
  CallGraph, ChangeKind, FunctionGraph, TopSymbol,
} from "../../../protocol";

export type Failure = "noProgram" | "cancelled" | "timeout" | "notFound" | "busy" | "projectLocked" | "stale" | "invalid" | "unsupported" | "connection" | "protocol" | "internal";
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
}

export interface ListingReads {
  info(): Promise<{ ranges: AddrRange[]; totalBytes: number }>;
  rows(params: { address: Address; count: number; direction?: "forward" | "backward" }): Promise<ListingRow[]>;
}

export interface FunctionNavigation {
  list(): Promise<FunctionInfo[]>;
  containing(params: { address: Address }): Promise<{ name: string; entry: Address; size: number; signature: string } | null>;
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
  callGraph(params: { entry: Address; depth?: number; to?: Address; maxDepth?: number }): Promise<CallGraph>;
}

export interface Searches {
  searchSymbols(params: { query: string; limit?: number }): Job<SymbolHit[]>;
  /** What an empty command bar suggests (suggestions capability): entry points, most used imports and functions. */
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

export interface ProgramEdits {
  getComments(params: { address: Address }): Promise<Partial<Record<CommentKind, string>>>;
  renameSymbol(params: { address: Address; newName: string }): Promise<{}>;
  createLabel(params: { address: Address; name: string }): Promise<{}>;
  setComment(params: { address: Address; kind: CommentKind; text: string }): Promise<{}>;
  createFunction(params: { address: Address; name?: string }): Promise<{ entry: Address; name: string }>;
  setFunctionSignature(params: { entry: Address; signature: string }): Promise<{}>;
  renameVariable(params: { entry: Address; name: string; newName: string; timeoutSecs?: number }): Promise<{}>;
  retypeVariable(params: { entry: Address; name: string; dataType: string; timeoutSecs?: number }): Promise<{}>;
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
  history: ProgramHistory;
  coverage: CoverageReads;
  exports: Exports;
  analysis: AnalysisControl;
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

// JSON-RPC 2.0 over WebSocket. Source of truth: protocol.md.

/**
 * Address string, always unsigned hex (up to 64 bit, never negative). Default space: "0x401000" (lowercase, no padding).
 * Any other space: "<space>:<hex>", an overlay space "<space>::<hex>" (Ghidra's own spelling), e.g. "code:1000", "OVL1::1000", "0xffffffffffff0000".
 * The parts are split at the last ":" (a trailing ":" belongs to the space name). Input also accepts "ram:401000" for the default space.
 */
export type Address = string;

export interface Request<M extends keyof Methods = keyof Methods> {
  jsonrpc: "2.0";
  id: number;
  sessionId?: string;
  method: M;
  params: Methods[M]["params"];
}

export interface Notification<N extends keyof Notifications = keyof Notifications> {
  jsonrpc: "2.0";
  method: N;
  params: Notifications[N];
}

export interface RpcError {
  code: number; // see ErrorCode
  message: string;
}

export const ErrorCode = {
  NoProgram: -32001,
  Cancelled: -32002,
  Timeout: -32003,
  NotFound: -32004,
  Busy: -32005,            // open_binary in progress (or a second open_binary); "analysis running": an edit, undo or redo while the analysis runs; "analysis already running": start_analysis
  ProjectLocked: -32006,   // another sidecar holds the projects dir
  StaleSession: -32007,
  Target: -32008,          // the debug target: connection refused, lost, unknown architecture, not attached (plain words in the message)
  InvalidArgument: -32602, // bad/missing params, unparsable type or signature, invalid name
  Internal: -32603,
  MethodNotFound: -32601,
} as const;

export interface FunctionInfo {
  name: string;
  entry: Address;
  size: number;
  source?: SymbolSource; // where the name came from: "user" = renamed by a person, "default" = FUN_xxxx, "analysis"/"imported" = a guess or the file's own
}

export type TokenKind =
  | "keyword" | "type" | "function" | "variable" | "param"
  | "const" | "comment" | "label" | "field" | "default";

export interface Token {
  line: number;      // 0-based line index in `text`
  colStart: number;  // 0-based, inclusive, UTF-16 units of that line in `text`
  colEnd: number;    // exclusive
  kind: TokenKind;
  address?: Address;        // address of the originating instruction, if any
  varAddress?: Address;     // variable/param tokens only: the memory address of a global variable (xrefs_to this address finds its references); absent for locals and temporaries
  varName?: string;
  targetFunction?: Address; // set on function-name tokens of calls to a known function
}

export interface DecompileResult {
  text: string;
  tokens: Token[];
  cached: boolean;
}

export interface GraphBlock { start: Address; end: Address; kind: "c" | "asm"; lines: string[] } // end = last byte of the block; lines: C source lines or "addr  instruction"
export interface GraphEdge { from: Address; to: Address; kind: "true" | "false" | "uncond" } // from/to = block starts; true/false only after a conditional branch (false = fall through)
export interface FunctionGraph { blocks: GraphBlock[]; edges: GraphEdge[] } // blocks in address order; the first is not necessarily the entry
export interface CallGraphNode { entry: Address; name: string; kind: "function" | "import" } // import: an external function or a thunk to one (a leaf)
export interface CallGraph { nodes: CallGraphNode[]; edges: { from: Address; to: Address; sites: number }[]; truncated: boolean } // sites: call instructions from `from` to `to`

export interface ListingRow {
  address: Address;
  length: number;    // code unit length in bytes; next row (if contiguous) starts at address + length
  bytes: string;     // hex, e.g. "55 48 89 e5"
  mnemonic: string;  // for data: the data type name, e.g. "db", "ds"
  operands: string;
  label?: string;    // primary symbol at this address
  labels?: string[]; // only when there is more than one symbol: all of them, primary first (labels[0] === label)
  comment?: string;  // EOL comment
  pre?: string;      // pre, post, plate and repeatable comments (multi-line text, "\n" separated); absent when not set
  post?: string;
  plate?: string;
  repeatable?: string;
  header?: FunctionHeader; // set on the row at a function's entry
  xrefs?: RowXrefs;        // set when something references this address
  parts?: DataPart[];      // defined struct/array/union data: its components (the row shows them folded, the client may unfold)
  partsTotal?: number;     // component count when parts is cut (shortcut: first PARTS_MAX = 64)
  bookmarks?: { category: string; comment: string }[]; // the user's own bookmarks (type Note) on this unit; the analyzers' bookmarks are not marked
  bytesMore?: number;      // bytes of the unit not in `bytes` (bytes shows at most 16; get_bytes has them all)
}

export interface FunctionHeader {
  signature: string;          // C prototype as Ghidra prints it
  convention?: string;        // calling convention name, absent when unknown/default
  params: number;             // parameter count
  paramBytes: number;         // stack frame: parameter area size
  localBytes: number;         // stack frame: locals area size
  noReturn?: boolean;
  thunk?: boolean;
}

/** Reference annotation: "XREF[count]: a, b, ...". items is cut at 5 (shortcut), count is the full number of memory references to the address. */
export interface RowXrefs {
  count: number;
  items: { from: Address; kind: "call" | "jump" | "read" | "write" | "readwrite" | "data" | "flow" | "other" }[];
}

export interface DataPart {
  offset: number;   // byte offset inside the unit
  length: number;
  type: string;     // data type name
  name: string;     // field name, or "[i]" for array elements
  value: string;    // display value
}

/**
 * A contiguous loaded+initialized address range, non-overlapping. `start` may be in any address space. Ranges come in the sidecar's
 * traversal order (Ghidra's address order: spaces in space order, ascending inside a space): `listing_rows` walks the same order, so the
 * client maps scroll position <-> address by the sequence of ranges and must not re-sort them.
 */
export interface AddrRange {
  start: Address;
  size: number; // bytes
}

export const CAPABILITIES = [
  "importOptions", "decompile", "editing", "variableEditing", "undo", "save",
  "symbolSearch", "symbolTable", "strings", "memorySearch", "references", "variableReferences",
  "dataTypes", "typeEditing", "projects", "recovery", "coverage", "controlFlowGraph", "callGraph", "suggestions", "export", "exportGzf", "bytes", "calls", "bookmarks", "analysis", "debugger",
] as const;
export type Capability = typeof CAPABILITIES[number];
export interface ProviderInfo { version: 1; provider: string; capabilities: Capability[]; recovery?: { snapshotIntervalSeconds: number } }
export interface ActiveSession { sessionId: string; programId: string; name: string }
export interface OpenResult extends ActiveSession { persisted: boolean; analysis?: AnalysisState } // analysis: only from providers with the `analysis` capability
export interface ImportChoices {
  candidates: ImportCandidate[];
  sizeBytes: number;
  entropy: number[];
  profiles?: { id: AnalysisProfile; label: string }[];
  defaultProfile?: AnalysisProfile;
  note?: string;
  layout?: FileLayout | null; // optional: where the provider can read file headers
}

export interface Methods {
  provider_info: { params: {}; result: ProviderInfo };
  active_session: { params: {}; result: ActiveSession | null };
  // analysis (default "background"): the reply comes right after the import is saved and published, analysis keeps running on its own lane (see AnalysisState, protocol.md "Analysis"). "blocking": the reply waits for the analysis (`progress` events, cancel_open cancels it and nothing is saved).
  open_binary: { params: { path: string; analysis?: "background" | "blocking" } & ImportOptions; result: OpenResult };
  // Opens a stored program (capability "projects") by the programId of list_programs: no path, no source file read or hashed, so it works when the binary moved, vanished or changed. NotFound if the project has no such program. Same lifecycle, progress events, cancel_open, Busy and analysis rules as open_binary; persisted is always true.
  open_program: { params: { programId: string; analysis?: "background" | "blocking" }; result: OpenResult };
  cancel_open: { params: { id?: number }; result: { cancelled: boolean } };
  analysis_status: { params: {}; result: AnalysisState };
  // Starts (or resumes) the analysis of the open program. profile omitted = the program's recorded profile. fast -> full on a finished fast program runs only the three analyzers the fast profile skipped; the programId does not change. No-op (returns the state) if the program is already analyzed with that profile or better. Busy while an analysis runs.
  start_analysis: { params: { profile?: "full" | "fast" }; result: AnalysisState };
  // Stops the running analysis at the next monitor check; what it found so far is kept (recorded analysis becomes "partial"). cancelled=false if none runs.
  cancel_analysis: { params: {}; result: { cancelled: boolean } }; // session-scoped (StaleSession), unlike the cancels by request id
  import_candidates: { params: { path: string }; result: ImportChoices };
  list_languages: { params: {}; result: LanguageInfo[] };
  close_program: { params: {}; result: {} };
  list_programs: { params: {}; result: ProgramEntry[] };
  delete_program: { params: { programId: string }; result: {} };
  list_functions: { params: {}; result: FunctionInfo[] };
  decompile: { params: { entry: Address; timeoutSecs?: number }; result: DecompileResult };
  // Control-flow graph of one function: basic blocks (C lines where the decompiler maps them, else assembly) and edges. Decompiler lane, cancellable with cancel_decompile.
  function_graph: { params: { entry: Address; timeoutSecs?: number }; result: FunctionGraph };
  // Call graph (scan lane, cancel_search; bounded by visited functions and time, `truncated` says a bound hit): without `to` the functions within `depth` calls of `entry` (callers and callees); with `to` the routes from entry to `to` at most one call longer than the shortest (and at most maxDepth calls).
  call_graph: { params: { entry: Address; depth?: number; to?: Address; maxDepth?: number }; result: CallGraph };
  // Debugger (thread R, debug_values on the scan lane; the new state arrives as `debug_state`, results are empty except debug_status). debug_attach connects to a GDB remote stub (QEMU's -gdb), reads its register description, stops there and installs the breakpoints; Target error if refused, lost or of another architecture than the program. Breakpoint toggles, continue, step and pause need the target stopped (resp. running for pause): Busy otherwise.
  debug_attach: { params: { host?: string; port?: number; offset?: string }; result: {} }; // offset: hex, runtime address minus program address (default "0x0")
  debug_detach: { params: {}; result: {} };
  debug_status: { params: {}; result: DebugState };
  debug_breakpoint: { params: { address: Address }; result: {} };
  debug_continue: { params: {}; result: {} };
  // mode "statement": runs instruction by instruction until the pc is at one of `boundaries` (program addresses where a statement of the pc's function starts: the client's decompiler line mapping; at most 5000), at a breakpoint or outside the function; a call is run over, a return stops in the caller; debug_pause ends it. The state is `running` meanwhile.
  debug_step: { params: { mode?: "instruction" | "statement" | "into" | "out"; boundaries?: Address[] }; result: {} };
  // Memory of the stopped target at a RUNTIME address (the values of registers), up to 4096 bytes; with dataType (a Ghidra type name or path) one item per component of a structure or array, else one item. Busy while running, Target error for unreadable memory.
  debug_memory: { params: { address: Address; length?: number; dataType?: string }; result: DebugMemory };
  // The variables of the function at `entry` with their values in the stopped target (decompiler parameters, locals, the globals it uses). Scan lane, cancellable with cancel_search.
  debug_values: { params: { entry: Address }; result: { pc: Address | null; items: DebugValue[] } };
  debug_pause: { params: {}; result: {} };
  cancel_decompile: { params: { id: number }; result: { cancelled: boolean } };
  listing_info: { params: {}; result: { ranges: AddrRange[]; totalBytes: number } };
  listing_rows: { params: { address: Address; count: number; direction?: "forward" | "backward" }; result: ListingRow[] };
  // ---- reads ----
  // Bytes as hex ("48 8b 05"), 1..65536 of them; NotFound unless every byte is initialized memory. Lane R. Capability "bytes".
  get_bytes: { params: { address: Address; length: number }; result: { address: Address; length: number; bytes: string } };
  get_function_at: { params: { address: Address }; result: { name: string; entry: Address; size: number; signature: string } | null };
  // Scan requests (search_symbols, list_symbols, list_strings, search_memory) run on scan workers, never behind or in front of listing fetches; cancel_search {id} cancels one by request id.
  search_symbols: { params: { query: string; limit?: number }; result: SymbolHit[] };
  top_symbols: { params: { limit?: number }; result: TopSymbol[] }; // the empty command bar's suggestions: entry points, then the most referenced imports and functions
  // Exports (protocol.md "Exports"): the sidecar writes the file at an absolute `path` the client picked.
  export_symbols: { params: { path: string }; result: { path: string; functions: number; labels: number; data: number; comments: number } };
  export_header: { params: { path: string }; result: { path: string; types: number; functions: number; skipped: number } };
  // Ghidra archive (.gzf) of the open program, written at an absolute `path`; exports the in-memory state, unsaved edits included. Lane R.
  export_gzf: { params: { path: string }; result: { path: string; bytes: number } };
  list_symbols: { params: ListSymbolsParams; result: { total: number; items: SymbolRow[] } };
  // Callers and callees of one function (Ghidra's getCallingFunctions / getCalledFunctions). Scan lane, cancellable with cancel_search. Capability "calls".
  function_calls: { params: { entry: Address }; result: FunctionCalls };
  // Bookmarks (Ghidra's BookmarkManager). list_bookmarks on the scan lane (cancel_search); set/remove are edits on R (one undo step each) that announce program_changed kind "bookmark" with the address. Capability "bookmarks".
  list_bookmarks: { params: ListBookmarksParams; result: { total: number; types: { type: string; count: number }[]; items: BookmarkItem[] } };
  set_bookmark: { params: { address: Address; category: string; comment: string }; result: {} };
  remove_bookmark: { params: { address: Address; type: string; category?: string }; result: {} }; // category omitted = every category of that type at the address (explicit "remove all here"; a row passes its own)
  xrefs_to: { params: { address: Address; limit?: number }; result: XrefTo[] };
  xrefs_to_variable: { params: { entry: Address; name: string; limit?: number }; result: XrefTo[] };
  // Uses of a decompiler local variable (iVar1, unaff_RDI...) inside one function: kind "write" = definition, "read" = use. Decompiler lane, cancellable with cancel_decompile.
  variable_uses: { params: { entry: Address; name: string; timeoutSecs?: number }; result: XrefTo[] };
  xrefs_from: { params: { address: Address }; result: XrefFrom[] };
  list_strings: { params: { offset?: number; limit?: number; minLength?: number; query?: string; referencedOnly?: boolean }; result: { total: number; items: StringItem[] } };
  search_memory: { params: SearchMemoryParams; result: { items: MemoryHit[]; next: Address | null } };
  cancel_search: { params: { id: number }; result: { cancelled: boolean } };
  get_comments: { params: { address: Address }; result: Partial<Record<CommentKind, string>> }; // only kinds that are set; NotFound if no code unit
  list_data_types: { params: { query: string; limit?: number }; result: DataTypeHit[] };
  // ---- data type manager (protocol.md "Data types") ----
  dt_sources: { params: {}; result: DtSource[] };
  dt_children: { params: { source?: string; path?: string }; result: { categories: { name: string; path: string }[]; types: DataTypeHit[] } };
  get_data_type: { params: { path: string; source?: string }; result: DataTypeDetail };
  undo_state: { params: {}; result: UndoState };
  load_coverage: { params: { path: string }; result: { ranges: { start: Address; end: Address }[] } }; // text file: `0xSTART-0xEND` (inclusive) or `0xADDR` per line, `#` comments; the client tints the listing
  // ---- edits: one Ghidra transaction each; the transaction name is the undo label ----
  rename_symbol: { params: { address: Address; newName: string }; result: {} };
  create_label: { params: { address: Address; name: string }; result: {} }; // where no symbol exists; InvalidArgument if one does (use rename_symbol)
  set_comment: { params: { address: Address; kind: CommentKind; text: string }; result: {} }; // empty text clears
  create_function: { params: { address: Address; name?: string }; result: { entry: Address; name: string } };
  set_function_signature: { params: { entry: Address; signature: string }; result: {} };
  // rename/retype_variable decompile first (thread R): Timeout after timeoutSecs (default 30), cancellable with cancel_decompile {id}
  rename_variable: { params: { entry: Address; name: string; newName: string; timeoutSecs?: number }; result: {} };
  retype_variable: { params: { entry: Address; name: string; dataType: string; timeoutSecs?: number }; result: {} };
  undo: { params: {}; result: UndoState };
  redo: { params: {}; result: UndoState };
  // define_data: Ghidra's CreateDataCmd (clears conflicting code/data at the target); dataType is a name or path ("int", "char[4]", "/dword"). InvalidArgument for unknown/dynamic types or no room.
  define_data: { params: { address: Address; dataType: string }; result: {} };
  // clear_code: Ghidra's ClearCmd (code, data, references; not symbols/comments); `length` bytes from `address` (default: the code unit at address).
  clear_code: { params: { address: Address; length?: number }; result: {} };
  // ---- data type edits (program's own types only; one transaction each, undo label in protocol.md) ----
  create_data_type: { params: { kind: "struct" | "union" | "enum" | "typedef" | "pointer" | "category"; name?: string; category?: string; size?: number; base?: string }; result: { path: string } };
  delete_data_type: { params: { path: string; category?: boolean }; result: {} };
  rename_data_type: { params: { path: string; newName: string }; result: { path: string } };
  edit_struct: { params: { path: string; op: StructOp }; result: {} };
  edit_enum: { params: { path: string; op: EnumOp }; result: {} };
  // Struct from the data items in [address, address+length) (instructions refused), applied at address unless apply=false; one transaction.
  create_struct_from_data: { params: { address: Address; length: number; name: string; category?: string; apply?: boolean }; result: { path: string } };
  // Ghidra's Auto Create Structure on a decompiler variable: infers a struct from the field accesses through it, retypes the variable to a pointer to it; one transaction. structName default: Ghidra's unique name in /auto_structs.
  auto_create_structure: { params: { entry: Address; name: string; structName?: string; timeoutSecs?: number }; result: { path: string } };
  // ---- persistence ----
  // Writes the program to the project. saved=false when nothing had changed. Ghidra drops the undo/redo history on save; a save that wrote fires program_changed {ranges: [], kinds: []} so clients learn the new UndoState. Also done automatically when a program is closed and on shutdown.
  save: { params: {}; result: { saved: boolean; undoHistoryCleared: boolean } };
}

/** All optional. Omit all = Ghidra's default import (preferred LoadSpec); programId stays the plain sha256. Any field present = explicit import, programId = sha256 + "-" + 12 hex of the options hash (protocol.md). */
export interface ImportOptions {
  loader?: string;        // ImportCandidate.loader, e.g. "Raw Binary"
  language?: string;      // Ghidra LanguageID, e.g. "ARM:LE:32:v8"
  compilerSpec?: string;  // CompilerSpecID, e.g. "default"; defaults to the language's default spec
  baseAddress?: Address;  // hex "0x08000000"; only for candidates with acceptsBaseAddress
  profile?: AnalysisProfile; // not an import option: omitted = SIDECAR_ANALYSIS_DISABLE or full; "fast" skips Call Convention ID, Decompiler Switch Analysis, Stack (own persistence key)
}
export type AnalysisProfile = string; // opaque provider profile id
/** Entry point and sections read from the file headers (ELF, PE, Mach-O; a universal Mach-O shows its first slice); entropy of each section is sampled. */
export interface FileLayout { entry: Address | null; sections: { name: string; size: number; entropy: number }[] }
export interface ImportCandidate {
  loader: string;
  language: string | null;      // null = the loader needs the user to pick one (Raw Binary); see list_languages
  compilerSpec: string | null;
  preferred: boolean;           // exactly one candidate has this set when any candidate exists
  acceptsBaseAddress: boolean;
  requiresLanguage?: boolean; // defaults to true when language is null
}
export interface LanguageInfo { id: string; description: string; compilerSpecs: { id: string; name: string }[] }
export interface ProgramEntry {
  programId: string;
  name: string;
  sourcePath?: string;          // path at first import; may no longer exist
  sizeBytes: number;            // size of the source file at import
  analyzed: boolean;            // analysis === "done"
  analysis?: AnalysisRecord;    // `analysis` capability: what the project has stored; "partial" = interrupted, open_binary resumes it
  analysisProfile?: "full" | "fast"; // the profile that ran (or runs) on it
  lastOpened?: string;          // ISO-8601 UTC
  options: ImportOptions;       // {} = default import
}

export type CommentKind = "eol" | "pre" | "post" | "plate" | "repeatable";
export type SymbolKind = "function" | "label" | "data" | "external" | "variable" | "other";
export type SymbolSource = "user" | "analysis" | "imported" | "default" | "other";
export type SymbolSort = "name" | "address" | "kind" | "namespace" | "source";
export interface SymbolHit { name: string; address: Address; kind: SymbolKind; refs?: number } // refs: references to the address (search_symbols, top_symbols)
export interface TopSymbol extends SymbolHit { refs: number; group: "entry" | "import" | "function" }
export interface SymbolRow { name: string; address: Address | null; kind: SymbolKind; namespace: string; source: SymbolSource } // address null: external or not in the default memory space (not navigable)
/** Page of the symbol table in `sort` order (default address ascending), after the name substring `query` (case-insensitive, `*`/`?` wildcards) and `kinds` (any of; empty = all). limit <= 1000. */
export interface ListSymbolsParams { offset?: number; limit?: number; query?: string; kinds?: SymbolKind[]; sort?: SymbolSort; desc?: boolean }
/** A function in a call list. entry is null for an external function (not navigable). A thunk names the function it finally forwards to. */
export interface CallRef { name: string; entry: Address | null; external: boolean }
export interface CallEdge extends CallRef { thunk: boolean; target?: CallRef }
export interface FunctionCalls { callers: CallEdge[]; callees: CallEdge[] }
export interface BookmarkItem { address: Address; type: string; category: string; comment: string } // type: "Note" (the user's), "Analysis", "Warning", "Error", "Info", ...
/** type omitted = every type; query = substring of category or comment; sort default address; limit <= 1000. `types` of the result counts every type before filtering. */
export interface ListBookmarksParams { type?: string; query?: string; offset?: number; limit?: number; sort?: "address" | "type" | "category"; desc?: boolean }
export type XrefKind = "call" | "jump" | "read" | "write" | "readwrite" | "data" | "flow" | "other";
export interface XrefTo { from: Address; type: string; kind: XrefKind; function?: string } // type: Ghidra RefType name, e.g. "UNCONDITIONAL_CALL"; kind: its class; function: name of function containing `from`
/** target "memory": `to` is the address. stack/register/external references have `to` null and a display `label` ("Stack[-0x10]", "RAX", the external name). */
export interface XrefFrom { to: Address | null; type: string; kind: XrefKind; target: "memory" | "stack" | "register" | "external"; label?: string }
export interface StringItem { address: Address; value: string; length: number; refs: number; refFrom?: { from: Address; function?: string }[] } // value cut at 1000 UTF-16 units; length = bytes of the defined string; refs = references to it, refFrom = the first 3
/** kind "bytes": hex with wildcards ("48 8b ?? 24"); "text": a string (encoding ascii | utf16le | utf16be, caseSensitive default true). start = where to continue (a previous `next`); limit default 1000, max 10000. */
export interface SearchMemoryParams { pattern: string; kind?: "bytes" | "text"; encoding?: "ascii" | "utf16le" | "utf16be"; caseSensitive?: boolean; start?: Address; limit?: number }
export interface MemoryHit { address: Address; length: number; bytes: string; function?: string } // bytes: hex of the match, at most 16 bytes
export interface DataTypeHit { name: string; path: string; size: number; kind: DataTypeKind; source?: string } // source: list_data_types only // size -1 = dynamic/unsized; an empty struct has size 0
export type DataTypeKind = "struct" | "union" | "enum" | "typedef" | "pointer" | "function" | "array" | "builtin";
export interface DtSource { id: string; name: string; writable: boolean } // id "program" | "builtin"
export interface StructComponent {
  ordinal: number; offset: number; length: number;
  type: string; typePath: string;   // display name ("char[8]", "S *"), parseable by the type field; path identifies it
  name: string | null; defaultName: string; comment: string | null;
  undefined: boolean;               // undefined filler byte of an unpacked structure
  bitfield: boolean;                // not editable here
}
export interface DataTypeDetail extends DataTypeHit {
  source: string; writable: boolean; description: string;
  archive: string | null;           // non-local source archive name (.gdt / project archive), else null
  // struct | union
  packed?: boolean; packingValue?: number | null; minAlign?: number | null; alignment?: number; components?: StructComponent[];
  // enum: values sorted by value; value is a decimal string (64-bit safe)
  values?: { name: string; value: string }[];
  // typedef | pointer | array
  base?: string; basePath?: string | null; elements?: number;
  // function definition
  signature?: string;
}
/** Struct/union edit. `ordinal` indexes StructComponent.ordinal; type is a C-ish name as in define_data (fixed length only). */
export type StructOp =
  | { op: "add"; type: string; name?: string; comment?: string }                    // append (union: new member)
  | { op: "insert"; ordinal: number; type: string; name?: string; comment?: string } // later fields shift down, struct grows
  | { op: "set"; ordinal: number; type?: string; name?: string; comment?: string }   // omitted = keep, "" = clear; type required on filler
  | { op: "delete"; ordinal: number }                                                // removed, later fields shift up
  | { op: "clear"; ordinal: number }                                                 // struct: back to undefined filler, size kept; union: same as delete
  | { op: "move"; ordinal: number; to: number }                                      // packed structs and unions only
  | { op: "resize"; size: number }                                                   // unpacked structs only
  | { op: "pack"; packed: boolean; packingValue?: number; minAlign?: number };
export type EnumOp =
  | { op: "set"; name: string; value: string; oldName?: string } // add, or change value; oldName renames
  | { op: "remove"; name: string }
  | { op: "resize"; size: 1 | 2 | 4 | 8 };
export interface UndoState { canUndo: boolean; canRedo: boolean; undoName?: string; redoName?: string; dirty: boolean } // dirty = unsaved changes since open or last save

/** Coarse classification of a program change; the client refetches what it shows for these kinds. */
export type ChangeKind = "symbol" | "comment" | "function" | "data" | "code" | "type" | "bookmark" | "other";

/** What is persisted for a program in programs.json. */
export type AnalysisRecord = "none" | "partial" | "done";
/** Live state of the analysis of the open program (also the `analysis_state` notification). pct -1 = unknown (Ghidra has no global total, only the current analyzer's progress); done = analyzer starts seen so far (a poll, fast analyzers can be missed). */
export interface AnalysisState {
  state: "idle" | "running" | "done" | "cancelled" | "failed"; // idle: none running and none ran since the program was opened
  analysis: AnalysisRecord;
  profile: "full" | "fast";
  analyzer: string;
  done: number;
  pct: number;
  error?: string;               // state "failed": the run broke, or could not start (the program stays open; `analysis` is the record as written)
}

/** State of the debugger (also the `debug_state` notification). Addresses are program addresses (runtime address minus `offset`); register values stay runtime values. */
export interface DebugState {
  state: "detached" | "running" | "stopped";
  target: string;                 // "host:port" while attached
  stop: number;                   // counts the stops: a repeated state with the same number (a breakpoint toggled while stopped) is not a new stop
  offset: string;                 // runtime address = program address + offset ("0x0": a raw image loaded where it runs)
  breakpoints: Address[];         // kept while detached and installed on the next attach
  address?: Address;              // state "stopped": the program counter as a program address
  registers?: { name: string; value: string }[]; // state "stopped": the program language's names, target order, "0x" + hex of the register's width
  signal?: number;                // state "stopped": the signal when the target stopped on one other than the single-step trap (a fault)
  error?: string;                 // state "detached": why the connection ended (target exited, connection lost)
}

export interface DebugMemory { address: Address; bytes: string; items?: { offset: number; length: number; type: string; name: string; value: string }[] } // bytes: hex
/** A variable of the function at the stop. where: "stack+8" (offset from the stack at function entry), a register name, or a global's program address; value: the data type's display value; raw: "0x" + hex of the value. */
export interface DebugValue { name: string; kind: "param" | "local" | "global"; type: string; size: number; where: string; value: string; raw: string }

export interface Notifications {
  // Whenever the debug state changes (attach, every stop, continue, breakpoint toggle, detach, target exit, lost connection). The methods' results are empty: this is how a client learns the state.
  debug_state: DebugState & { sessionId: string };
  // Sent when an analysis starts, about every 250 ms while the analyzer/done/pct change, and once at the end (done/cancelled/failed).
  analysis_state: AnalysisState & { sessionId: string }; // of the program session it belongs to; a client ignores other sessions'
  // pct -1 = indeterminate (analysis: no global total exists, see protocol.md). analyzer/done/total only during analysis.
  progress: { openId: number; phase: "import" | "analysis" | "saving" | "ready"; pct: number; message: string; analyzer?: string; done?: number; total?: number };
  // ranges null = unknown/broad, refetch everything (also when a change has no address: type edits); start/end inclusive, same space, any space. Coalesced ~50 ms. Fired for edits, undo, redo and save (save: ranges [], kinds [] = nothing to refetch, only `undo.dirty` changed); about 1 s while an analysis runs, then always ranges null and all kinds; not during a blocking open_binary.
  program_changed: { sessionId: string; ranges: { start: Address; end: Address }[] | null; kinds: ChangeKind[]; undo: UndoState };
  error: { message: string };
}

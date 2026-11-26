// JSON-RPC 2.0 over WebSocket. Source of truth: protocol.md. Addresses are hex strings ("0x401000").

export type Address = string;

export interface Request<M extends keyof Methods = keyof Methods> {
  jsonrpc: "2.0";
  id: number;
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
  Busy: -32005,            // open_binary in progress (or a second open_binary)
  InvalidArgument: -32602, // bad/missing params, unparsable type or signature, invalid name
  Internal: -32603,
  MethodNotFound: -32601,
} as const;

export interface FunctionInfo {
  name: string;
  entry: Address;
  size: number;
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
  varName?: string;
  targetFunction?: Address; // set on function-name tokens of calls to a known function
}

export interface DecompileResult {
  text: string;
  tokens: Token[];
  cached: boolean;
}

export interface ListingRow {
  address: Address;
  length: number;    // code unit length in bytes; next row (if contiguous) starts at address + length
  bytes: string;     // hex, e.g. "55 48 89 e5"
  mnemonic: string;  // for data: the data type name, e.g. "db", "ds"
  operands: string;
  label?: string;
  comment?: string;
}

/** A contiguous loaded+initialized address range, ascending, non-overlapping. */
export interface AddrRange {
  start: Address;
  size: number; // bytes
}

export interface Methods {
  open_binary: { params: { path: string } & ImportOptions; result: { programId: string; name: string; persisted: boolean } };
  cancel_open: { params: {}; result: { cancelled: boolean } };
  import_candidates: { params: { path: string }; result: { candidates: ImportCandidate[] } };
  list_languages: { params: {}; result: LanguageInfo[] };
  save: { params: {}; result: {} };
  close_program: { params: {}; result: {} };
  list_programs: { params: {}; result: ProgramEntry[] };
  delete_program: { params: { programId: string }; result: {} };
  list_functions: { params: {}; result: FunctionInfo[] };
  decompile: { params: { entry: Address; timeoutSecs?: number }; result: DecompileResult };
  cancel_decompile: { params: { id: number }; result: { cancelled: boolean } };
  listing_info: { params: {}; result: { ranges: AddrRange[]; totalBytes: number } };
  listing_rows: { params: { address: Address; count: number; direction?: "forward" | "backward" }; result: ListingRow[] };
  // ---- reads ----
  get_function_at: { params: { address: Address }; result: { name: string; entry: Address; size: number; signature: string } | null };
  search_symbols: { params: { query: string; limit?: number }; result: SymbolHit[] };
  xrefs_to: { params: { address: Address; limit?: number }; result: XrefTo[] };
  xrefs_from: { params: { address: Address }; result: XrefFrom[] };
  list_strings: { params: { offset?: number; limit?: number; minLength?: number }; result: { total: number; items: StringItem[] } };
  list_data_types: { params: { query: string; limit?: number }; result: DataTypeHit[] };
  undo_state: { params: {}; result: UndoState };
  // ---- edits: one Ghidra transaction each; the transaction name is the undo label ----
  rename_symbol: { params: { address: Address; newName: string }; result: {} };
  set_comment: { params: { address: Address; kind: CommentKind; text: string }; result: {} }; // empty text clears
  create_function: { params: { address: Address; name?: string }; result: { entry: Address; name: string } };
  set_function_signature: { params: { entry: Address; signature: string }; result: {} };
  rename_variable: { params: { entry: Address; name: string; newName: string }; result: {} };
  retype_variable: { params: { entry: Address; name: string; dataType: string }; result: {} };
  undo: { params: {}; result: UndoState };
  redo: { params: {}; result: UndoState };
}

/** All optional. Omit all = Ghidra's default import (preferred LoadSpec); programId stays the plain sha256. Any field present = explicit import, programId = sha256 + "-" + 12 hex of the options hash (protocol.md). */
export interface ImportOptions {
  loader?: string;        // ImportCandidate.loader, e.g. "Raw Binary"
  language?: string;      // Ghidra LanguageID, e.g. "ARM:LE:32:v8"
  compilerSpec?: string;  // CompilerSpecID, e.g. "default"; defaults to the language's default spec
  baseAddress?: Address;  // hex "0x08000000"; only for candidates with acceptsBaseAddress
}
export interface ImportCandidate {
  loader: string;
  language: string | null;      // null = the loader needs the user to pick one (Raw Binary); see list_languages
  compilerSpec: string | null;
  preferred: boolean;           // exactly one candidate has this set when any candidate exists
  acceptsBaseAddress: boolean;
}
export interface LanguageInfo { id: string; description: string; compilerSpecs: { id: string; name: string }[] }
export interface ProgramEntry {
  programId: string;
  name: string;
  sourcePath?: string;          // path at first import; may no longer exist
  sizeBytes: number;            // size of the source file at import
  analyzed: boolean;
  lastOpened?: string;          // ISO-8601 UTC
  options: ImportOptions;       // {} = default import
}

export type CommentKind = "eol" | "pre" | "post" | "plate" | "repeatable";
export interface SymbolHit { name: string; address: Address; kind: "function" | "label" | "data" | "external" | "other" }
export interface XrefTo { from: Address; type: string; function?: string } // type: Ghidra RefType name, e.g. "UNCONDITIONAL_CALL"; function: name of function containing `from`
export interface XrefFrom { to: Address; type: string }
export interface StringItem { address: Address; value: string; length: number }
export interface DataTypeHit { name: string; path: string; size: number } // size -1 = dynamic/unsized
export interface UndoState { canUndo: boolean; canRedo: boolean; undoName?: string; redoName?: string; dirty: boolean } // dirty = unsaved changes since open or last save

/** Coarse classification of a program change; the client refetches what it shows for these kinds. */
export type ChangeKind = "symbol" | "comment" | "function" | "data" | "code" | "type" | "other";

export interface Notifications {
  // pct -1 = indeterminate (analysis: no global total exists, see protocol.md). analyzer/done/total only during analysis.
  progress: { phase: "import" | "analysis" | "saving" | "ready"; pct: number; message: string; analyzer?: string; done?: number; total?: number };
  // ranges null = unknown/broad, refetch everything; start/end inclusive. Coalesced ~50 ms. Fired for edits, undo, redo and save (save: ranges [], kinds [] = nothing to refetch, only `undo.dirty` changed); not during open_binary.
  program_changed: { ranges: { start: Address; end: Address }[] | null; kinds: ChangeKind[]; undo: UndoState };
  error: { message: string };
}

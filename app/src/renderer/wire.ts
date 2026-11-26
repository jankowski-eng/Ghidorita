import { CAPABILITIES, type Methods, type Notifications } from "../../../protocol";

type Check = (value: unknown) => boolean;
export const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const shape = (fields: Record<string, Check>): Check => {
  const entries = Object.entries(fields);
  return (x) => object(x) && entries.every(([key, check]) => check(x[key]));
};
const array = (item: Check): Check => (x) => Array.isArray(x) && x.every(item);
const optional = (check: Check): Check => (x) => x === undefined || check(x);
const nullable = (check: Check): Check => (x) => x === null || check(x);
const oneOf = (...values: string[]): Check => (x) => typeof x === "string" && values.includes(x);
const str: Check = (x) => typeof x === "string";
const nonempty: Check = (x) => typeof x === "string" && x.length > 0;
const bool: Check = (x) => typeof x === "boolean";
const number: Check = (x) => typeof x === "number" && Number.isFinite(x);
const positive: Check = (x) => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const count: Check = (x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const integer: Check = (x) => Number.isSafeInteger(x);
const address: Check = (x) => typeof x === "string" && /^(?:0x|[^:\u0000-\u001f\u007f]+::?)(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(x);
const range = shape({ start: address, end: address });
const kind = oneOf("call", "jump", "read", "write", "readwrite", "data", "flow", "other");
const labelFields = { name: str, entry: address, size: count };
const sessionFields = { sessionId: nonempty, programId: nonempty, name: nonempty };
const undo = shape({ dirty: bool, canUndo: bool, canRedo: bool, undoName: optional(str), redoName: optional(str) });
const xrefTo = array(shape({ from: address, type: str, kind, function: optional(str) }));
const callRef = { name: str, entry: nullable(address), external: bool };
const callEdge = shape({ ...callRef, thunk: bool, target: optional(shape(callRef)) });
const symbolKind = oneOf("function", "label", "data", "external", "variable", "other");
const source = oneOf("user", "analysis", "imported", "default", "other");
const typeFields = { name: str, path: str, size: integer, kind: oneOf("struct", "union", "enum", "typedef", "pointer", "function", "array", "builtin") };
const profile = nonempty;
const analysisFields = { state: oneOf("idle", "running", "done", "cancelled", "failed"), analysis: oneOf("none", "partial", "done"), profile: oneOf("full", "fast"),
  analyzer: str, done: count, pct: number, error: optional(str) };
const analysisState = shape(analysisFields);
const debugFields = { state: oneOf("detached", "running", "stopped"), target: str, stop: count, offset: nonempty, breakpoints: array(address), address: optional(address),
  registers: optional(array(shape({ name: nonempty, value: nonempty }))), signal: optional(count), error: optional(str) };
const options = shape({ loader: optional(str), language: optional(str), compilerSpec: optional(str), baseAddress: optional(address), profile: optional(profile) });
const comments = { eol: optional(str), pre: optional(str), post: optional(str), plate: optional(str), repeatable: optional(str) };
const row = shape({
  address, length: positive, bytes: str, mnemonic: str, operands: str, label: optional(str), labels: optional(array(str)),
  comment: optional(str), pre: optional(str), post: optional(str), plate: optional(str), repeatable: optional(str),
  header: optional(shape({ signature: str, convention: optional(str), params: count, paramBytes: integer, localBytes: integer, noReturn: optional(bool), thunk: optional(bool) })),
  xrefs: optional(shape({ count, items: array(shape({ from: address, kind })) })),
  parts: optional(array(shape({ offset: count, length: count, type: str, name: str, value: str }))),
  partsTotal: optional(count), bytesMore: optional(count), bookmarks: optional(array(shape({ category: str, comment: str }))),
});

export const results = {
  provider_info: shape({ version: (x) => x === 1, provider: nonempty, capabilities: array(nonempty),
    recovery: optional(shape({ snapshotIntervalSeconds: (x) => typeof x === "number" && Number.isFinite(x) && x > 0 })) }),
  active_session: nullable(shape(sessionFields)),
  open_binary: shape({ ...sessionFields, persisted: bool, analysis: optional(analysisState) }),
  close_program: object,
  cancel_open: shape({ cancelled: bool }),
  analysis_status: analysisState,
  start_analysis: analysisState,
  cancel_analysis: shape({ cancelled: bool }),
  cancel_search: shape({ cancelled: bool }),
  cancel_decompile: shape({ cancelled: bool }),
  listing_info: shape({ totalBytes: count, ranges: array(shape({ start: address, size: positive })) }),
  listing_rows: array(row),
  list_bookmarks: shape({ total: count, types: array(shape({ type: str, count })), items: array(shape({ address, type: str, category: str, comment: str })) }),
  set_bookmark: object,
  remove_bookmark: object,
  get_bytes: shape({ address, length: positive, bytes: str }),
  list_functions: array(shape({ ...labelFields, source: optional(source) })),
  get_function_at: nullable(shape({ ...labelFields, signature: str })),
  decompile: shape({ text: str, cached: bool, tokens: array(shape({
    line: count, colStart: count, colEnd: count, kind: oneOf("keyword", "type", "function", "variable", "param", "const", "comment", "label", "field", "default"),
    address: optional(address), varAddress: optional(address), varName: optional(str), targetFunction: optional(address),
  })) }),
  xrefs_to: xrefTo,
  xrefs_from: array(shape({ to: nullable(address), type: str, kind, target: oneOf("memory", "stack", "register", "external"), label: optional(str) })),
  function_calls: shape({ callers: array(callEdge), callees: array(callEdge) }),
  xrefs_to_variable: xrefTo,
  variable_uses: xrefTo,
  search_symbols: array(shape({ name: str, address, kind: symbolKind, refs: optional(count) })),
  top_symbols: array(shape({ name: str, address, kind: symbolKind, refs: count, group: oneOf("entry", "import", "function") })),
  call_graph: shape({ nodes: array(shape({ entry: address, name: str, kind: oneOf("function", "import") })), edges: array(shape({ from: address, to: address, sites: positive })), truncated: bool }),
  function_graph: shape({ blocks: array(shape({ start: address, end: address, kind: oneOf("c", "asm"), lines: array(str) })), edges: array(shape({ from: address, to: address, kind: oneOf("true", "false", "uncond") })) }),
  export_symbols: shape({ path: str, functions: count, labels: count, data: count, comments: count }),
  export_header: shape({ path: str, types: count, functions: count, skipped: count }),
  export_gzf: shape({ path: str, bytes: count }),
  list_symbols: shape({ total: count, items: array(shape({ name: str, address: nullable(address), kind: symbolKind, namespace: str, source })) }),
  list_strings: shape({ total: count, items: array(shape({ address, value: str, length: count })) }),
  search_memory: shape({ next: nullable(address), items: array(shape({ address, length: positive, bytes: str, function: optional(str) })) }),
  list_data_types: array(shape({ ...typeFields, source: optional(str) })),
  dt_sources: array(shape({ id: str, name: str, writable: bool })),
  dt_children: shape({ categories: array(shape({ name: str, path: str })), types: array(shape(typeFields)) }),
  get_data_type: shape({ ...typeFields, source: str, writable: bool, description: str, archive: nullable(str), packed: optional(bool),
    packingValue: optional(nullable(integer)), minAlign: optional(nullable(integer)), alignment: optional(integer),
    components: optional(array(shape({ ordinal: count, offset: count, length: count, type: str, typePath: str, name: nullable(str),
      defaultName: str, comment: nullable(str), undefined: bool, bitfield: bool }))),
    values: optional(array(shape({ name: str, value: str }))), base: optional(str), basePath: optional(nullable(str)), elements: optional(count), signature: optional(str),
  }),
  get_comments: shape(comments),
  rename_symbol: object,
  create_label: object,
  set_comment: object,
  create_function: shape({ entry: address, name: str }),
  set_function_signature: object,
  rename_variable: object,
  retype_variable: object,
  define_data: object,
  clear_code: object,
  create_struct_from_data: shape({ path: str }),
  auto_create_structure: shape({ path: str }),
  create_data_type: shape({ path: str }),
  delete_data_type: object,
  rename_data_type: shape({ path: str }),
  edit_struct: object,
  edit_enum: object,
  debug_attach: object, debug_detach: object, debug_breakpoint: object, debug_continue: object, debug_step: object, debug_pause: object, debug_status: shape(debugFields),
  debug_memory: shape({ address, bytes: str, items: optional(array(shape({ offset: count, length: positive, type: str, name: str, value: str }))) }),
  debug_values: shape({ pc: nullable(address), items: array(shape({ name: nonempty, kind: oneOf("param", "local", "global"), type: str, size: positive, where: str, value: str, raw: str })) }),
  undo_state: undo,
  undo,
  redo: undo,
  save: shape({ saved: bool, undoHistoryCleared: bool }),
  load_coverage: shape({ ranges: array(range) }),
  list_programs: array(shape({ programId: nonempty, name: str, sourcePath: optional(str), sizeBytes: count, analyzed: bool, analysis: optional(oneOf("none", "partial", "done")), analysisProfile: optional(oneOf("full", "fast")), lastOpened: optional(str), options })),
  delete_program: object,
  import_candidates: shape({ candidates: array(shape({ loader: str, language: nullable(str), compilerSpec: nullable(str), preferred: bool, acceptsBaseAddress: bool, requiresLanguage: optional(bool) })),
    sizeBytes: count, entropy: array(number), note: optional(str), profiles: optional(array(shape({ id: profile, label: str }))), defaultProfile: optional(profile),
  }),
  list_languages: array(shape({ id: str, description: str, compilerSpecs: array(shape({ id: str, name: str })) })),
} satisfies Record<keyof Methods, Check>;

export const notifications = {
  progress: shape({ openId: positive, phase: oneOf("import", "analysis", "saving", "ready"), pct: number, message: str, analyzer: optional(str), done: optional(count), total: optional(count) }),
  program_changed: shape({ sessionId: nonempty, ranges: nullable(array(range)), undo,
    kinds: array(oneOf("symbol", "comment", "function", "data", "code", "type", "bookmark", "other")),
  }),
  analysis_state: shape({ sessionId: nonempty, ...analysisFields }),
  debug_state: shape({ sessionId: nonempty, ...debugFields }),
  error: shape({ message: str }),
} satisfies Record<keyof Notifications, Check>;

export const knownCapabilities = (values: string[]) => new Set(CAPABILITIES.filter((value) => values.includes(value)));

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
  bytes: string;     // hex, e.g. "55 48 89 e5"
  mnemonic: string;  // for data: the data type name, e.g. "db", "ds"
  operands: string;
  label?: string;
  comment?: string;
}

export interface Methods {
  open_binary: { params: { path: string }; result: { programId: string; name: string } };
  list_functions: { params: {}; result: FunctionInfo[] };
  decompile: { params: { entry: Address; timeoutSecs?: number }; result: DecompileResult };
  cancel_decompile: { params: {}; result: { cancelled: boolean } };
  listing_info: { params: {}; result: { rowCount: number } };
  listing_rows: { params: { startIndex: number; count: number }; result: ListingRow[] };
  address_to_row: { params: { address: Address }; result: { index: number } };
  row_to_address: { params: { index: number }; result: { address: Address } };
}

export interface Notifications {
  progress: { phase: "import" | "analysis" | "index" | "ready"; pct: number; message: string };
  error: { message: string };
}

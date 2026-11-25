# Protocol (spike)

JSON-RPC 2.0 over WebSocket, text frames, one JSON object per frame. Types: `protocol.ts` (authoritative for shapes).

## Process contract
- Electron spawns `python sidecar/main.py`; the sidecar binds `127.0.0.1` on an ephemeral port and prints the port as the **first stdout line** (just the integer). Everything else goes to stderr.
- The sidecar exits when stdin closes (Electron died) or on SIGTERM. One client at a time.
- Addresses are hex strings, `"0x401000"` (lowercase). Row indexes are 0-based ints.

## Requests (client → server; replies are standard JSON-RPC results)
| method | params | result |
|---|---|---|
| `open_binary` | `{path}` | `{programId, name}`. Imports, runs auto-analysis, builds the listing index; emits `progress` notifications; replies when done. |
| `list_functions` | `{}` | `[{name, entry, size}]` sorted by entry |
| `decompile` | `{entry, timeoutSecs?=30}` | `{text, tokens[], cached}` |
| `cancel_decompile` | `{}` | `{cancelled}` — aborts the in-flight decompile; that request fails with `Cancelled` |
| `listing_info` | `{}` | `{rowCount}` |
| `listing_rows` | `{startIndex, count}` | `[{address, bytes, mnemonic, operands, label?, comment?}]`, clamped to rowCount |
| `address_to_row` | `{address}` | `{index}` — row of the code unit containing the address |
| `row_to_address` | `{index}` | `{address}` |

A "row" is one code unit (instruction, defined data, or one undefined byte) in address order, memory gaps skipped.

## Tokens
`line` is 0-based into `text.split("\n")`. `colStart/colEnd` index into that line (indent included). `kind` follows Clang syntax types. `targetFunction` is set on call-target name tokens when the callee entry is known (thunks are followed to the entry of the called function symbol itself, not resolved).

## Notifications (server → client, no id)
- `progress {phase, pct, message}` — phase ∈ import|analysis|index|ready, pct 0–100 (analysis pct is indeterminate: -1 allowed).
- `error {message}` — non-fatal, out-of-band.

## Errors
Standard JSON-RPC error object. Codes in `protocol.ts` `ErrorCode`: NoProgram -32001, Cancelled -32002, Timeout -32003, NotFound -32004.

## Concurrency
All Program access happens on one sidecar worker thread; requests are queued in arrival order. `cancel_decompile` bypasses the queue.

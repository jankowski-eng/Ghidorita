# Protocol (spike)

JSON-RPC 2.0 over WebSocket, text frames, one JSON object per frame. Types: `protocol.ts` (authoritative for shapes).

## Process contract
- Electron spawns `python sidecar/main.py`; the sidecar binds `127.0.0.1` on an ephemeral port and prints the port as the **first stdout line** (just the integer). Everything else goes to stderr.
- The sidecar exits when stdin closes (Electron died) or on SIGTERM. One client at a time.
- Addresses are hex strings, `"0x401000"` (lowercase). There are no row indexes: the listing is addressed by address only.

## Requests (client → server; replies are standard JSON-RPC results)
| method | params | result |
|---|---|---|
| `open_binary` | `{path}` | `{programId, name}`. Imports (or reopens the persisted analyzed program), runs auto-analysis if needed; emits `progress` notifications; replies when done. |
| `list_functions` | `{}` | `[{name, entry, size}]` sorted by entry |
| `decompile` | `{entry, timeoutSecs?=30}` | `{text, tokens[], cached}` |
| `cancel_decompile` | `{id}` | `{cancelled}` — cancels the `decompile` request with that JSON-RPC id, whether still queued or running; that request fails with `Cancelled`. `false` if the id is unknown or already finished. |
| `listing_info` | `{}` | `{ranges:[{start,size}], totalBytes}` — the loaded+initialized address set (ascending, bytes). The client maps scroll position ↔ address by cumulative range size (see `app/src/renderer/addrmap.ts`). |
| `listing_rows` | `{address, count, direction?="forward"}` | `[{address, length, bytes, mnemonic, operands, label?, comment?}]` |

`listing_rows` walks code units from an anchor, no index. `forward`: starts at the code unit containing `address` (or the next one if `address` is in a gap) and goes up. `backward`: the `count` code units strictly before the one containing `address`, returned in ascending order. Both are restricted to the loaded+initialized set; fewer than `count` rows means the end (or start) was reached. `count` is capped at 1000. A row is one code unit (instruction, defined data, or one undefined byte); `bytes` shows at most 16 bytes. The client may render `label` on its own line above the row.

## Tokens
`line` is 0-based into `text.split("\n")`. `colStart/colEnd` index into that line (indent included). `kind` follows Clang syntax types. `targetFunction` is set on call-target name tokens when the callee entry is known (thunks are followed to the entry of the called function symbol itself, not resolved).

## Notifications (server → client, no id)
- `progress {phase, pct, message}` — phase ∈ import|analysis|ready, pct 0–100 (analysis pct is indeterminate: -1 allowed).
- `error {message}` — non-fatal, out-of-band.

## Errors
Standard JSON-RPC error object. Codes in `protocol.ts` `ErrorCode`: NoProgram -32001, Cancelled -32002, Timeout -32003, NotFound -32004.

## Concurrency
Two sidecar threads. Thread R (open_binary, list_functions, listing_*) and thread D (decompile; owns the `DecompInterface` and the result cache). A slow decompile never delays listing fetches; requests on one thread run in arrival order. `cancel_decompile` is handled on the event loop and bypasses both queues. `open_binary` is not cancellable and, while it runs, blocks other R requests (decompiles requested meanwhile fail with NoProgram or hit the old program: do not issue them).

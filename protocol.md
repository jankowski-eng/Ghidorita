# Protocol (spike)

JSON-RPC 2.0 over WebSocket, text frames, one JSON object per frame. Types: `protocol.ts` (authoritative for shapes).

## Process contract
- Electron spawns `python sidecar/main.py`; the sidecar binds `127.0.0.1` on an ephemeral port and prints the port as the **first stdout line** (just the integer). Everything else goes to stderr.
- The sidecar exits when stdin closes (Electron died) or on SIGTERM. **Before exiting it saves unsaved edits** (and never exits while a save is running; log lines on stderr give the duration). One client at a time.
- Shutdown contract for clients: call `save` first (to show progress), then close stdin (or SIGTERM), and give the process a long grace (tens of seconds) before SIGKILL: a SIGKILL loses everything not yet saved (see Persistence and crash safety).
- Addresses are hex strings, `"0x401000"` (lowercase). There are no row indexes: the listing is addressed by address only.

## Requests (client → server; replies are standard JSON-RPC results)
Params/results are in `protocol.ts`; all addresses are lowercase hex strings. Missing or malformed params fail with `InvalidArgument` (-32602). Every method except `open_binary`, `cancel_open`, `cancel_decompile`, `import_candidates`, `list_languages`, `list_programs`, `delete_program` and `close_program` fails with `NoProgram` until a program is open (and while an open is in progress).

### Open / decompile / listing
| method | params | result | semantics / errors |
|---|---|---|---|
| `open_binary` | `{path, loader?, language?, compilerSpec?, baseAddress?}` | `{programId, name, persisted}` | Options: see *Import options* below; all omitted = default import. `programId` is the file's sha256 (default import) or `sha256-<12 hex>` (explicit options); the analyzed program is stored in a Ghidra project (`$SIDECAR_PROJECTS_DIR`, default `~/Library/Application Support/ghidra-desktop-spike/projects`); `persisted` is true when loaded from there without re-analysis. Otherwise imports, analyzes, saves; emits `progress`; replies when done. `Busy` if another open is running; `Cancelled` after `cancel_open`. |
| `cancel_open` | `{}` | `{cancelled}` | Cancels the running `open_binary` (it fails with `Cancelled`, nothing is saved). `false` if no open is running. |
| `list_functions` | `{}` | `[{name, entry, size}]` | Sorted by entry. |
| `decompile` | `{entry, timeoutSecs?=30}` | `{text, tokens[], cached}` | `NotFound` if no function at `entry`; `Timeout`; `Cancelled`. |
| `cancel_decompile` | `{id}` | `{cancelled}` | Cancels the `decompile` request with that JSON-RPC id, queued or running; that request fails with `Cancelled`. `false` if unknown or finished. |
| `listing_info` | `{}` | `{ranges:[{start,size}], totalBytes}` | The loaded+initialized address set (ascending, bytes). The client maps scroll position ↔ address by cumulative range size (see `app/src/renderer/addrmap.ts`). |
| `listing_rows` | `{address, count, direction?="forward"}` | `[{address, length, bytes, mnemonic, operands, label?, comment?}]` | See below. |

### Import, save, close, project
| method | params | result | semantics / errors |
|---|---|---|---|
| `import_candidates` | `{path}` | `{candidates:[{loader, language, compilerSpec, preferred, acceptsBaseAddress}]}` | The LoadSpecs Ghidra offers for the file (from PyGhidra's `ProgramLoader`/loader `findSupportedLoadSpecs`, not reimplemented). Exactly one `preferred` when non-empty (Ghidra's preferred spec). `language`/`compilerSpec` are `null` when the loader needs the user to choose (Raw Binary). Empty list = nothing recognises the file (only Raw Binary would; `loader: "Raw Binary"` is always valid in `open_binary`). "Raw Binary" appears once (language/compilerSpec `null`, `acceptsBaseAddress` true, never preferred) next to the recognising loaders. Needs no program, fails `Busy` while an open runs, `NotFound` if the file is missing. |
| `list_languages` | `{}` | `[{id, description, compilerSpecs:[{id,name}]}]` | All installed Ghidra languages; feeds the language picker for `language: null` candidates. Needs no program. |
| `close_program` | `{}` | `{}` | Saves unsaved changes (autosave, see Persistence), then releases the program. In-flight and queued `decompile`s fail with `Cancelled`; later program requests fail `NoProgram`. Idempotent: succeeds with no program. `Busy` while an open is in progress (use `cancel_open`). |
| `list_programs` | `{}` | `[{programId, name, sourcePath?, sizeBytes, analyzed, lastOpened?, options}]` | Programs stored in the project, newest `lastOpened` first. `options` is `{}` for default imports. Needs no program (works while one is open); `Busy` while an open runs. |
| `delete_program` | `{programId}` | `{}` | Removes the program from the project. `Busy` if it is the open program (or an open is running), `NotFound` if unknown. |

### Import options
- `open_binary` options are all optional: `loader` (a candidate's loader name), `language` (LanguageID), `compilerSpec` (default: language's default), `baseAddress` (hex string, `0x…`, must fit the address space; only valid if the chosen candidate has `acceptsBaseAddress`). Unknown loader/language/compilerSpec or a malformed/out-of-range base address → `InvalidArgument`.
- **Persistence key.** No options → `programId = sha256(file)`, the project file is named by it: unchanged, so existing projects still load. Any option present → `programId = sha256(file) + "-" + hex(sha256(canonical)[:6])`, where `canonical` = JSON of `{"loader","language","compilerSpec","baseAddress"}` (compact separators `,` `:`, keys in that order, absent = `null`, `baseAddress` normalised to lowercase `0x…` without leading zeros). The same file with different options never collides with the default import or with each other. When the sidecar runs with `SIDECAR_ANALYSIS_DISABLE` (analyzers switched off for first-open analysis), `canonical` gets a fifth key `"analysisDisable"` (the sorted analyzer names) and counts as an option, so a reduced analysis never shares a key with a full one. Passing the preferred spec explicitly is a different key from the default (the UI omits options for the default path). Opening with options whose key is already persisted loads it without re-analysis.

### Reads
| method | params | result | semantics / errors |
|---|---|---|---|
| `get_function_at` | `{address}` | `{name, entry, size, signature} \| null` | Function containing `address`; `null` if none. |
| `search_symbols` | `{query, limit?=100}` | `[{name, address, kind}]` | Case-insensitive substring match on symbol names. `kind` ∈ function\|label\|data\|external\|other. |
| `xrefs_to` | `{address, limit?=100}` | `[{from, type, function?}]` | References to `address`. `type` is the Ghidra RefType name (e.g. `UNCONDITIONAL_CALL`); `function` names the function containing `from`. |
| `xrefs_from` | `{address}` | `[{to, type}]` | References from the instruction at `address`. |
| `list_strings` | `{offset?=0, limit?=100, minLength?=4}` | `{total, items:[{address, value, length}]}` | Defined strings; `total` counts all matches (after `minLength`), `items` is the page. |
| `list_data_types` | `{query, limit?=50}` | `[{name, path, size}]` | Substring match on data type names; `size` -1 = dynamic/unsized. |
| `undo_state` | `{}` | `{canUndo, canRedo, undoName?, redoName?, dirty}` | Current undo/redo availability and labels; `dirty` = unsaved changes since open or the last `save` (Ghidra `Program.isChanged()`). Undoing back to the saved state makes it clean again (measured: Ghidra tracks this). |

### Edits
Each edit is one Ghidra transaction, named as the undo label (e.g. "Rename symbol"), runs on thread R, and fires `program_changed`. Result `{}` unless noted.
| method | params | result | semantics / errors |
|---|---|---|---|
| `rename_symbol` | `{address, newName}` | `{}` | Renames the function or label at `address`. `NotFound` if there is none; `InvalidArgument` for an invalid or duplicate name. |
| `set_comment` | `{address, kind, text}` | `{}` | `kind` ∈ eol\|pre\|post\|plate\|repeatable. Empty `text` clears the comment. |
| `create_function` | `{address, name?}` | `{entry, name}` | Creates a function at `address` (default name if omitted). `InvalidArgument` if one can't be created there or the name is invalid/duplicate. |
| `set_function_signature` | `{entry, signature}` | `{}` | `signature` is a C prototype, e.g. `int foo(int a, char *b)`. `NotFound` if no function at `entry`; `InvalidArgument` if unparsable. |
| `rename_variable` | `{entry, name, newName}` | `{}` | Renames a decompiler local/param by name. `NotFound` if function or variable is missing; `InvalidArgument` for an invalid/duplicate name. |
| `retype_variable` | `{entry, name, dataType}` | `{}` | Retypes a decompiler local/param. Only fixed-length types are accepted; `InvalidArgument` for an unknown, unparsable or dynamic-size type. |
| `define_data` | `{address, dataType}` | `{}` | One transaction "Define data": Ghidra `CreateDataCmd` with force (clears conflicting *data*, never instructions). `dataType` is a name or path as in `retype_variable` plus arrays/pointers (`int`, `char[4]`, `char *`, `dword`, `/dword`). `InvalidArgument`: unknown/unparsable type, dynamic or zero-size type (e.g. `string`, `void`), address not in memory, an instruction in the way, no room. A failure rolls back (nothing on the undo stack). Fires `program_changed` kinds `data`, `code` with the data's range. |
| `clear_code` | `{address, length?}` | `{}` | One transaction "Clear code": Ghidra `ClearCmd` (instructions and data; not symbols/comments) over `[address, address+length-1]`, default the code unit containing `address`. Like the listing's "Clear Code Bytes", units overlapping the range are cleared whole. `InvalidArgument`: address not in memory, `length` < 1, or nothing but undefined bytes in the range (nothing would change). Fires `program_changed` kinds `code`, `data`. |
| `save` | `{}` | `{saved}` | Writes the program to the project. `saved=false` if nothing had changed. Runs on thread R; safe while decompiles run. **Ghidra drops the undo/redo history on save**; a saving call also fires `program_changed {ranges: [], kinds: [], undo}` (nothing to refetch, `undo` is the new state with `dirty=false`). |
| `undo` | `{}` | `UndoState` | Undoes the last edit. `InvalidArgument` if nothing to undo. |
| `redo` | `{}` | `UndoState` | Redoes the last undone edit. `InvalidArgument` if nothing to redo. |

`listing_rows` walks code units from an anchor, no index. `forward`: starts at the code unit containing `address` (or the next one if `address` is in a gap) and goes up. `backward`: the `count` code units strictly before the one containing `address`, returned in ascending order. Both are restricted to the loaded+initialized set; fewer than `count` rows means the end (or start) was reached. `count` is capped at 1000. A row is one code unit (instruction, defined data, or one undefined byte); `bytes` shows at most 16 bytes. The client may render `label` on its own line above the row.

## Tokens
`line` is 0-based into `text.split("\n")`. `colStart/colEnd` index into that line (indent included). `kind` follows Clang syntax types. `targetFunction` is set on call-target name tokens when the callee entry is known (thunks are followed to the entry of the called function symbol itself, not resolved).

## Notifications (server → client, no id)
- `progress {phase, pct, message, analyzer?, done?, total?}` — phase order: `import` → `analysis` → `saving` → `ready` (only while `open_binary` runs; a persisted program goes straight to `ready`). `pct` is 0–100 or -1 (indeterminate). During `analysis` `pct` is -1 because Ghidra's AutoAnalysisManager has no global total; `analyzer` is the current analyzer name; `pct` is the per-analyzer progress/max when that analyzer reports a maximum (else -1); `done` is the number of analyzer runs finished so far; `total` is omitted.
- `program_changed {ranges, kinds, undo}` — the program was modified. `ranges` is `[{start,end}]` (Ghidra address ranges, `end` inclusive) or `null` = unknown/broad, refetch everything. `kinds` ⊆ symbol|comment|function|data|code|type|other tells the client what to refetch. `undo` is the new `UndoState` (including `dirty`). Coalesced over ~50 ms (ranges merged, kinds unioned). Fired for edits, for `undo`/`redo` (which send `ranges: null`) and for `save` (`ranges: []`, `kinds: []`: only `dirty` changed, nothing to refetch); never during `open_binary`.
- `error {message}` — non-fatal, out-of-band.

## Errors
Standard JSON-RPC error object. Codes in `protocol.ts` `ErrorCode`: NoProgram -32001, Cancelled -32002, Timeout -32003, NotFound -32004, Busy -32005 (open in progress / second `open_binary`), InvalidArgument -32602, MethodNotFound -32601, Internal -32603.

## Concurrency
- **Thread R** (the event loop dispatches to it) handles all program reads (`list_functions`, `listing_*`, xrefs, search, strings, ...) and ALL writes, `undo` and `redo`, in arrival order.
- `save`, `close_program` run on R like edits (in order); `import_candidates`, `list_languages`, `list_programs`, `delete_program` also run on R (they touch the project or loaders only when no open is running, hence `Busy` during an open; `close_program` waits for running decompiles to be cancelled as in `_close`). `open_binary` on top of an open program discards its unsaved changes.
- **Thread O** runs `open_binary` (import + analysis + save). While an open is in progress, R requests and `decompile` fail fast with `NoProgram`, and a second `open_binary` fails with `Busy`.
- `cancel_open` is handled on the event loop (bypasses the queues): it cancels the TaskMonitor, `open_binary` fails with `Cancelled`, nothing is saved to the project, and the sidecar stays usable.
- **Decompiler pool**: N threads (env `SIDECAR_DECOMP_WORKERS`, default 2), each owning its own `DecompInterface` and all sharing one queue. A slow decompile never delays listing fetches. `cancel_decompile` (event loop, bypasses queues) works by request id for queued and running requests.
- **Decompile cache**: shared and thread-safe, keyed by function entry, invalidated on `program_changed` (functions overlapping the changed ranges; `ranges` null or kind `type` clears everything), so results are never stale (`cached` is false after an invalidating edit).
- `rename_variable` / `retype_variable` run entirely on thread R with a short-lived `DecompInterface`, so no edit can interleave between obtaining the `HighFunction` and committing the change.

## Persistence and crash safety
- Edits live only in Ghidra's in-memory buffers until saved. The sidecar saves (1) on explicit `save`, (2) automatically when a program is closed (`close_program`, or `open_binary` replacing it), (3) on shutdown (stdin EOF, SIGTERM). There is no discard prompt: unsaved edits are always written. Shutdown waits for a running save (a save lock) and for the close-save on thread R before `os._exit`; it logs `close save took ...` / `shutdown: close finished in ...` on stderr. Saving needs no open transaction (edits end theirs) and works while a decompile runs.
- Dirty: `UndoState.dirty` is `program.isChanged()`. A freshly imported, analyzed and saved program is clean. Undoing back to the last save point is clean again; redo is dirty. Ghidra clears the undo/redo stacks on save.
- Atomic: saving an already persisted program is crash-safe (BufferMgr writes a copy `tmp*.ps`, fsyncs, then renames it to the next `db.N+1.gbf`); killed before the rename = the old version is intact.
- Lost on SIGKILL / power loss: every edit since the last save. Ghidra has no autosave; the GUI's recovery snapshots are not used here (`consume_program` passes okToRecover=false). Not implemented: periodic recovery snapshots.
- Not atomic: the first save of a newly imported program (`createDatabase`). A kill mid-save can leave a registered project item with a partial `db.1.gbf` that fails to open. `open_binary` handles this: if opening the persisted item fails, the item is deleted and the binary is imported and analyzed again (`persisted: false`) instead of failing forever.
- **Measured** (`test_raw_import_options_save_reopen_dirty_undo`): saving a changed program clears both the undo and the redo stack, so the client treats save as an undo barrier; `save` on a clean program does nothing and keeps the redo stack.

## Auth
`SIDECAR_TOKEN` is mandatory: the sidecar exits with status 2 and a stderr message when it is unset or empty, unless `SIDECAR_ALLOW_NO_AUTH=1` is set (test-only escape hatch). The WebSocket path is `/<token>`; the mock server ignores the token.

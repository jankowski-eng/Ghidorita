# Sidecar architecture

The wire contract is `../protocol.md` / `../protocol.ts` (read "Process contract", "Discovery and sessions", "Concurrency", "Errors", "Persistence"); this sidecar is the PyGhidra implementation of it, and `../PROVIDERS.md` explains how to add another. This page is the code layout.
`sidecar/main.py` stays the entry point (Electron, the tests and `bench/*.py` spawn it): environment checks, JVM launch, `App()`, serve.

## Layout

```
sidecar/
  main.py              entry point only: token check, JVM (max_heap, headless), build App, serve, stdin/SIGTERM -> shutdown
  ghidrette/
    app.py             wiring: builds Ctx, Project, Program and DOMAINS, registers their RPCs, sets the shutdown hooks
    core/              runtime, no Ghidra API except Opening.monitor / Events listener / Session.edit
      errors.py        RpcError, error codes, INVALID_JAVA, java_error(), log()
      args.py          hx, lim, text_arg, name_arg
      lanes.py         Job, Scan, Opening, Worker; Lanes = the queues and threads, run(), on_r(), scanning(), cancel()
      session.py       Session = the open program: program, epoch, program_id, session_id (fresh per open, via publish()), undo snapshot, need(), addr(), edit(), cmd(), function()
      events.py        Events = DomainObjectListener, coalescing -> program_changed, subscribe(fn(kinds, ranges, broad)), record(), reset()
      context.py       Ctx = the object every domain gets (below)
      rpc.py           @rpc(lane=...), Registry, Dispatcher (the rules formerly in handle())
      server.py        Server: websocket conn(), one-client rule, auth guard, serve(), shutdown()
    domains/           one module per feature area; each is a class taking ctx, with @rpc methods
      project.py       Ghidra project, programs.json, list_programs, delete_program, list_languages, import_candidates, program_key
      program.py       provider_info, active_session, open_binary (import/analyze/profile; the swap commits on R and returns the new session), cancel_open, close_program, save, undo, redo, undo_state
      listing.py       listing_info, listing_rows, list_functions, get_function_at, get_comments
      decompile.py     decompile and variable_uses (pool, one cache keyed by (space, entry) [+ "uses"]), tokens (varAddress on globals), cancel_decompile, decompile_for_edit()
      edits.py         rename_symbol, create_label, set_comment, create_function, set_function_signature, define_data, clear_code
      highvars.py      rename_variable, retype_variable, auto_create_structure
      search.py        search_symbols, list_symbols, list_strings, search_memory, cancel_search, snapshot cache
      layout.py        file_layout(): entry point and sections from ELF/PE/Mach-O headers, shannon() (used by import_candidates)
      xrefs.py         xrefs_to, xrefs_to_variable, xrefs_from
      datatypes.py     list_data_types and the data-type-manager RPCs
  test_*.py, testlib.py, conftest.py    tests: one file per domain, black box over WebSocket against real Ghidra on /bin/ls
```

## Lanes and threads

A method declares where it runs: `@rpc(lane=...)`. The dispatcher (`core/rpc.py`) owns the rules; a method never queues itself.

| lane | thread | notes |
|---|---|---|
| `R` | R, one thread, queue `lanes.jobs` | all reads that are not slow and ALL writes (edits, undo/redo, save, close). NoProgram "open_binary in progress" fail-fast during an open |
| `edit` | S pool, then R | variable edits decompile and infer structure fields on S, then queue the write on R. A `Job` is registered under the request id and can be cancelled with `cancel_decompile`. Structure inference shares a deadline across the initial decompile, direct callees, and pointer tracing. The commit checks program epoch and write revision |
| `scan` | S pool (`SIDECAR_SCAN_WORKERS`, default 2), queue `lanes.sjobs` | symbol table, strings, memory search, `list_data_types`. Gets `scan=` (unique id, cancellable via `cancel_search`). Never on R, so a scan cannot delay listing fetches |
| `decomp` | D pool (`SIDECAR_DECOMP_WORKERS`, default 2), queue `lanes.djobs` | `decompile` only. Each worker owns one `DecompInterface`, created, used and disposed on its own thread (disposed when the program epoch moves on). Gets `job=` (unique id) |
| `file` | asyncio file thread | `load_coverage` parses its file without occupying R and checks the program epoch before returning |
| `project` | R | `Busy` instead of NoProgram during an open; `busy_ok=True` (`list_languages`) is answered anyway |
| `loop` | the asyncio loop | `cancel_*`: quick, only flip flags |
| `open` | O, one thread per `open_binary`, at most one at a time (`lanes.opening`) | validate, load or import the replacement, then call back onto R with `lanes.on_r()` to save and swap the current program |

One more thread: the recovery snapshot loop (`program.py`, every `SIDECAR_SNAPSHOT_SECS`) only sleeps; the snapshot itself runs on R via `lanes.on_r()` and preserves undo history. The three worker queues are bounded at 128 items each. A connection admits at most 64 outstanding requests and a 2 MiB message; disconnect cancels queued requests and cancellable work.

Locks: `session.lock` guards the program swap (`program`, `epoch`) together with `lanes.running` / `lanes.active`; `lanes.mon_lock` the
`Job`/`Scan` monitor hand-over; `project.lock` is held by thread O for a whole open and briefly by R for list/delete/candidates, so they
never run concurrently; `session.save_lock` is held during every save and shutdown never exits while it is held. The "why" comments
(epoch check before a pool worker touches the program, dispose on the owning thread, never release a program under a live reader) stay next to the code.

Duplicate method names raise at startup (`Registry.register`). `test_methods.py` pins the method table and every lane to a golden dict and
checks that every method in `protocol.ts` is registered.

## The context object

`ctx` (`core/context.py`) is the only thing a domain gets: `ctx.session`, `ctx.lanes`, `ctx.events`, `ctx.project`, `ctx.notify()`,
`ctx.progress()`, `ctx.loop`, `ctx.shutdown_hooks`. A domain keeps `self.ctx` and `self.ses = ctx.session`. Domains never touch each
other's attributes.

## Events and invalidation

`Events` owns the Ghidra listener (it runs on Ghidra's event thread, only copies data, never touches the DB), coalesces changes for 50 ms
and emits `program_changed`. Everything derived from the program subscribes: `ctx.events.subscribe(fn(kinds, ranges, broad))`.
`fn` runs on whatever thread caused the change and must be quick and thread-safe. Today: the decompile cache (`decompile.py`: comment/code
changes invalidate by range, anything else clears) and the snapshot cache behind symbols/strings (`search.py`: cleared on every change).
`events.record(kinds, ranges)` is how an edit that knows its range announces it (define_data, clear_code, create_struct_from_data);
`events.reset()` is the program swap/close: every subscriber gets a broad invalidation, nothing is announced. It advances a generation so old listener callbacks and coalescing timers are ignored. The listener itself is
attached with `events.attach(prog)` after the initial analysis and removed with `events.detach(prog)`.

## Cross-domain edges

Everything a domain shares goes through `ctx`. The only direct calls between domain modules:

1. `highvars` -> `decompile.decompile_for_edit(ctx, prog, func, timeoutSecs, job, timed=False)`: a context manager that decompiles on the calling scan worker
   and yields the `HighFunction`, short-lived `DecompInterface`, and task monitor. Structure inference reuses the interface and timed monitor.
   R commits only if the write revision and program still match.
2. `program` -> `project`: `ctx.project` (Ghidra project, `lock`, `meta_touch`) and the persistence-key helpers `project.program_key`,
   `analysis_disabled`, `FAST_PROFILE`, `RAW`, which belong to the key format in protocol.md "Persistence".

Shared helpers that are not edges live in `core`: `session.edit()` (one transaction, flushes events), `session.cmd()`, `session.function()`,
`args.name_arg()`.

## How to add an RPC

Example: `get_bytes {address, length}` on the listing domain.

1. `ghidrette/domains/listing.py`: add a method with `@rpc(lane="R")` (or `scan` / `decomp` / `project` / `loop` / `R, job=True`). The function name is the RPC name; parameters are the JSON params (`TypeError` from a wrong shape becomes InvalidArgument). Validate with `core/args.py`, raise `RpcError(code, msg)`, use `self.ses.need()` / `self.ses.addr()`; an edit goes through `self.ses.edit(name, fn)`.
2. `../protocol.md`: the method, params, result, errors, lane. `../protocol.ts`: the line in `Methods`.
3. The mock (`../app/mock/`): the method, so `MOCK=1` and the renderer tests keep working.
4. `test_methods.py`: one line in `GOLDEN` (the test fails until you add it, that is the point).
5. `test_listing.py`: a test over WebSocket (`testlib.Client`); fixture `env` is one analyzed `/bin/ls`.

A new domain module is the same, plus one import and one entry in `DOMAINS` in `ghidrette/app.py`.

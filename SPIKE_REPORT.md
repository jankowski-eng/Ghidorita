# Spike report (round 2)

Question: does the listing + decompiler UI hold up on a real-size binary?
**Verdict: GO on the listing design, with a caveat on scale.** Measured on a 6.95 MB binary (`mysqldump`, arm64, 1,891 functions). The design has no per-row index, so latency should not depend on binary size, but I have **not** run a 50 MB+ binary this round. The 66 MB `llvm-exegesis` was not retried (analysis ran >16 min last round). First-open analysis time and memory are now the main unknown.

## What changed
1. **Autotest no longer passes trivially.** Confirmed first: the old run clicked `FUN_100000718` and "navigated" to `0x100000718`, itself (signature name token had a `targetFunction`). Now `targetFunction` is set only on tokens with a CALL p-code op, and the autotest picks a call whose target differs from the current function and asserts selection changed and the listing's top row is the callee entry (start `FUN_100000718` -> `0x100004383`, passes on `/bin/ls`; also on the mock).
2. **Address-based listing, no index.** `listing_info` returns the loaded+initialized ranges; the renderer maps scroll position to address by cumulative range size (`app/src/renderer/addrmap.ts`, unit-tested with `npm test`) over a fixed 10M px scrollbar. Rows come from `listing_rows {address, count, direction}` walking `getCodeUnits(view, forward)` from an anchor, forward and backward. `address_to_row`/`row_to_address`, the index build and the "index" phase are gone. Wheel scrolls by lines inside a contiguous row buffer (max 1,500 rows); dragging the scrollbar jumps by fraction. Labels render on their own line above the instruction. Protocol, mock server and `test_smoke.py` updated.
3. **Decompile has its own thread** (owns its `DecompInterface` and cache). Listing/function reads stay on the other thread. `cancel_decompile {id}` targets a request id and works for queued and running requests (tested: cancel while running, cancel while queued behind another decompile, unknown id -> `false`).
4. **Analysis persists** in a Ghidra project (`$SIDECAR_PROJECTS_DIR`, Electron passes `<userData>/projects`), program named by file sha256. Reopen loads it without re-analysis. Note: `pyghidra.open_project` hangs here (GUI tool chest initialises AppKit off the main thread), so the sidecar uses `GhidraProject` and starts the JVM with `-Djava.awt.headless=true`.
5. **Shutdown**: Electron closes stdin + SIGTERM and SIGKILLs only after 3 s; the sidecar cancels in-flight decompiles, then disposes the decompiler on its owning thread. Checked with pgrep: after SIGTERM to Electron and after `kill -9` of Electron (both while a native `decompile` child existed) 0 sidecar and 0 `decompile` processes remained after 5 s. Normal GUI quit via `before-quit` was **not** exercised by a real window close (autotest exit and SIGTERM paths were).
6. **Measured** on a mid-size binary (below).

## Measurements: `mysqldump` (6.95 MB, 2 ranges, 6,954,352 loaded bytes, 1,891 functions)
Machine: Apple Silicon Mac, JDK 25. Sources: `bench/results_mysqldump_sidecar.json`, `bench/results_mysqldump_largest.json`, `bench/results_mysqldump_ui.json` (scripts: `bench/bench_sidecar.py`, `BENCH=1` mode in `App.tsx`). Single runs, no repeats.

| Item | Value |
|---|---|
| Import + analysis, first open | **103 s** (JVM start 3.5 s on top) |
| Reopen from project | **2.3 s** `open_binary` (5.8 s from process spawn to ready) |
| RSS after open (sidecar process) | 1,198 MB fresh import; 371 MB after persisted reopen |
| RSS after the decompile workload | 608 MB (+172 MB native decompiler) on the persisted run |
| Listing 100 rows, 300 random positions (sidecar, WebSocket) | median 7.1 ms, p95 12.1 ms, max 33 ms |
| Listing 100 rows backward, 100 positions | median 7.7 ms, p95 11.4 ms |
| Same, in the renderer (jump to render, 300 random) | median 8.7 ms, p95 25 ms, max 58 ms |
| Scripted sweep start to end (1,000 sequential jumps) | median 8.4 ms, p95 17 ms, max 75 ms; renderer frame gaps max 9.3 ms (display is ~120 Hz) |
| Fling 100 lines/frame (~12k lines/s) for 20 s | 199k lines; 418 of 2,401 frames could not get all 100 lines (data wait), worst consecutive wait 58 ms; frame gaps max 9.4 ms |
| Decompile, 50 random functions (median function is 80 bytes), listing fetches running | sidecar: median 13.8 ms, p95 50 ms, 0 errors. Renderer run (also with a fling): median 16.6 ms, p95 94 ms, max 6.25 s (one big function) |
| Decompile, the 50 largest functions (1.1 KB to 35.8 KB), listing fetches running | median 257 ms, p95 2.76 s, max 4.5 s, 0 errors |
| Listing fetch latency while decompiling | random functions: median 10 ms, p95 20 ms. Largest functions: median 9.3 ms, p95 38.8 ms, max 123 ms. Renderer fling run: median 5.4 ms, p95 22 ms, max 76 ms |

Reading this: scrolling stays responsive while decompiles run (the worker split works); the 50-random sample is mostly tiny functions, so the largest-50 row is the honest decompile worst case. The fling stalls are the buffer refilling more slowly than a 12k lines/s fling (100-row batches, 60-line margin): the renderer never janked, it showed the last buffered row until rows arrived. Tunable (bigger batch/margin) but not tuned.

Not measured: row count of `mysqldump` (not needed any more, no index); Java `RowFetcher` was not integrated because 100 rows cost ~7 ms end to end; wheel scroll feel on a real trackpad (scripted only); anything on a 50 MB+ binary; rAF timing assumed an unthrottled visible window.

## Smoke test, `/bin/ls`
`sidecar/timings.json` (import + analysis 13.2 s, reopen 0.29 s, listing 200 rows median 10.7 ms, 11.6 ms during a decompile). The old "ls" numbers disagree because they were different files: `/bin/ls` is a fat x86_64 + arm64e binary and `lipo -thin arm64` fails on arm64e, so the app and the test open the fat file and Ghidra picks the **x86_64** slice (48,128 loaded bytes, 23,475 rows). `bench/ls_arm64e` is the **arm64e** slice (88,672 bytes, `AARCH64:LE:64:AppleSilicon`, 64,381 rows). Earlier text calling the app's `/bin/ls` "arm64" was wrong. The old per-code-unit index (1.1 s, ~77 MB for 64k rows, `bench/results_ls.json`) no longer exists.

## Go / no-go on the listing
**GO.** Address-based scrolling removes the index cost and the 2.09M-row renderer limit, labels fit as a line above, and measured latencies (7-9 ms median, 25 ms p95 in the renderer) are well inside a 50 ms budget with a decompile running. The condition: re-run `bench_sidecar.py` and `BENCH=1` on one 50 MB+ binary before committing the v1 schedule; per-fetch cost should be size independent, but it is unmeasured.

## Risks, re-ranked (extra weeks on the ~30-week v1 plan; estimates, not measured)
1. **First-open analysis time and memory at real size (+2 to 3 wk).** 7 MB took 103 s and 1.2 GB RSS; 66 MB did not finish in 16 min last round. Persistence fixes repeat opens (2.3 s) but not the first. `open_binary` is still not cancellable, has no real progress (pct -1), blocks the read thread, and a cancelled/crashed analysis is simply redone. Needs cancel, analysis progress, partial results, memory limits.
2. **Decompiler tail latency (+1 wk).** Largest functions: p95 2.8 s, max 4.5-6 s. Cancel works; token fidelity (indirect calls, thunks have no `targetFunction`) still tested on few functions only.
3. **Listing completeness (+2 to 3 wk, was the old #1).** Only one address space, signed offsets for addresses above 2^63, primary symbol only, EOL comment only, no xrefs/fields/function headers/plate comments, no invalidation after edits, bytes capped at 16. The 6-week listing budget now looks plausible for the viewer itself, not for those features.
4. **Build and toolchain coupling (+1 to 2 wk).** JDK 25 + Gradle 9.x Ghidra master; stock `pyghidra.start()` and `open_project` failed in this environment, so the sidecar builds the launcher itself and avoids `open_project`. Needs a bundled JDK + Ghidra + Python.
5. **Scroll feel under fast fling (+0.5 wk).** 17% of frames waited for data at 12k lines/s; scrollbar thumb snaps to the top row's address; buffer is a single contiguous run (a jump always refetches).
6. **Sidecar security and lifecycle (+1 wk).** Token auth exists. Still open: `open_binary` leaves half-open state on failure, project lock means one sidecar per projects dir, shutdown does not close the project cleanly (`os._exit`), no CSP/navigation blocking, second client rejected, `before-quit` quit path only tested through the SIGTERM/autotest paths.

## Shortcuts (marked `shortcut:` in code)
Decompile cache: only comment/code changes are invalidated by range, any symbol/function/data/type/other change clears it whole; edits are in memory only (not saved to the project: no save RPC yet); `search_symbols`/`list_strings` scan linearly (strings cached until next change); `rename_variable`/`retype_variable` block thread R for one decompile (30 s timeout, not cancellable); xrefs list memory references only; analysis progress has no global pct (per-analyzer pct, `done` count); single default address space (`addr`, `listing_info`); one process per projects dir (project lock); unanalyzed/half-analyzed program is just re-analyzed; first 16 bytes of big data units; second client rejected; no token when `SIDECAR_TOKEN` unset (tests only); whitespace-split `SIDECAR_CMD`; byte positions as JS numbers; single contiguous listing buffer.

## Deviations
- JDK 25, not 21 (Ghidra master requirement). Ghidra checkout untouched except git-ignored build output.
- Mid-size binary: the native `decompile` binary is 3.5 MB (below the 5-10 MB target), so I used `/opt/homebrew/Cellar/mysql-client/9.3.0/bin/mysqldump` (6.95 MB; first-open analysis 103 s).
- Fling/sweep are scripted renderer drivers, not a person scrolling.

## Round 3: #1/#2 gaps closed
**Added** (contract in `protocol.md`/`protocol.ts`, mock in `app/mock`):
- `save` + `dirty` in `UndoState` (carried by `program_changed`; save fires it with empty ranges/kinds). **Measured: saving a changed program clears both undo and redo stacks** (save is an undo barrier; edits after it are undoable). Undoing back to the saved state makes the program clean again; `dirty` is false right after open.
- `close_program` (idempotent, cancels decompiles, `NoProgram` after).
- `import_candidates`, `list_languages`, `open_binary {loader, language, compilerSpec, baseAddress}`. Key: no options = plain sha256 (old projects still load), any option = `sha256-<12 hex of options hash>`. Raw Binary is the only stock loader with a base address; `baseAddress` is rejected for other loaders.
- `list_programs` (metadata in `programs.json` in the projects dir) and `delete_program` (`Busy` if open).
- Mandatory `SIDECAR_TOKEN` (exit 2 unless `SIDECAR_ALLOW_NO_AUTH=1`).
- UI: File > Save (Cmd+S) enabled when dirty, dirty marker in the title, Save / Don't Save / Cancel before quit, close, and open; File > Close Program; import dialog (Enter = defaults); welcome pane with the program browser and confirmed delete.

**Tested:** pytest 16 passed (each new method, raw blob with explicit language + base address and a different key from the default import, save → reopen, delete-while-open `Busy`, close cancels decompile, auth refusal); `npm test` 14 passed; autotest passes on the mock and on the real sidecar with `/bin/ls` (dirty/save, close → welcome, import dialog defaults and explicit options, quit prompt through a real `win.close()` via the main-process handler, Cancel keeps the app alive). A fresh review found the sidecar commit had mangled two blocks (fixed), a UI/sidecar desync after a rejected open (fixed), and View > Reload bypassing the prompt (menu item removed).

**Not tested / limits:** real Cmd+Q and the red button by hand (only `win.close()` and the shared handler); the raw import only with x86-32 and 6502 languages; the explicit-options open in the real autotest is answered locally, so no second analysis of `/bin/ls`; language picker with hundreds of entries is a filter plus a `size=6` select, not looked at by a person; explicit base `0` creates a second entry next to the default import (no collision, duplicate analysis); `_close()` leaves the coalescer's armed flag set (harmless today); no editing UI yet. Benchmark hunks in `sidecar/main.py`, `sidecar/timings.json`, `bench/` were left uncommitted throughout; pytest ran with them present.

## Round 4: one 66 MB binary (the round-2 GO condition)
Binary: `llvm-exegesis` (Homebrew llvm 23.1.3, arm64, 66.7 MB, 2 ranges, 48,800 functions, 164k strings). Apple Silicon Mac, JDK 25. Single runs. Sources: `bench/results_llvm-exegesis_{first_open,fast_open,sidecar,probe_full,probe_fast}.json`; Ghidra's per-analyzer times are in the git-ignored `.stderr.log` next to each first-open result (the slowest are quoted below); scripts `bench/bench_open.py` (first open, cancel, memory every 5 s), `bench/bench_sidecar.py`, `bench/bench_probe.py` (what an analysis found).

**Listing: GO confirmed.** Per-fetch cost does not depend on binary size.

| Item | 66.7 MB | 7 MB (round 2) |
|---|---|---|
| Listing 100 rows, 300 random positions | median 8.6 ms, p95 20.7 ms, max 86 ms | 7.1 / 12.1 ms |
| Listing 100 rows backward | median 7.7 ms, p95 16.9 ms | 7.7 / 11.4 ms |
| Listing while the 50 largest functions decompile | median 6.8 ms, p95 15.5 ms, max 321 ms | 9.3 / 38.8 ms |
| Reopen from project | 2.6 s `open_binary`, 6.2 s spawn to ready, 362 MB | 2.3 s |
| Decompile, 50 random functions (median 156 bytes) | median 29 ms, p95 518 ms, max 14.5 s | |
| Decompile, 50 largest (34-101 KB) | **median 19 s, max 33 s, 15 of 50 failed** (30 s timeout) | p95 2.8 s |

**First open is the problem.**

| | Full analysis | Fast profile |
|---|---|---|
| Analyzers off (`SIDECAR_ANALYSIS_DISABLE`) | none | Decompiler Switch Analysis; Call Convention ID; Stack |
| Import + analysis + save | **2,396 s (40 min)** | **1,003 s (17 min)** |
| Peak RSS, JVM / native decompiler | 3.5 GB / 5.6 GB | 4.1 GB / 48 MB |
| Functions / strings | 48,800 / 164,276 | 48,833 / 164,306 |
| Sample of 2,440 entries still function entries | 2,440 | 2,440 |
| References to that sample (calls) | 18,248 (10,765) | 17,670 (10,210), -3% (-5%) |
| 40 mid-size decompiles: `switch` statements / `undefined` / lines | 9 / 1,416 / 19,395 | 5 / 1,422 / 18,767 |

Full run, slowest analyzers (Ghidra task times): Call Convention ID 574 s, Decompiler Switch Analysis 362 + 220 s (one-time), Stack 298 s, Create Address Tables (one-time) 284 s. The three disabled ones are ~1,450 s of 2,384 s and the only users of the native decompiler during analysis, hence the 48 MB. Fast run, slowest: Create Address Tables (one-time) 224 s, Basic Constant Reference 207 s, Disassemble Entry Points 158 s.

Reading this: the fast profile keeps the function set and nearly all references; the visible loss is recovered switch tables (5 of 9 in the sample) and some call references. Calling-convention and stack-variable quality was not compared beyond the `undefined` count. JVM peak was higher in the fast run (4.1 vs 3.5 GB), not explained; the Editing session's autotests ran for part of it, so treat time and memory as approximate.

**Decompile on the fast-profile program** (`results_llvm-exegesis_fast_sidecar.json`, same workload): 50 random median 16 ms (p95 235 ms, max 9.8 s, 0 failed); 50 largest median 11.2 s (full: 19 s), **9 of 50 failed** at the 30 s timeout (full: 15); listing median 4.8 ms. Large functions stay slow either way (largest 100 KB): the 30 s timeout, not the profile, is what fails them. Not isolated: whether the faster result is the missing calling-convention/stack info or noise (single run). Timing caveat: another session ran app autotests on this Mac during the fast-profile first open, so its time and JVM peak are not clean-room numbers (the task asked for nothing in parallel).

**Cancel works at real size:** cancelling at 10 s, 60 s and 180 s into analysis was acknowledged in 1-21 ms and `open_binary` failed with `Cancelled` 33-365 ms later.

**Code changes** (`sidecar/main.py`):
- `SIDECAR_ANALYSIS_DISABLE="Name;Name"` switches analyzers off for first-open analysis. The list is part of the `programId` (fifth key `analysisDisable` in the options hash, protocol.md "Persistence key"), so a reduced analysis never shares a key with a full one (`test_keys.py`). shortcut: process-wide env var, no UI.
- JVM `-Xmx`: `SIDECAR_MAXMEM`, default half of RAM capped at 24 GB (was the JVM default of 1/4).
- Ghidra's per-analyzer task times are logged after each analysis.

**Next, re-ranked:**
1. First open: offer the fast profile as the default and run the disabled analyzers in the background after the program is usable (needs analysis on thread R or a second program handle, progress, and the UI to show "analysis still running").
2. Huge functions: timeout per request from the UI ("decompile anyway"), and a size warning before decompiling >30 KB functions.
3. The higher JVM peak in the fast run: re-measure alone.

**Not done:** no run of the app UI (`BENCH=1`) on this binary, only sidecar-level measurements; no repeat runs; the fast-profile program from the run was stored under the old (plain sha256) key before the key change, so the probe numbers above came from it.

## Round 5: row 6, navigate and find
Branch `claude/nav-find-row6`, rebased on main. Contract in `protocol.md`/`protocol.ts`, mock in `app/mock`, pytest in `sidecar/test_backend.py`, UI flow in `app/src/renderer/autotestNav.ts`.

**Built**
- **Scan workers (thread S, 2 by default).** `list_symbols`, `list_strings`, `search_symbols`, `search_memory` no longer run on thread R; they are cancellable by request id (`cancel_search`), cancelled on close/replace, and their snapshots (symbol views, string scans; LRU of 8) are dropped on every program change.
- **Symbol table** (`list_symbols`, paged, sort by name/address/kind/namespace/source, name filter, kind filter) and **Strings** (`list_strings` + `query`) windows, virtualized, server-paged; click/Enter navigates listing and decompiler. `search_symbols` now matches inside Ghidra (`SymbolTable.getSymbolIterator` glob), so only hits cross into Python.
- **Memory search** (`search_memory`): Ghidra's `memsearch` API (`UserInputByteMatcher` + `MemorySearcher`) over the loaded initialized set; hex with `??` wildcards, ASCII/UTF-16 text, optional case-insensitivity; one page per request with a `next` address; the panel streams pages, Cancel keeps results, Continue resumes.
- **Xrefs**: every reference has a `kind` (call/jump/read/write/readwrite/data/flow/other); `xrefs_from` also returns stack/register/external references (`target`, `label`); `xrefs_to_variable` for a decompiler variable token; `X` on a listing row or a decompiler token (also Go menu, Monaco context menu) pins the panel; "from…" toggle.
- Item 5 (instruction/operand text search): **skipped**, not started.

**Measured** (`bench/bench_navfind.py` -> `bench/results_llvm-exegesis_navfind.json`; 66.7 MB llvm-exegesis, 190,443 symbols, 164,276 strings, persisted program; single run). **Not a clean run:** the quiet check found 15 other processes (other sessions' Electron apps, sidecars and ~10 native decompilers, load average ~10) at start and 8 at the end, and no quiet window appeared in ~15 minutes. Treat times as upper bounds and re-run when the machine is idle.

| Item | Result |
|---|---|
| Symbol table, first page (default view) | 347 ms cold, 3.5-5 ms warm; 2nd page 4.9 ms |
| Symbol table, deep page (last 100 rows, default view) | 1.0 s cold (walks the iterator), 5.6 ms after |
| Filter while typing "s","st","std","std::","std::vector" (each cold) | 2.4 s, 1.3 s, 0.8 s, 0.6 s, 0.6 s; repeat 5.7 ms; page 2 5.6 ms |
| Rare filter ("exegesis", 1,383 hits) | 0.73 s |
| Kind filter (function / label / external), cold | 4.3 s / 4.0 s / 4.0 s |
| Sort cold: name / namespace / source / kind | 1.3 s / 2.3 s / 2.4 s / 4.5 s; address desc 0.8 s; page 2 of each ~5 ms |
| `search_symbols` "std::vector" | 0.76 s (was a Python scan) |
| Strings first page (full scan of 164k strings, cold) | **13.8 s** (19.9 s with the first implementation; the 13.8 s was a separate run), minLength change = another full scan (17.2 s measured before the fix); query filter on the cached scan 27 ms; any later page 1.3 ms |
| Byte search, 4 bytes, whole binary, no match (`de ad be ef`) | 449 ms cold, 322 ms again |
| 4-byte pattern with wildcard (`48 8b ?? 24`, 3 hits) | 1.3 s |
| `fd 7b bf a9` (1,904 hits, one per prologue) | 465 ms |
| `00 00 00 00` (5.7 M matches, 574 pages of 10,000) | 306 s total, slowest page 1.2 s: the panel stops at 50,000 matches |
| Text ASCII `std::` / UTF-16 `std` / ASCII `ERROR` nocase | 0.30 s / 0.30 s / 0.40 s (3 pages) |
| Listing fetch (100 rows) baseline | median 7.2 ms, p95 30 ms, max 95 ms |
| ... while a byte search runs (x1 / x3 back to back) | median 8.8 / 11.3 ms, p95 18 / 25 ms, max 26 ms |
| ... while the first strings scan runs (19 s) | median 11.3 ms, **p95 183 ms, max 474 ms** |
| Sidecar RSS | 372 MB after open, 1.41 GB after all of the above (snapshots hold Java Symbol objects) |

Reading this: searches are not a problem for the listing (the scan is inside Java). The first strings scan is: it is a Python loop over 164k JPype objects, takes 14-20 s, and the Python thread contends with thread R for the GIL (p95 183 ms). Kind filters and kind sort are also Python loops over all 190k symbols (4 s).

**Tested:** pytest 31 tests on `/bin/ls` (new: `test_list_symbols`, `test_scan_cancel_and_listing_not_blocked`, `test_xref_kinds_and_variables`, `test_strings_query`, `test_search_memory`); `npm test` 24 pass; `npm run typecheck`; autotest on the mock and on the real sidecar (`/bin/ls`) drive each panel through the DOM (sort, filter, kind chip, min length, click to navigate, byte/wildcard/text/UTF-16 search compared against the RPC, cancel click, listing X, decompiler X, from-mode). `test_pool_concurrent_and_cancel` fails when the machine is loaded (also on the pre-branch code: concurrent 0.6 s vs sequential 0.4 s with other sessions running); it is a timing assertion, not related to this work (31/31 passed on the final run, after the rebase).

**Not done / limits**
- Strings first scan 14-20 s and its GIL contention; fix = lazy paging by address or a Java-side helper (the bench `RowFetcher` route). Kind filter/sort: same.
- Deep offset in the default symbol view walks the iterator (1 s for the last page); no address index.
- Instruction/operand-text search (item 5) not built.
- Variable xrefs only for variables the program has (stack locals, parameters, renamed ones); decompiler temporaries (`iVar1`) and global variables give an empty list, no symbol lookup for globals.
- Cancel through the UI is only checked as "click, no error": on `/bin/ls` and on the mock a search ends before the click lands. The cancel RPC is tested in pytest (queued request) but a running `search_memory` cancel is not.
- Symbol table lists variable symbols too (kind `variable`); non-default address spaces and externals have no address (not navigable). Dock height is fixed; no column resizing.
- Memory search cannot restrict to blocks/selection; `start` is the only range control. Search results are not refreshed after edits (the panel clears on program change).
- A page read racing an edit can fail `Cancelled` ("program changed").

## Round 5 (rows 1 and 2): backend API gaps and app shell gaps
Rebased onto the row-6 work above, which independently added `list_strings {query}`, `xrefs_from` with stack/register/external targets, the strings dock and the references panel with a from-mode. Where both existed I kept main's and dropped mine, so those parts are not described as mine below.
Contract first: `protocol.md`, `protocol.ts` and the mock (`app/mock/server.mjs`) were updated in their own commit before any UI used the new methods.

**Backend (`sidecar/main.py`)**
1. `get_comments {address}` returns only the kinds that are set. 
2. Labels: two methods, `create_label {address, name}` (new, `InvalidArgument` if a label already exists) and `rename_symbol` unchanged (`NotFound` where nothing exists). Chosen so a stale view can never create a second label by mistake. `L` in the listing picks one by whether the row has a label.
3. Analysis profile: `open_binary {profile: "full" | "fast"}`. Fast = Call Convention ID, Decompiler Switch Analysis, Stack (the round-4 set). Not an import option: the key rule is unchanged (`analysisDisable` enters the options hash only when the effective list is non-empty), so `fast` yields exactly the key round 4 produced with the env var. Omitted = `SIDECAR_ANALYSIS_DISABLE` if set (kept, free), else full; explicit `full` beats the env var. `test_keys.py` still passes unchanged, plus a new profile test. A fast program records `profile: "fast"` in `list_programs` options.
4. `rename_variable` / `retype_variable` take `timeoutSecs` (default 30), answer `Timeout` and are cancellable through `cancel_decompile` (the request id is registered like a decompile's). Shutdown now also cancels one that is running.
5. Xrefs / imports: already covered by main's `xrefs_from` (`target: "external"`, `label`) and `xrefs_to` (memory only; an import is found through its IAT slot). My own version was dropped in the rebase; my pytest for it (PE `WinHelloCPP.exe`) now checks main's shape. /bin/ls and the ELF exercise files have no external references in this Ghidra.
6. Clean shutdown: after the close-save the project is closed (`GhidraProject.close()`), then `os._exit`. Measured before/after on /bin/ls with one saved edit: before, `spike.lock` and `spike.lock~` stayed in the projects dir after every exit; after, they are gone. Exit 0 in 0.12 s, next start opened the persisted program in 1.8 s with the edit present and no lock or recovery text on stderr. The old behaviour also reopened fine (Ghidra tolerates the stale lock), so this cleans up files rather than fixing a failure I could reproduce.
7. Second sidecar on the same projects dir: before, `Internal -32603: LockException: Unable to lock project!`; now `ProjectLocked -32006`, message `projects dir in use by another Ghidrette (<dir>)`, on every project-touching request, sticky-free (works once the first one exits; tested).
Also: `import_candidates` returns `sizeBytes` (the renderer has no fs).

**App shell**
8-9. Strings panel and references from: done by the row-6 work on main (dock, `list_strings` query, from-mode); not redone here. 10. Size warning for functions over 30 KB and "Decompile anyway" after a `Timeout` (also after a user cancel), with the long timeout (1800 s) and a Cancel button while it runs. 11. Comment dialog: `get_comments` prefill, text follows the kind selector, drafts survive switching kinds. 12. Import dialog: "Analysis" Full / Fast, Fast by default above 20 MB; the program browser shows "fast analysis". 13. Electron: CSP meta tag (`default-src 'none'`; scripts `'self'`; inline styles; `worker-src 'self' blob:`; `font-src/img-src data:`; `connect-src ws://127.0.0.1:*`), `will-navigate` prevented and `window.open` denied for every webContents, `contextIsolation: true, sandbox: true, nodeIntegration: false` set explicitly. A `securitypolicyviolation` listener reports blocked loads in the status bar, so a too-tight policy fails the autotest instead of silently degrading Monaco.

**Tested (all run in this session)**
- `pytest` on the real sidecar: new tests for `get_comments`, `create_label` (/bin/ls and the raw blob), variable-edit params and cancel, profiles (/bin/ls fast and full, raw blob, stderr shows the three analyzers disabled once), external xrefs on a PE (`WinHelloCPP.exe`), project lock, clean shutdown. `import_candidates` assertions updated for `sizeBytes`. Full run: 34 of 35 passed; the one failure was my raw-blob profile test reusing a blob whose comment an earlier test had left (test data, fixed with different bytes); the fixed tests were re-run alone and pass, the whole suite was not re-run after that fix.
- `npm test`: `defaultProfile`, `buildOptions` with a profile, `optionsSummary`/`reopenParams`, `isLarge`
- Autotest `AUTOTEST=/bin/ls npm start` passes on the mock and on the real sidecar (fresh projects dir, then `AUTOTEST_PHASE=2` for the persisted edit). New steps: comment prefill for all five kinds plus drafts and a saved edit, a label created with `L` on an unlabeled address, the import dialog's profile (sent as `profile: "fast"`; a real fast open of /bin/ls through the UI appears in the program browser as "fast analysis"), and hardening probes from the page (eval refused, `window.open` null, no `require`/`process`, navigation prevented; main reports `contextIsolation true, sandbox true, nodeIntegration false`). On the mock also the size warning, Cancel, Decompile anyway and the timeout path. The new steps undo their own edits.

**Not tested**
- Real Cmd+Q, the red close button and trackpad scrolling still need a person; the autotest quits through the same `before-quit` handler but not through a real keystroke or click, and listing scrolling is scripted.
- `Timeout` of a variable edit or a decompile against the real sidecar: the largest function in /bin/ls decompiles in 0.5 s even with `timeoutSecs: 1`, so the path was not reproduced; the size warning and "Decompile anyway" ran on the mock only (/bin/ls has no 30 KB function). The cancel of a variable edit races a 0.5 s decompile (the test retries up to five times).
- The strings panel refresh on `program_changed` is unit-tested but not driven by an edit in the autotest. The ProjectLocked message in the UI was not looked at (the mock has `MOCK_LOCKED=1` for that); only the sidecar side is tested. External-reference rows were rendered on the mock only. The default-Fast rule above 20 MB was checked on the mock and in `npm test`, not with a real 20 MB file.
- CSP: not minimised; `blob:` for workers is kept as Monaco's fallback and was not shown to be needed. No packaged build exists, so nothing was checked outside `electron-vite build` + `electron .`.
- No change to the benchmarks or `timings.json`.

## Round 5: row 7, data type manager
Branch `claude/ghidrette-data-type-manager-c9a23c`, cut from `main` (the row-6 branch `app-shell-restructure` is already merged there). Merged into `main` (97b1cc0); branch deleted.

**What works** (protocol.md "Data types", protocol.ts, mock, pytest, autotest all updated):
- 9 new RPCs: `dt_sources`, `dt_children` (one category level, lazy), `get_data_type`, `create_data_type` (struct/union/enum/typedef/pointer/category), `delete_data_type`, `rename_data_type`, `edit_struct` (add/insert/set/delete/clear/move/resize/pack), `edit_enum` (set/rename/remove/resize), `create_struct_from_data` (struct from the data items at a listing range, applied in the same transaction). `list_data_types` gained `kind` and `source`. Applying a type to an address reuses `define_data`.
- Every edit is one Ghidra transaction (one undo step, label `Edit <name>: <op>`); failures roll back and leave nothing on the undo stack. Verified by undoing step by step in pytest and in the autotest.
- UI: Types button / View > Data Type Manager (Cmd+Shift+T) opens a panel over the panes: program + built-in tree with filter (flat `list_data_types` search), struct/union editor (inline type/name/comment cells, add/insert dialogs with type autocomplete, delete, clear to undefined, move up/down for packed/union, resize, pack + packing value, hide-undefined), enum editor, create/rename/delete dialogs, "Apply at address…". Edit > Create Structure from Data… uses the listing cursor row + a length.
- Listing and decompiler refresh through `program_changed` (`type`, ranges null). The decompile cache is still cleared **whole** on `type`; a pytest (`test_apply_listing_decompiler_cache_undo_redo_persist`) and a mock test pin it (cached=false after any struct edit, true again on the next decompile). Not improved: decompiler output embeds layouts of types it never names, so per-function tracking would need the referenced-type set per entry.
- Tests: `npm test` 24 pass (new: `dt.test.mjs` tree logic, `mockdt.test.mjs` the mock speaking the protocol), `npm run typecheck` clean, pytest 31 pass (`test_datatypes.py`: 5 tests, 24 s each analysis copy), autotest passes on mock and on the real sidecar (`/bin/ls`, fresh projects dir) including `AUTOTEST_PHASE=2` (struct, applied data, struct-from-data and the decompiler's use of the type survive save + reopen). The autotest drives the UI: create struct, add fields (dialog), rename inline, resize, fill undefined bytes via the inline type cell, apply from the editor, see it in the listing, set a parameter to `AutotestStruct *` via Edit Function Signature and see it in the decompiler, undo all 8 steps, redo all 8 through the Edit menu, create a struct from data (undo/redo), save.

**Skipped**
- Opening `.gdt` archives and attached-archive browsing (optional): only the source archive name of a type is shown (`archive`), built-ins are read-only.
- Not editable: typedef targets, function definitions, categories (no rename/move), bit-field components (shown, refused). Unpacked-struct reorder is refused on purpose (see below). No multi-select in the struct table or tree. Struct editing has no per-field alignment/padding UI.
- The mock models structs more simply than Ghidra (no alignment: packing only drops filler and enables `move`).
- Not looked at by a person beyond one mock screenshot; no keyboard-only pass over the panel.

**Ghidra API gotchas (12.3)**
- `getComponents()` of an unpacked struct includes one 1-byte `undefined` filler component per free byte; `getDefinedComponents()` does not. A 4 KB empty struct is 4096 rows.
- Unpacked: `delete(ordinal)` removes the component and **shifts later fields up** (struct shrinks); `clearComponent` is the one that keeps size and leaves filler. `replace` with a bigger type eats following filler (IllegalArgumentException if short), a smaller one leaves filler behind. Reorder has no meaning there: offsets are fixed, so `move` works only on packed structs/unions.
- `EnumDB` has no `setLength`; resizing means `dtm.replaceDataType(old, copy)`.
- `DataTypeManager.remove(dt)` takes one argument here (older docs show a monitor). `Category.removeEmptyCategory(name, monitor)` still takes one.
- `dtm.resolve(..., DEFAULT_HANDLER)` of a same-named different type silently makes `Name.conflict`: create checks first and uses KEEP_HANDLER.
- An empty struct reports `getLength()` 1; use `isNotYetDefined()` to show 0. `getSourceArchive()` is never null: the program's own archive has type PROGRAM, only FILE/PROJECT are foreign.
- Pointers and arrays are real types in the program's root category (`/S *`, `/char[8]`); pointer creation is idempotent.
- Type events are `ProgramChangeRecord`s with no address: ranges are always null, so every type edit refreshes the whole listing.
- `InvalidNameException` is not covered by the old `INVALID_JAVA` list (added). A struct containing itself by value fails with an IllegalArgumentException ("has ... within it").
- Observed, not investigated (existing `clear_code`): `clear_code` at the Mach-O header (0x100000028, 8 bytes) also removed instructions of a function at 0x100000812 on `/bin/ls`. The new tests avoid `clear_code`.
- Test timing: after an edit `program_changed` makes the listing re-jump to its old top row about 100 ms later; a navigation fired in that window is lost (the autotest settles and retries).

**Addendum: auto create structure** (done after the first Round 5 pass). `auto_create_structure {entry, name, structName?}` runs `FillOutStructureHelper.processStructure` (what `FillOutStructureCmd` uses) on a decompiler variable, adds the struct, retypes the variable to a pointer to it, one transaction "Auto create structure in <fn>". UI: Edit > Auto Create Structure (variable)… with the cursor on a variable in the decompiler. pytest `test_auto_create_structure` (undo is one step, redo restores) and the real autotest (cursor + Edit menu, undo/redo, survives reopen) pass; the mock has a stub (one `long` field) and the autotest step is skipped there (the mock decompiler has no variable tokens). Gotchas: the helper by default *extends* the struct a variable already points to (a variable typed as a Mach-O header struct got renamed by my first version when `structName` was given; now a name forces a new struct); it fails with `InvalidArgument` when nothing is accessed through the variable; callee decompiles run inside the request on thread R. Inferred structs from `/bin/ls` were tiny (the autotest's had one 1-byte field): quality on real pointer-heavy code was not evaluated.

## Round 8: listing completeness
Branch `claude/ghidrette-listing-gaps-befab8`, cut from `main` (57dd24b). **Other session check:** `claude/round8-addresses-xrefs-ee9989` had no commits beyond `main` (its worktree sits at 2dc4227, an ancestor of `main`) and no uncommitted changes, so there was nothing to build on or skip; I did the whole list. Contract first: `protocol.md`, `protocol.ts` and the mock are their own commit (c616c14); the sidecar, the renderer and the autotest follow.

**Built** (the `shortcut:` markers are in the code)
1. **Address spaces.** `listing_info` lists the loaded+initialized ranges of every space (overlay blocks included) in Ghidra's address order; `listing_rows` walks across spaces in that order (`_view` builds the clipped set per range, since an `AddressSet` range cannot span spaces). Wire format: default space `"0x401000"` (unchanged), other spaces `"code:1000"`, overlays `"OVL1::1000"` (Ghidra's spelling), split at the last `:`. `Sidecar.addr` parses all of these (also `"ram:401000"`), `fmtr` formats them; xrefs, symbols, strings, memory search, tokens and `program_changed` ranges use it. Client: `address.ts` (parse/format/intersect), `addrmap.ts` orders ranges by sequence with a space rank, `parseGoto.ts` accepts qualified input (a symbol of the same name still wins).
2. **Above 2^63.** Every offset goes out masked to unsigned (`hx`, `fmtr`, `_akey`), `addr()` wraps back to Java's signed long; `0xfffffffffffff000` round-trips in pytest and in the mock's high range. JS-number math remains only for scroll positions.
3. **Row content.** `ListingRow` now has `header` (signature, calling convention, params, stack param/local bytes, noreturn, thunk), `pre/post/plate/repeatable` next to the EOL `comment`, `labels` (all symbols, primary first), `xrefs` (`count` plus up to 5 `{from, kind}`), `parts` (struct/union/array components, folded by default; click the arrow or Left/Right to unfold) and `bytesMore`. Rendering: plate and header lines above, label lines, an `XREF[n]:` line whose items are links (navigate) and whose `… +N` opens the references panel, pre/post lines, `X` as before. To keep fetches cheap the sidecar asks Ghidra once per fetch which units in the window have symbols, comments of each kind, a function or references (iterators over the window) instead of five calls per row.
4. **Invalidation.** `Listing` takes the `program_changed` ranges and refetches only the buffered rows that intersect them (`rowcache.ts` `spliceRows`: fetch forward from the first affected row until the new rows cover the old span, keep the old rows behind if they continue exactly there, units may split or merge); the view does not move. Type edits and undo/redo (no ranges) refetch from the top row. **Race fixed at the root:** the old re-jump to the top row 100 ms after an edit is gone, and a refresh whose buffer was replaced by a jump meanwhile is dropped and re-applied to the new rows (found while testing: a null-range refresh that started before a jump landed after it and undid the navigation; covered by the autotest's "navigation 100 ms after an edit" step and an undo right before a navigation).
5. **Scroll feel.** `RunCache` keeps up to 4 earlier runs; a jump into buffered rows, or into a kept run, fetches nothing (autotest: far, mid, far again). Batch 100 -> 250 rows with a 400-line margin; a jump waits for a 100-row fetch only and the top-up prefetch starts 40 ms later and is cancelled by the next jump (my first version fetched 250 rows on a jump and made random jumps twice as slow, 16.5 ms median). The scrollbar thumb stays where the user holds it (pointer-down flag, no resync while dragging).

**Measured** (single runs each; the machine was also running Electron and pytest at times)
| Item | Result |
|---|---|
| Sidecar, 100 rows, 300 random, `/bin/ls`, **before** (original code, same machine) | median 5.4 ms, p95 11.1, max 34; backward 5.4 / 11.6 |
| same, **after** | median 5.0 ms, p95 15.1, max 58; backward 4.6 / 9.8 |
| same, `mysqldump` (7 MB, 2 ranges), after | median 2.8 ms, p95 8.2, max 32; backward 2.8 / 4.2 (round 2 on an earlier machine state: 7.1 / 12.1; not re-measured before) |
| Renderer, `mysqldump`, 300 random jumps to render | median 8.3 ms, p95 16.8, max 68 (round 2: 8.7 / 25) |
| Renderer sweep, 1,000 jumps | median 8.3, p95 14.2, max 61 (round 2: 8.4 / 17 / 75) |
| Fling 100 lines/frame (12k lines/s at ~120 Hz), 20 s, round-2 settings (100 rows, 60 margin) in the same session | 20 of 2,401 frames waited (0.8%), worst run 41 ms. Two earlier runs: 10 and 9 (0.4%) |
| same, new settings (250 rows, 400 margin) | 0 of 2,401 frames waited (earlier runs: 0 and 1) |
| Fling while 50 random decompiles run | 1 of 87 frames waited (1.1%); earlier runs 2.8% and 7.4% (worst run 116 ms) |
| Edit (plate comment) refresh | one forward fetch of 16 rows, view unchanged (mock and `/bin/ls`) |
The round-2 figure of 17% waiting frames was **not reproduced** with the old settings (0.4-0.8% today), so "clearly fewer than 17%" is true but the gain over the old settings on this machine is from under 1% to about 0%; I do not know why round 2 saw 17%. The `llvm-exegesis` project is not in the projects dir here, so it was **not** re-run; bench numbers are `mysqldump` and `/bin/ls` only. Row building stayed in Python (no Java helper needed). Sources: scratch results, not committed; `bench/bench_sidecar.py` takes `LISTING_ONLY=1` now and handles qualified range starts; `BENCH=1` compares the two fling settings in one session.

**Tested**
- `sidecar/test_listing.py` (new, 4 tests, in-process on hand-built programs): address round trip and rejection of bad input; a raw 64-bit blob at 0xfffffffffffff000 next to an overlay block and the default block (ranges, walk order across spaces, backward into the previous space, end of the last range); function header, plate/pre/post/EOL/repeatable, two symbols at one address, an xref, a `char[20]` with `bytesMore` and 20 parts; the 64-part and 5-xref caps. Whole sidecar suite: 49 passed, 1 failed: `test_persist.py::test_snapshot_survives_sigkill`, which fails identically on untouched `main` (57dd24b), so not from this work; `test_backend.py::test_pool_concurrent_and_cancel` was deselected (a timing assertion that fails under load, known from Round 5).
- `npm test` 42 pass (new: space-aware `AddrMap` and address helpers, qualified go-to, `spliceRows` cases for edit in place / split / merge / misaligned tail / end of listing, `RunCache`), `npm run typecheck` clean.
- Autotest (`AUTOTEST=/bin/ls`, mock and real sidecar, plus `AUTOTEST_ONLY=listing` for the new flow alone): function header, `XREF` line and a click on a reference, plate comment refreshing only its rows, navigation 100 ms after an edit surviving the late refresh, jump back into a kept run without fetching, thumb not moving while dragging (flag set by the test, not by a mouse), fold/unfold of the Mach-O header struct on `/bin/ls` (8 components), navigation into the mock's overlay range `OVL1::1000` and the range above 2^63.

**Not done / not tested**
- Overlay and multi-space **in the UI against the real sidecar**: only the mock has extra spaces; the real sidecar's spaces are tested in-process (methods called directly, no WebSocket).
- Bytes beyond 16: truncated with `…+N`, **not expandable** (shortcut: needs a `get_bytes` RPC).
- `list_functions`, `decompile` and the function-based panels still see the default space only (functions inside an overlay show in the listing but not in the function list); the decompile cache is keyed by default-space offset, so a change in another space clears it whole.
- The `XREF` annotation of a *target* row is not refreshed when another row's reference changes (ranges only cover the source); it updates on the next fetch of that row. `parts` is one level deep and capped at 64; `xrefs.items` are the first 5 Ghidra returns, not the 5 lowest.
- The thumb behaviour was checked synthetically; I could not reproduce the original snap with a real drag, so whether it is gone for a person dragging is unconfirmed. Scrolling and flings are scripted, not a person on a trackpad.
- The listing flow's real-sidecar run is on `/bin/ls` only (no overlay, no struct arrays beyond the Mach-O header). `spaces` is empty there.
- A first full real-sidecar run had one flaky failure in the existing search step (`focusRestored`, window focus) and one in my own fold step (waited too briefly); the second is fixed, the first passed on the next run and was not investigated.

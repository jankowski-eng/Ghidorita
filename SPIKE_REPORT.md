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
- Autotest (`AUTOTEST=/bin/ls`: full runs on the final code passed on the mock and on the real sidecar, and `AUTOTEST_PHASE=2` on the real one; plus `AUTOTEST_ONLY=listing` for the new flow alone): function header, `XREF` line and a click on a reference, plate comment refreshing only its rows, navigation 100 ms after an edit surviving the late refresh, jump back into a kept run without fetching, thumb not moving while dragging (flag set by the test, not by a mouse), fold/unfold of the Mach-O header struct on `/bin/ls` (8 components), navigation into the mock's overlay range `OVL1::1000` and the range above 2^63.

**Not done / not tested**
- Overlay and multi-space **in the UI against the real sidecar**: only the mock has extra spaces; the real sidecar's spaces are tested in-process (methods called directly, no WebSocket).
- Bytes beyond 16: truncated with `…+N`, **not expandable** (shortcut: needs a `get_bytes` RPC).
- `list_functions`, `decompile` and the function-based panels still see the default space only (functions inside an overlay show in the listing but not in the function list); the decompile cache is keyed by default-space offset, so a change in another space clears it whole.
- The `XREF` annotation of a *target* row is not refreshed when another row's reference changes (ranges only cover the source); it updates on the next fetch of that row. `parts` is one level deep and capped at 64; `xrefs.items` are the first 5 Ghidra returns, not the 5 lowest.
- The thumb behaviour was checked synthetically; I could not reproduce the original snap with a real drag, so whether it is gone for a person dragging is unconfirmed. Scrolling and flings are scripted, not a person on a trackpad.
- The listing flow's real-sidecar run is on `/bin/ls` only (no overlay, no struct arrays beyond the Mach-O header). `spaces` is empty there.
- A first full real-sidecar run had one flaky failure in the existing search step (`focusRestored`, window focus) and one in my own fold step (waited too briefly); the second is fixed, the first passed on the next run and was not investigated.

## Round 6: sidecar/main.py split into domain modules (no behavior change)
Branch `refactor/sidecar-modules`, off `main` (97b1cc0). Not merged, not pushed. Preconditions held: `claude/ghidrette-data-type-manager-c9a23c` is merged into `main`, and no branch has unmerged changes to `sidecar/main.py`. Wire protocol, error codes, lane semantics, persistence keys, env vars and log lines are unchanged. Layout, thread model and "How to add an RPC": `sidecar/ARCHITECTURE.md`.

**Layout**
```
sidecar/
  main.py                    62   entry point: token check, JVM (max_heap, headless), App(), serve, stdin/SIGTERM -> shutdown
  ARCHITECTURE.md
  ghidrette/
    app.py                   31   wiring: Ctx, Project, Program, DOMAINS, shutdown hooks
    core/
      errors.py              25   RpcError, codes, INVALID_JAVA, java_error(), log()
      args.py                26   hx, lim, text_arg, name_arg
      lanes.py              182   Job/Scan/Opening/Worker, Lanes (R, S, D queues and threads, run, on_r, scanning, cancel)
      session.py             78   open program, epoch, undo snapshot, need/addr/edit/cmd/function
      events.py             122   DomainObjectListener, coalescing, subscribe(fn(kinds, ranges, broad)), record, reset
      context.py             35   Ctx: what every domain gets (also notify/progress)
      rpc.py                120   @rpc(lane=...), Registry, Dispatcher
      server.py              78   websocket conn, one-client rule, auth guard, serve, shutdown
    domains/
      project.py            193   Ghidra project, programs.json, browser RPCs, program_key/FAST_PROFILE/analysis_disabled
      program.py            372   open_binary, cancel_open, close_program, save, undo/redo/undo_state
      listing.py            105   listing_info, listing_rows, list_functions, get_function_at, get_comments
      decompile.py          181   decompile (pool), cache, tokens, cancel_decompile, decompile_for_edit
      edits.py              144   rename_symbol, create_label, set_comment, create_function, set_function_signature, define_data, clear_code
      highvars.py           117   rename_variable, retype_variable, auto_create_structure
      search.py             283   search_symbols, list_symbols, list_strings, search_memory, cancel_search, snapshots
      xrefs.py               90   xrefs_to, xrefs_to_variable, xrefs_from
      datatypes.py          354   list_data_types + the data type manager RPCs
  testlib.py (Proc, Client, run, constants), conftest.py (env, bproc), test_{program,project,listing,search,xrefs,edits,decompile,highvars,datatypes,persist,server,keys,methods,smoke}.py
```
**Line counts:** `sidecar/main.py` 2243 -> 62; the code now lives in 20 files of 25-372 lines (largest: `program.py` 372, `datatypes.py` 354). `class Sidecar` is gone. `test_backend.py` (1112 lines) became 8 `test_<domain>.py` files plus `testlib.py` and `conftest.py`.

**Design as built**
- One `@rpc` per method in its domain module; lanes `R`, `R`+`job=True`, `scan`, `decomp`, `project` (+`busy_ok` for `list_languages`), `loop`, `open`. The dispatcher reproduces the old `handle()` (NoProgram fast-fail during an open, unique-id checks, error mapping, no reply for notifications); duplicate names raise at startup. `test_methods.py` holds the method table as a golden dict and checks every `protocol.ts` method is registered.
- Domains are classes taking `ctx` (session, lanes, events, project, notify/progress). Cache invalidation goes through `events.subscribe` (decompile cache, search snapshots); the program swap calls `events.reset()`. Cross-domain calls: `highvars -> decompile.decompile_for_edit` and `program -> project` (key helpers, `ctx.project`); both are written down in ARCHITECTURE.md.
- Thread affinity unchanged; `DecompInterface` is still created and disposed on its pool thread. The "why" comments moved with the code.
- `packaging/prepare.sh` copies `sidecar/ghidrette/` (without `__pycache__`).

**Adding an RPC, dry run** (`get_bytes {address, length}` on the listing domain). Touches: `sidecar/ghidrette/domains/listing.py` (one `@rpc(lane="R")` method), `protocol.md`, `protocol.ts`, `app/mock/server.mjs`, `sidecar/test_methods.py` (one golden line), `sidecar/test_listing.py`. Nothing in `core/`, `app.py`, `main.py`. Before: `sidecar/main.py` plus the same other files, and the `R_METHODS` tuple.

**Tests (same checks as the step 0 baseline on `main`)**
- pytest: 45 passed on `main` (296 s) -> 47 passed (+2 from `test_methods.py`), 423 s. Slower because the shared `env` fixture is now module-scoped per test file (one more analysis of `/bin/ls` per file) so each file is independent of the others' state.
- `npm test`: 31 pass before and after. `MOCK=1 AUTOTEST=/bin/ls npm start`: ok. `AUTOTEST=/bin/ls npm start` (real sidecar): ok, `errors: []`, all `*Ok` flags true; phase 2 (`AUTOTEST_PHASE=2`, same projects dir) ok. Every step commit ran `test_methods.py`, `test_keys.py` and the pytest files of the moved domain; `test_backend.py` + `test_datatypes.py` ran after step 4, the full suite after steps 5-6 and again after the test split.
- Latency (bench/bench_sidecar.py on `/bin/ls`, pre-refactor commit vs this branch, back to back, same machine): listing 100 rows random median 3.41 -> 3.72 ms, p95 4.89 -> 5.01 ms; backward 3.53 -> 3.74 / 4.25 -> 4.38; listing during a decompile 4.91 -> 4.44 / p95 23.9 -> 12.4; cold decompile median 3.92 -> 3.35; first open 9.89 -> 9.86 s, persisted reopen 1.59 -> 1.45 s. Within noise.
- Packaging: the staged copy (`main.py` + `ghidrette/`, no `__pycache__`, run with `-I` from `/`) imports `ghidrette.app` and `ghidrette.domains.listing`, and the staged `main.py` prints the port line and exits 0 on stdin close.

**Not tested**: the built dmg (`npm run dist` not run: needs network for python-build-standalone; only the staged copy was checked with the dev venv's Python, not the bundled one); a real signed/packaged launch; `bench/bench_open.py`, `bench_navfind.py`, `bench_probe.py` (they spawn `sidecar/main.py` unchanged but were not run); the renderer was not changed. One mock autotest run (of three) printed `ok:false` with `focusRestored:false` / `cancelClicked:false`; the mock does not touch the sidecar, a rerun was clean. Treated as the known focus flakiness of the autotest window, not investigated.

**Deviations from the brief**
- Commits: xrefs and search share one commit (my commit script failed once and I did not split it afterwards); the program move, `class Sidecar` deletion and the thin `main.py` (steps 5 and 6) are one commit. Steps 3-4 used a temporary forwarding block on `Sidecar`, gone since then. Constants moved with their domains, not in a separate step. `core/context.py` is new (the context object); `notify/progress` live on it, `server.py` owns the socket and shutdown.
- `Events.detach()` swallows a `removeListener` failure. Before, only `_close` did; the failure path of `_do_open` did not.
- Tests: `test_list_and_delete_programs` stays in `test_program.py` after the raw-import test because it counts that test's imports in the shared `bproc` sidecar; `test_pool_concurrent_and_cancel` stays behind `test_edits_undo_redo_and_cache` in `test_decompile.py` (see below).

**Found, not fixed**
- `test_pool_concurrent_and_cancel` asserts "pool of 2 beats sequential" and fails on a cold sidecar (measured 0.64 s concurrent vs 0.43 s sequential in a fresh test file): the first decompile per worker pays `DecompInterface` creation. It only passes after other tests warmed both workers. `test_bad_arguments` likewise assumes earlier tests left nothing undoable.
- `shutdown` cancels the running decompile Jobs without `mon_lock` (the second loop takes it); a benign race with the monitor hand-over.
- `open_binary` sets `self.open_secs` and nothing reads it. `import pyghidra` in `main.py` and `CategoryPath` in `highvars.auto_create_structure` are unused.
- `INVALID_JAVA` contains `CancelledException`, so a Java cancellation inside an edit is reported as InvalidArgument, not Cancelled.
- `Events.reset()` (like the old `_close`) leaves the coalescer's `armed` flag as it is (already noted in Round 3).

**Next conflict hotspots (out of scope here)**: `protocol.md` and `protocol.ts` (one file each, every feature adds to them), the mock `app/mock/server.mjs`, and the renderer's `App.tsx` and `autotest*.ts`.

**Rebased onto `main` 57dd24b** (two audit commits touched `sidecar/main.py`): their changes were re-applied in the modules, not merged textually: recovery snapshots (`program.py`), `_consume`/`_not_corruption` (`program.py`), `list_data_types` on the scan lane (`datatypes.py`, golden table updated), uncached string filter (`search.py`), local range in `define_data` (`edits.py`), the dirty flag after recovery (`program.py`). The intermediate step commits between `main` and the port commit do not contain these; only the tip does. pytest at the tip: 48 passed, 1 failed (`test_snapshot_survives_sigkill`), which also fails on plain `main` in this environment (no recovery snapshot is found after SIGKILL; not investigated). `npm test`/autotests were not rerun after the rebase.

**Rebased again onto `main` f3e9ad9** (round 8 listing completeness changed `sidecar/main.py`): re-applied in the modules too: `hx`/`akey`/`ref_kind` in `core/args.py`, `Session.addr/fmtr/fmt/rng` (space-qualified, unsigned addresses), `events.py` ranges are `(space, start, end)`, the decompile cache clears on non-default-space ranges, `listing.py` has the rich rows. Round 8's `test_listing.py` runs the methods in-process through a small shim over `App(start=False).domains`; the old `test_listing.py` (function reads) is now `test_function_reads.py`. Full pytest: 52 passed, 1 failed (`test_snapshot_survives_sigkill`, also failing on `main` here).

## Round 9: hardening (unfinished: see "Not done")
Branch `claude/ghidrette-spike-stabilization-eb0907`, rebased on main after the module split (round 6) and rounds 7/8.

**Fixed (each with a test that fails on the old code, `sidecar/test_hardening.py`)**
- `open_binary`: one end state for every failure, no program open (protocol.md). Also the file/option checks now run after the old program is closed. `close()`: the coalescer's armed flag is reset, no `program_changed` after `close_program`.
- `clear_code` on a range inside one defined unit was refused ("no instructions or defined data"); units overlapping the range are now widened to whole units. **Not reproduced (checked again on the merged code and on the original commit):** the reported loss of instructions of the function at 0x100000812 after clearing the Mach-O header. On the original code the call was refused and nothing changed; now only the header unit goes, all 23,462 rows of the code section and all 136 functions are identical, the function decompiles, and undo restores the header. `test_hardening.py` pins this. The fix above is the adjacent bug I found; the autotest clears the string at 0x100000028 and the program stays intact, but I cannot say the reported loss is gone.
- Stale page read (`list_symbols` meeting a symbol an edit deleted): retried once on a fresh snapshot, then `Cancelled` ("program changed while reading, retry"). **Not reproduced** from outside (180 symbol page reads next to 320 label creates and undos: no error); covered by a unit test of `retry_stale` only.
- `test_pool_concurrent_and_cancel` asserts behaviour (a tiny decompile queued behind the biggest one is answered first), no wall-clock.

**Java helper** (`sidecar/jscans/GhidretteScans.java`, `core/jscans.py`): the defined-string scan and the symbol kind filter/sort run in Java; only results cross into Python, the GIL is released. Gotchas: a directory named `java` next to `main.py` shadows JPype's `java` package; `Symbol[]` return types fail (use `List`); Ghidra classes are not on the app class path (load through a `URLClassLoader` whose parent is Ghidra's loader). `packaging/prepare.sh` compiles it into the bundle: **not run**.

**Tests added:** cancel of a running `search_memory` (5.7M matches), `Timeout` of decompile / `rename_variable` / `retype_variable` on a >30 KB function, size warning + "Decompile anyway" + `Timeout` in the UI (`sidecar/test_big.py`, `test_ui.py`, `AUTOTEST_FLOW=big|locked`; the big ones skip unless the stored fast analysis of llvm-exegesis exists), strings panel refresh after a real edit, ProjectLocked message, default-Fast for a >20 MB file.

**Numbers: llvm-exegesis 66.7 MB, quiet machine (`bench/common.py: wait_quiet`), 3 repeats, measured BEFORE the rebase on main** (`bench/results_round9/prerebase/`, not committed)
| | before (round 5) | now, 3 runs |
|---|---|---|
| first strings scan | 14-20 s | 7.3 / 7.5 / 7.6 s |
| listing p95 while it runs | 183 ms | 17.9 / 18.6 / 18.7 ms (target < 30) |
| kind filter / sort, cold | ~4 s | 0.13-0.30 s |
| listing p95 during 50 decompiles | - | 15.6 / 16.9 / 16.0 ms |
| first open, fast profile | - | 557 / 560 s (2 runs) |
| JVM peak, fast profile | 4.1 GB (round 4) | 3.71 / 4.04 GB (2 runs) + 3.59 GB (a third, separate run) |
Navfind run 1 started with two leftover electron-vite processes on the machine; runs 2 and 3 started with none. The 4.1 vs 3.5 GB question is **not answered**: the full-profile peak was not re-measured, and fast varies by ~0.4 GB between identical runs.

**Not done**
- Benchmarks after the rebase, the full-profile first open, and the `BENCH=1` app run x3: the chain was stopped (another session kept the load at 7, the quiet gate waited 16 min). `bench/run_round9*.sh` run them.
- The final full run (pytest, npm test, typecheck, autotest mock + real, `AUTOTEST_PHASE=2`) on the final commit was not done. Only the typecheck and `test_big/hardening/search/program/server` (22 tests) were run after the rebase.
- **Needs a person:** `MANUAL_TEST.md` (nothing in it has been run).
## Round 8 (second part): unsigned addresses everywhere, all spaces, xrefs for every decompiler variable
Branch `claude/round8-addresses-xrefs-ee9989` (asked for as `round8/addresses-xrefs`), rebased onto `main` 1179760 (Round 6 modules merged). **Overlap with the listing round above:** that round (merged to `main` before this one started) had already done most of steps 2-4 (address format in the contract, `Session.addr/fmtr`, unsigned offsets, `listing_info`/`listing_rows` over all spaces, `addrmap.ts`/`address.ts`/`parseGoto.ts`). I did not redo them; I audited every address site, wrote the step 1 tests against the finished code, and fixed what they and the audit found. Not pushed, not merged; `prompts/` untouched.

**Address format** (unchanged, `protocol.md` line 9): default space `"0x401000"` (lowercase unsigned hex), other spaces `"code:1000"`, overlays `"OVL1::1000"`, split at the last `:`. One helper per side: sidecar `Session.addr` / `Session.fmtr` (+ `hx`, `akey` in `core/args.py`), renderer `address.ts` (`parseAddr`, `fmtAddr`, `addrAdd`, `intersects`, new `offIn`).

**Address sites** (audit by grep for `getOffset`, `hx(`, `int(…, 16)`, `isMemoryAddress`, `BigInt`, `Number(`, `parseInt`)
- Sidecar, already unsigned/space-aware: `session.py` (`addr`, `fmtr`, `rng`), `args.py` (`hx`, `akey`), `events.py` (ranges are `(space, first, last)`), `program.py:158-165` (base address limit masked), `edits.py:124-126` (define_data range clamp, masked), `search.py:95-119` (symbols/strings/search addresses via `fmtr`, sort key masked), `listing.py` (rows, info, refs via `fmtr`).
- Sidecar, **changed here:** `listing.list_functions` (skipped every non-default space and sorted by masked offset; now every space, Ghidra's address order, qualified entries), `decompile.py` (cache key was the default-space offset and any non-default range cleared everything; now `(space, offset)` and per-space ranges), `decompile._tokens` (`varAddress`), dead import cleanup in `listing.py`, outdated docstring in `events.py`.
- Renderer, **changed:** `changes.ts` (`BigInt(entry)` on function entries and range ends: would throw `SyntaxError` on `"OVL1::1000"` now that `list_functions` returns qualified entries; now `parseAddr`/`offIn`, space-aware, linear scan instead of a sort-order binary search), `symbols.ts` (`BigInt(address)`; also its one-entry function cache was **never filled**: `(f ? {...} : null);` was an expression statement, so every listing click cost a `get_function_at`; fixed, space-aware), `editActions.ts`, `XrefPanel.tsx`, `Decompiler.tsx`, `App.tsx`.
- Renderer, already fine: `address.ts`, `addrmap.ts` (BigInt starts, `Number` only for scroll positions), `rowcache.ts`, `parseGoto.ts`, `openOptions.ts`, `Listing.tsx`. `dtTree.ts:32 hex(n: number)` is for data type sizes/offsets, not addresses. Bench scripts (`bench.py`, `common.py`) still use `getOffset()` for sampling only (not changed).

**Built**
1. **Globals.** `Token.varAddress` on variable/param tokens whose high symbol is a global (or whose varnode lives in memory): the global's memory address, in the protocol address format. The destination of a store (`g = …`) needs the symbol: its varnode is the register holding the value. X on such a token opens `xrefs_to` at that address (the panel label is the variable's name). On `/bin/ls` the first match is `DAT_100005584` in `entry` (13 references, panel rows = `xrefs_to` count, checked in the autotest).
2. **Temporaries: `variable_uses {entry, name}`** (new method, not a fallback inside `xrefs_to_variable`). Why: it runs a decompile, so it must be a decompiler-lane request (unique id, `cancel_decompile`, Timeout/Cancelled like `decompile`), while `xrefs_to_variable` is a cheap thread-R read; a lane is per method, so folding one into the other would put the cheap path behind the decompiler queue. The client calls `xrefs_to_variable` first and `variable_uses` only when it returns `[]`. Result `[{from, type, kind: "write"|"read", function}]`: each `HighVariable` instance's defining op is a write, each descendant op a read, at the op's instruction address, `type` is the p-code mnemonic; phi (MULTIEQUAL) and INDIRECT ops are skipped, a parameter's implicit definition at entry is not a write. **Cache:** the uses of every local of the function are computed from one decompile and stored in the decompile cache under `(space, entry, "uses")` with the same invalidation, so a second variable is a hit (the HighFunction is not kept). `decompile` and `variable_uses` share one `_run` (worker, cancel, timeout, cache).
3. **Renderer.** The xrefs panel shows the uses with their kind; clicking one navigates the listing (`go(addr, "xrefs")`) and the decompiler highlights the token(s) of that variable at that instruction address (`.use-token`, scrolled into view once). The highlight stays until another use is clicked, the panel is unpinned or another X is pressed (not cleared on ordinary navigation). The panel's `variable_uses` request is cancelled when the target changes.
4. **Function list and decompile over all spaces** (leftover of the listing round, see its "Not done"): functions in overlays are listed with qualified entries and decompile; the decompile cache invalidates by `(space, range)` instead of clearing everything for any non-default range.
5. **`create_function` disassembles undefined bytes first** (found by the raw-blob wire test: on a raw import `create_function` made a one-byte function, so nothing decompiled; Ghidra's Create Function action disassembles first). Same transaction, same undo step.

**Tests**
- `sidecar/test_addresses.py` (new; in-process on a hand-built x86-64 program, helpers moved to `sidecar/inproc.py` and a session `sc` fixture in `conftest.py`): a blob at `0xffffffff80000000` plus an overlay block with code and cross-space references in both directions: `listing_info`/`listing_rows` (last byte, no wrap), `list_functions`, `get_function_at` (also inside the overlay), `xrefs_to`/`xrefs_from` in both directions across spaces, `list_symbols`, `search_symbols`, `list_strings`, `search_memory` (text, bytes, overlay, resume at an unsigned `start`), `decompile` token addresses (none negative), `varAddress` on every token of the global (also the store target), `xrefs_to` the global, `variable_uses` exact (`lVar1`: write `CALL` at +0x11, read `INT_MULT` at +0x16), cache hit, overlay function decompile, cache invalidation by an overlay comment. Plus one end-to-end test through the real **raw-blob import and WebSocket** (`open_binary {loader: "Raw Binary", language, baseAddress: 0xffffffff80000000}`): range, last row, functions, xrefs, memory search, decompile, `varAddress`, `variable_uses`, `NotFound` and the out-of-range `InvalidArgument`. `test_methods.py` has the new method's lane (`decomp`).
- `npm test`: 45 pass (3 new: global token target, qualified/high function entries in `changes.ts`, `offIn`; earlier tests already cover `AddrMap` above 2^63 and multi-space range maps). `npm run typecheck` clean.
- Autotest, new step (`autotestAddr.ts`, `AUTOTEST_ONLY=addr` for it alone): X on a global token, X on a temporary (kinds write and read both shown, count equals `variable_uses`), click a use: listing at that address and the highlighted token, then (real sidecar) the same file imported as a raw x86-64 blob at `0xffffffff80000000` through the import dialog, Go to Address `0xffffffff80000100` shows exactly that row. Full runs: mock passed, real `/bin/ls` passed (fresh projects dir). The mock now emits variable tokens, a global (`g_state`) and `variable_uses`; the edit/auto-struct flows skip the mock explicitly (`isMock`: the old skip keyed on "no variable tokens").
- Test counts: pytest before (step 0, on `main` plus my first edits, run while I was editing): 52 passed, 1 failed (`test_snapshot_survives_sigkill`, fails on untouched `main` too); after: 56 passed, 2 failed: the same one, and `test_decompile.py::test_pool_concurrent_and_cancel`, a timing assertion known to fail under load (Round 5) that passes alone (`test_decompile.py`: 2 passed). `npm test` 42 before, 45 after. Autotest before: not run separately (the baseline was the unchanged flows); after: mock and real `/bin/ls` passed, `AUTOTEST_PHASE=2` not re-run

**Measured** (`bench/bench_sidecar.py`, `LISTING_ONLY=1`, `/bin/ls`, fresh import; baseline = `main` 1179760 in a scratch worktree, same machine, one run each)
| Listing, 100 rows | before (main) | after |
|---|---|---|
| 300 random fetches | median 4.79 ms, p95 11.97, max 68.2 | median 4.43 ms, p95 11.52, max 57.3 |
| 100 backward fetches | median 4.43 ms, p95 7.78, max 15.5 | median 4.55 ms, p95 7.78, max 16.5 |
Within noise. I did **not** measure decompile latency: `_tokens` now calls `getHighSymbol` for every variable token (one more JNI call per token).

**Follow-up pass (the items the first pass left open)**
- **Segmented addresses** (x86 real mode, `x86:LE:16:Real Mode`; built by hand, no DOS/MZ file): `Session.addr` now takes `1000:0042` when the default space is segmented (via `AddressFactory.getAddress`); output stays the linear `0x10042`, which round-trips. `test_segmented_real_mode`: both forms name the same byte, bad forms are `InvalidArgument`, function, `get_function_at`, `listing_rows`, `xrefs_from`/`xrefs_to`. The `shortcut:` comment is gone. A real MZ binary through the DOS loader is still untested.
- **AArch64** blob at `0xffffffff80000000` (`test_aarch64_blob_above_2_63`): functions, `bl` xref kind `call`, `get_function_at`, decompile token addresses and call target.
- **Decompile latency** (`bench_sidecar.py`, full, `/bin/ls`, same machine, `main` vs this branch, one run each): 50 cold decompiles while listing: median 5.9 -> 4.6 ms, p95 108 -> 90; 50 largest: median 3.9 -> 2.6, p95 144 -> 136; listing 100 rows random: median 6.0 -> 4.7, p95 19.2 -> 12.2 (the "before" run was noisier than the listing-only one above). No slowdown from `varAddress`; `/bin/ls` functions are small (largest 2.9 KB), so a very large function was not measured.
- **Cancel of `variable_uses`**: wire test (send, `cancel_decompile` at once: `Cancelled` or the normal answer, then an identical later call returns the same uses). It does not prove a cancel of a long-running decompile.
- **`AUTOTEST_PHASE=2`** on the full real run's projects dir: passed.
- Pytest after the additions: `test_addresses.py` 7 tests, all pass.

**Still not tested**
- A real DOS/MZ binary; overlay functions in the UI against the real sidecar (the UI cannot create overlay blocks, only the mock and in-process tests have them).
- The raw-blob autotest step imports `/bin/ls` bytes as x86-64 (address round trip and Go to Address only, no code).
- `variable_uses` timing on very large functions; cancel of a long-running one.

**Found, not fixed**
- `variable_uses` lists the decompiler's view: a temporary that Ghidra merged or split differently than the C text suggests (8-byte locals splitting into several variables) shows only the uses of the variable whose name was clicked. Struct field uses ("find uses of field") are out of scope. Globals show only references Ghidra recorded (`xrefs_to`), not decompiler-only accesses.
- `test_persist.py::test_snapshot_survives_sigkill` fails identically on untouched `main` (see the listing round); not from this work.
- No "disassemble" RPC: `create_function` is the only way to get code from undefined bytes in the UI.
- Register-space and stack-space listing remain out of scope (`listing_info` lists loaded initialized memory only).

**Rebased onto `main` 6804792** (round 9 hardening, coverage, command bar, Java scan helper). Conflicts: `list_functions` (kept main's `source` field and `load_coverage`, all-spaces body), `protocol.md`, mock and autotest imports, the report. Fixes the merge needed: the in-process harness now builds `GhidretteScans` before the JVM starts; `coverage.ts` threw on qualified (overlay) listing rows (`BigInt("OVL1::1000")`), now such rows are never covered (`shortcut:` comment, test); the autotest still looked for the aria-label `Symbol name`, which main's command bar commit renamed to `Symbol or action` (the autotest failed at "search panel" on untouched `main` too). After the rebase: pytest 64 passed, 3 skipped, 2 failed (before the harness fix: `test_xrefs_symbols_strings_search`, fixed; `test_snapshot_survives_sigkill` fails on `main` too), `npm test` 52 pass, autotest mock and real `/bin/ls` pass, `AUTOTEST_PHASE=2` passes. Coverage files stay default-space only (`load_coverage` formats with `hx`).

## Round 7: first open as fast as Ghidra itself, analysis in the background

Branch `round7/background-analysis`, rebased onto `main` 3b2a908 (rounds 6, 8, 9). Not merged, not pushed. **Open:** on the 66.7 MB llvm-exegesis the background analysis is ~25% slower than `analyzeHeadless` (fast profile, no benchmark traffic, 3 interleaved runs), so the "within ~10%" goal is met on `mysqldump` and missed on the big binary, remaining cause not isolated; llvm-exegesis full was not measured. Details under "Not done".

### Step 0: the baseline found a 2x bug
`analyzeHeadless` (same Ghidra build, `GHIDRA_HEADLESS_MAXMEM=16384m` = the sidecar's default `-Xmx`; the script's own default is 2 GB and `-XX:ParallelGCThreads=2`) against Ghidrette's `open_binary` as it was on `main`, `mysqldump` (6.95 MB), taken while the machine was quiet (`bench/results_round7_before_*`):

| mysqldump | analyzeHeadless | Ghidrette before | 
|---|---|---|
| full | 36.9 s (JVM 1.0 GB, native 475 MB) | 76.9 s (JVM 1.9 GB, native 432 MB) |
| fast (3 analyzers off) | 28.7 s | 66.8 s |

Ghidra's per-analyzer times (stderr logs) show the whole gap in two lines: `Create Address Tables` 18.8 s (+19.8 s "One Time") against 0.29 s (+0.39 s); `Variadic Function Signature Override` and `Stack` were 10-80% slower, everything else equal. Cause: `PyGhidraTaskMonitor` calls into Python on **every** `setProgress`/`setMessage`, and that analyzer reports progress per candidate; `analyzeHeadless` passes `TaskMonitor.DUMMY`. The other suspects were not the cause or not needed: the one big "Analysis" transaction is what `analyzeHeadless` does too (`HeadlessAnalyzer.analyzeProgram`), same call sequence (`initializeOptions`, `reAnalyzeAll(null)`, `startAnalysis`), same heap in the comparison. **Fix:** the monitor is Ghidra's own `BasicTaskMonitor` (package-private, built by reflection; it stores message/progress/max and cancels, no callbacks) and a Python thread reads it every 50 ms (`domains/analysis.py Poller`). Side effect: the analyzer name is only seen when a poll lands between an analyzer's `setMessage(name)` and its own next message, so `done` undercounts fast analyzers (documented in `protocol.ts`).

### Step 1: what Ghidra does (read in the checkout, not changed)
- **How the GUI runs analysis:** `AutoAnalysisManager.startBackgroundAnalysis` schedules an `AnalysisBackgroundCommand` through the tool; `BackgroundCommandTask.run` opens ONE transaction `"Auto Analysis"` on the program for the whole run, `startAnalysis` loops over the priority queue on that thread, `flushPrivateEventQueue` after each task. `scheduleOneTimeAnalysis(analyzer, set)` is the "one shot" command; I use it for fast to full (only the 3 skipped analyzers over the loaded memory).
- **Are reads on R safe while analysis writes?** Yes. Database access is guarded per operation by the program lock (`ghidra.util.Lock` is a `ReentrantReadWriteLock`), not by the transaction; the analysis holds the transaction open, not the lock. Measured: listing reads median 9.5-10.9 ms, decompiles median 2-3 ms with 0 failures on `mysqldump` while it analyzed (table below).
- **Undo and edits:** `DomainObjectTransactionManager.startTransaction` does not wait when a transaction is open, it **joins** it (`transaction.addEntry`). So an edit during analysis would be part of the analysis transaction: not undoable alone, and an edit that rolls back (`endTransaction(commit=false)`) marks the whole transaction terminated and aborts the analysis. `canUndo()` is false while a transaction is open, and the GUI disables edits while a task runs. **Decision: the same.** Edits, `undo` and `redo` fail `Busy` ("analysis running"); the analysis never lands on the undo stack (`clearUndo` after it). Checked in `Session.edit()` after argument validation, so a malformed edit still reports InvalidArgument first (`test_analysis.py` uses a valid request).
- **Events:** `DomainObjectChangeSupport` queues change records and delivers them in batches on a timer that restarts when new records arrive. I did **not** count Ghidra's `DomainObjectChangedEvent`s per analysis. What the sidecar sees: with the listener attached during analysis, parsing every record from Python would be millions of JPype calls, so `Events.bulk` skips parsing, announces "everything changed" and emits `program_changed` at most about once per second (17-34 per 28-56 s `mysqldump` run, 490 in the 12 min llvm-exegesis fast run).

### Design (protocol.md "Analysis", protocol.ts, mock first)
`open_binary` gets `analysis: "background" | "blocking"` (default background) and returns `analysis: AnalysisState` right after the import is saved and published; new `analysis_status`, `start_analysis {profile?}`, `cancel_analysis`, notification `analysis_state`. `programs.json` records `analysis: none|partial|done` and `analysisProfile`; list_programs shows both. Persistence key and `test_keys.py` are unchanged; fast to full keeps the `programId`. `save`, `close_program` and shutdown cancel the analysis first (the analysis thread saves what it found, never waits for R), leaving `partial`; opening a `partial`/`none` program resumes it. Resume = Ghidra's re-analyze command over everything (finished regions are cheap, not free; the analyzer queue is not persisted). Blocking mode keeps the old semantics (progress events, `cancel_open` discards everything) on the same engine.

### After (`bench/bench_background.py`, `bench/bench_headless.py`; results `bench/results_round7_*`)
Every Ghidrette run includes the benchmark's own load: a random `listing_rows` every 100 ms and decompiles back to back (so the totals below are conservative against `analyzeHeadless`, which has no such traffic). Pairs ran back to back; the load snapshot before each run is in `results_round7_quiet_check.log.txt`. **The machine was not quiet** (other sessions' sidecars, Electron apps and benchmarks, load average 8-12, up to 32 after a gap; an orphaned native `decompile` of mine used one core until it was killed during the second pair). Treat absolute times as noisy.

| | analyzeHeadless | Ghidrette background | first rows / first decompile | listing during analysis (median / p95 / max) | peak JVM / native |
|---|---|---|---|---|---|
| mysqldump full, run 1 | 47.4 s | 43.8 s | 3.5 s / 7.7 s | 10.9 / 62.7 / 365 ms | 1.4 GB / 719 MB |
| mysqldump full, run 2 | 45.3 s | 55.8 s | 4.3 s / 8.5 s | 10.7 / 62.7 / 288 ms | 1.2 GB / 714 MB |
| mysqldump fast | 31.0 s | 27.8 s | 3.4 s / 7.3 s | 10.1 / 81.8 / 193 ms | 1.3 GB / 509 MB |
| mysqldump full, 4 cores | | 37.7 s | 3.1 s / 6.4 s | 9.5 / 50.6 / 370 ms | 1.0 GB / 524 MB |
| llvm-exegesis fast (66.7 MB) | 444.8 s (JVM 6.5 GB, native 26 MB) | **735.4 s** | 13.7 s / 15.1 s | 22.7 / **143.7** / **16,752** ms | 1.8 GB / 145 MB |

Decompile during analysis (same runs): `mysqldump` median 2-3 ms, p95 5-10 ms, max 3-6 s, 0 failed of 2.5-3.8k; llvm-exegesis fast median 2.7 ms, p95 12.8 ms, max 9.4 s, 53 of 108,574 failed (the benchmark's 10 s timeout). Listing after the analysis (same box): median 4.5-6 ms, p95 14-17 ms. Function list while it runs: llvm-exegesis 440 at open, 48,833 at the end.

Against the goals:
- *Usable within ~10 s of import:* `mysqldump` yes (first rows 3.5 s after the request). llvm-exegesis: no, 13.7 s, but 13.5 s of that is the import itself (`open_binary` replies after import and save); the first decompile follows 1.4 s later.
- *Total analysis within ~10% of analyzeHeadless:* `mysqldump` yes on the averages (full 49.8 s against 46.4 s, +7%; fast 27.8 against 31.0), single noisy runs, with benchmark traffic running. **llvm-exegesis fast: no.** With the benchmark's traffic: 735 s against 445 s (+65%). Without it (`--no-load`, three runs interleaved with `analyzeHeadless`, load average 5-8, `results_round7_noload_*`): Ghidrette 488 / 508 / 473 s (median 488) against 375 / 392 / 405 s (median 392), **+25%**. So about half of the loaded gap was the benchmark's own traffic; the rest is not explained. Not tested hypotheses: the change listener (one Python upcall per Ghidra event batch, 319-345 `program_changed` per run, none in `analyzeHeadless`), JVM flags (`analyzeHeadless` runs `-XX:ParallelGCThreads=2 -XX:CICompilerCount=2`, ours the defaults), the GIL while the poll thread runs. Peak JVM was lower in the sidecar (2.9-3.2 GB against 6.7-7.7 GB; first rows 12.4-12.9 s, first decompile 13.7-14.3 s, of which the import is ~12 s).
- *Listing p95 under 100 ms while analysis runs:* `mysqldump` yes (51-82 ms). llvm-exegesis no (143.7 ms p95; one 16.8 s stall, cause not found).
- *Decompiler memory cap:* `SIDECAR_ANALYSIS_CORES` sets `-Dcpu.core.limit` (Ghidra's thread pools, hence the native decompiler processes). One `mysqldump` run with 4 cores: 37.7 s, native peak 524 MB, against 43.8/55.8 s and 719/714 MB uncapped: suggestive, a single run, not a result. Not measured on llvm-exegesis; no default is set.

### Tested
- `sidecar/test_analysis.py` (5 tests, /bin/ls and a raw blob): background open replies while the analysis runs and reads work meanwhile; edit, undo, redo and a second `start_analysis` are Busy meanwhile; `analysis_state` events, function count grows, record becomes `done`; edits work again afterwards and undo touches only the edit; cancel leaves `partial`, an edit after cancel is undoable alone; a new sidecar resumes a `partial` program and a third finds it idle/done; `save` cancels the analysis; `close_program` during analysis leaves `partial`; shutdown during analysis exits within 15 s, leaves `partial` in `programs.json` and releases the project lock; fast then full keeps the `programId` and the project has one program; raw blob in background mode.
- Sidecar suite after the last rebase (main 3a8c9ae-plus): 86 passed, 3 skipped, 2 failed, both test setup, fixed and re-run (17 passed in those two files): `test_highvars.py` opened with the new default (background) and then edited; `test_runtime.py` built a fake context without `analysis`. The older tests ask for `analysis: "blocking"` (`testlib.Client` default; `test_smoke.py` explicitly). One earlier run had `test_edits.py::test_get_comments_and_create_label` fail once; it passed alone and in its file.
- `npm test` 66/66 (new `analysis.test.mjs`: label, action, refresh policy while running). The Round 7 flow (background open, listing rows and status bar indicator while running, Cancel, Resume, function list grows, browser "Run full analysis") passes on the mock and on the real sidecar (`/bin/ls`, background open 178 ms, functions 85 to 136) as `AUTOTEST_FLOW=analysis`; the whole real-sidecar autotest passed with it before the last rebase. **The whole mock autotest fails at "timeout waiting for import dialog" on `main` itself (3a8c9ae) and on this branch**, so it was not usable as a gate; not investigated.
- Not tested: llvm-exegesis through the UI; the program browser's Resume button (code only; "Run full analysis" is clicked in the autotest, passes on mock and real sidecar); a visual check of the status bar (no screenshot taken).

### Found, not fixed
- The remaining ~25% on llvm-exegesis and the 16.8 s listing stall in the loaded run (not seen as a measurement without traffic, since `--no-load` has no listing probe).
- Ctrl/Cmd+S during analysis cancels the analysis (the brief asks for save to cancel; a plain "save later" would be friendlier).
- A crash during analysis loses that run's work (the transaction is in memory); the record says `partial` and the next open starts again. No periodic checkpoint.
- Resume redoes every analyzer; fast to full only runs three analyzers, but that path was only tested on /bin/ls.
- The client refetches the whole function list about once a second while analysis runs (48,833 entries on llvm-exegesis); upgrade: a delta.
- `BasicTaskMonitor` is built by reflection and its fields are not volatile (Ghidra's own `TaskRunner` uses it the same way).
- `done` in `analysis_state` undercounts (poll), `pct` is the current analyzer's only.
- Validation errors win over Busy for edits.
- `bench_background.py` and `bench_headless.py` do not use main's "wait for a quiet machine" check, the machine never became quiet for it.

### Not done
llvm-exegesis full: neither `analyzeHeadless` (killed after ~26 min on request) nor Ghidrette background; what causes the remaining ~25% on llvm-exegesis (try: no listener during analysis, `analyzeHeadless`'s JVM flags); any llvm-exegesis memory-cap measurement; repeats beyond two for `mysqldump`; the "Found" items above.

## Round 10: renderer architecture (no behavior change)

Branch `claude/ghidrette-renderer-architecture-v2`, on `main` 36ea9da. Goal: mirror `sidecar/ARCHITECTURE.md` in `app/src/renderer/`; no feature, protocol or visual change. Layout and rules: [app/ARCHITECTURE.md](app/ARCHITECTURE.md).

**What was already there.** While this round was in progress `main` gained its own provider boundary (`ApplicationBackend`, `rpc.ts`'s `WebSocketBackend`, `wire.ts` payload checks, capabilities, session ids, `test/backend-boundary.test.mjs`). That is the renderer's `data/` layer, so the first plan (a `data/` module per domain over a global `rpc()`) was dropped, and a first attempt on the old `rpc()` code was not rebased (it conflicted in meaning, not only in text). The scripted modes were already a separate chunk (`import()` in `main.tsx`).

**Before.** `App.tsx` 608 lines / 43,258 B: about 45 `useState`/`useRef`, the open/close/cancel flow, `program_changed` handling, editing, menu routing, window handlers, three dialogs, panes and the welcome pane in one component; `autotest*.ts` mixed with the components.

**After.**
- `store/`: `createStore` (reducer + `useSyncExternalStore`, no dependency); `program.ts` (reducer for the active program and the open lifecycle); `views.ts` (reducer for positions, panels, dialogs); `session.ts` (`createSession(backend)`: open, cancel, close, save, undo, `program_changed`, `onReset` / `onChanged`; context and hooks).
- `features/`: navigation, editing, dialogs (+ `DialogHost`), menu, coverage, exports, reactions, bootstrap.
- Components: `Workbench`, `WelcomePane`, `Shell` (toolbar, bars, dock, status bar, type manager); `autotest*.ts` moved to `autotest/`.
- `App.tsx` 53 lines / 2,956 B.
- Production bundle (`app/out/renderer/assets`): main chunk 9,117,067 → 9,124,755 B (+7.7 KB); the `autotest-*.js` chunk is the same 89,246 B and nothing else imports it (`test/layering.test.mjs`).
- Tests: `npm test` 74 → 86 (store reducers 5, session against an in-memory backend 5: open / replace / failed open keeps the program / second open ignored / close / save-only change / held change during an open / cancel and progress; layering 2). `npm run typecheck` clean. From one final run: real sidecar autotest on `/bin/ls` ok, `AUTOTEST_PHASE=2` ok, `sidecar/test_provider_contract.py` + `test_provider_ui.py` 7 passed (fixture, pyghidra, mock).

**Behavior kept.** Code moved, not rewritten: the open/cancel/close races, `program_changed` coalescing during an open, `goSeq` (newest navigation wins), `latest()` refetches, the `shortcut:` comments and error handling. One simplification: refs that mirrored state (`openedRef`, `openingRef`, `funcsRef`, …) are gone because the store is readable synchronously. DOM order differs only by the dialogs now being rendered last (they are modal overlays).

**Not moved / left.** `Listing.tsx` (323 lines), `Decompiler.tsx` and the autotest scripts are components or test code with their own internal state; they take the same props as before. `scrollReq` is reset with the program as before; the coverage runs stay module state (`coverage.ts`). Round 7 (background analysis) is not on this branch: it conflicts in meaning with main's session and provider contract and needs its own rework; its UI will go into `store/` and `features/` when it lands.

**Pre-existing, not from this work.** `MOCK=1 AUTOTEST=/bin/ls npm start` fails on untouched `main` 36ea9da at "timeout waiting for import dialog" (the step after the default open; at that point the second `open-path` finds an open still running and is ignored, probably because `waitFor(!dialog && opened)` is already true when the dialog closes); the result before that step is identical on both. The real-sidecar autotest and the provider UI tests cover the same flows.

## Round 11: quick wins

Branch `claude/ghidrette-five-features-2dc532`, rebased onto `main` 54264be (round 7 background analysis had landed meanwhile; the five features were re-applied on it, `export_gzf` now refuses with `Busy` while an analysis runs). One commit per feature plus one for the Busy rule. Not pushed, not merged. Changes in the files the round 7 session owns were kept to a line or two each (`Shell.tsx`: the dock props; `bootstrap.ts`, `reactions.ts`, `WelcomePane.tsx`, `store/*`: untouched).

**Built**
1. **Function ID data in the bundle** (`packaging/prepare.sh`). `Features/FunctionID/data` is 195 MB; the databases cover MSVC runtimes for Windows PE (x86/x64) only, **nothing for Linux or macOS**. Kept: vs2015, vs2017, vs2019 (x86 and x64, 93 MB) plus the two `common_symbols` files; trimmed: `vs2012_*` and `vsOlder_*` (102 MB). `trim-log.txt` lists cut files like the other cuts and the kept databases marked `(kept)`.
2. **`export_gzf {path}`** (lane R, Ghidra's `GzfExporter`, capability `exportGzf`), File > Export > Ghidra Archive (.gzf)… and the command bar. It exports the in-memory state: unsaved edits are in the archive, the program stays dirty and the stored copy is untouched (protocol.md says so). `Busy` while analysis runs. Not cancellable.
3. **`get_bytes {address, length}`** (lane R, capability `bytes`, 1..65536, `InvalidArgument` outside; any byte that is not initialized memory is `NotFound`, nothing partial). **Copy** address / bytes as hex / bytes as a C array / decompiled function from small context menus (listing row, function list, Monaco's menu), the Edit menu (`Cmd+Shift+C` address, `Cmd+Alt+C` hex) and the command bar. `Cmd+C` stays the control's own. `navigator.clipboard.writeText` first, a validated `clipboard-write` IPC (string up to 8 MiB, from our window only) as fallback. The listing row comment about "no way to fetch the rest of the bytes" is gone: `get_bytes` is it.
4. **`function_calls {entry}`** (scan lane, capability `calls`): `{callers, callees}` of `getCallingFunctions` / `getCalledFunctions`; each `{name, entry, external, thunk, target?}`, `entry` null for externals, a thunk carries the function it finally forwards to. Calls dock panel (View > Calls, `Cmd+Shift+J`, command bar) for the function at the cursor; click navigates listing and decompiler; externals are shown, not navigable.
5. **Bookmarks** (capability `bookmarks`): `list_bookmarks {type?, query?, offset, limit, sort?, desc?}` returns `{total, types[{type,count}], items}` (all types when `type` is omitted; the **panel** defaults to `Note`, the analyzers' types are one dropdown away), `set_bookmark {address, category, comment}` (type Note, one undo step "Set bookmark"), `remove_bookmark {address, type}` (all categories at that address, "Remove bookmark"). New `program_changed` kind `bookmark`: Ghidra's bookmark events carry no address, so the edits announce theirs with `events.record()` and the listener's address-less record is ignored (otherwise it forced a broad refetch). Listing rows carry `bookmarks` (Note only) and show a `▪` marker. Bookmarks dock (VirtualTable, sortable by address/type/category, filter, remove ×), Edit > Add Bookmark… (`Cmd+D`) through the existing `FormDialog`, View > Bookmarks (`Cmd+Shift+B`).

**Tested**
- Feature 1: a fresh analysis of Ghidra's `WinHelloCPP.exe` against a copy of the install trimmed exactly like the script (APFS clone, the four files removed; the script's globs were checked on stand-in file names): the `Function ID` analyzer ran (0.2 s), 16 analyzers, 296 functions, no Function ID error in stderr. It names no function here that I checked: not verified that a kept database *matched* anything. `npm run dist` **was not run** (it needs `uv` downloading python-build-standalone and the network): the `prepare.sh` change itself was never executed end to end.
- Feature 2: `/bin/ls` exported with an unsaved rename, 3 argument errors, the file non-empty, `undo_state.dirty` still true; a second sidecar imports the `.gzf` with the same function count and the renamed function. `Busy` during background analysis (added to `test_analysis.py`).
- Feature 3: `get_bytes` on `/bin/ls` (row bytes, two rows as one range, the 64 KiB cap, 6 bad lengths, unmapped, last byte and one past the end), the contract test (fixture has no such methods: `MethodNotFound`; PyGhidra has the capabilities and agrees with `listing_rows`), 5 unit tests for the C array and the decompiler cursor address, the command-bar test, and an autotest step (mock and real): copy address/hex/C array from the listing, from its context menu, the decompiled text, the decompiler address, the function list menu.
- Feature 4: in-process on the hand-built programs (known edge, overlay entries, a thunk to a memory function and a thunk to an external function) and on `/bin/ls` (a function with callers and callees, symmetric with the other side's list, sorted, `xrefs_to` agrees, NotFound/InvalidArgument); autotest step (panel counts equal the RPC, a click navigates).
- Feature 5: `/bin/ls`: add, replace, second category, filters, sorts, errors, undo ×3 and redo ×3, the `bookmark` event with the unit's range, save + close + reopen, remove and its undo; autotest step: dialog, marker, panel (sort, type filter, click navigates), undo, redo, save; `AUTOTEST_PHASE=2` finds the bookmark after the quit and relaunch.
- Counts: `npm test` 95 → 101 after the rebase (6 new: copy ×5, command bar ×1; the rebase brought round 7's), `npm run typecheck` clean after every feature. Pytest after each feature: the touched files plus `test_methods.py` and `test_provider_contract.py` passed. Full pytest run on the final code (while three Electron autotests ran on the same machine): 104 passed, 3 skipped, 2 failed (see "Found, not fixed"); both pass when run alone. A second full run on a quiet machine was started but not waited for, so there is no clean full-suite result. Autotest on the final code: `MOCK=1 AUTOTEST=/bin/ls` ok, `AUTOTEST=/bin/ls` (fresh projects dir) ok with 0 errors, `AUTOTEST_PHASE=2` ok.

**Not tested**
- Packaging (`npm run dist`), a Windows PE function actually matched by a kept Function ID database, and the bundle size after the cut.
- The clipboard IPC fallback (the autotest reads the module's `copied.last`, not the system clipboard; in Electron `navigator.clipboard` was not refused, so the fallback never ran). The Cmd+Shift+C / Cmd+Alt+C / Cmd+D / Cmd+Shift+J / Cmd+Shift+B menu accelerators were not pressed (the autotest sends the menu commands), nor was Monaco's context menu clicked (only the same `copy` route).
- `export_gzf` on a large program (the call is not cancellable and holds lane R for its duration); `function_calls` on a function with thousands of callers; bookmarks with thousands of analyzer bookmarks (a full pass per `list_bookmarks`).
- Whether `Cmd+D` collides with Monaco's own binding when the decompiler is focused (the Electron menu accelerator should win; not checked by hand).

**Shortcuts** (marked `shortcut:` in the code): `export_gzf` not cancellable; the listing has no multi-row selection, so the bytes copy is the cursor row (upgrade when a selection exists: `get_bytes` takes any range); `function_calls` has no cap and no call-site addresses; `list_bookmarks` is a full pass per call (upgrade with a snapshot cache like `list_symbols`); the Add Bookmark dialog does not prefill an existing bookmark.

**Found, not fixed**
- Listing rows mark only `Note` bookmarks; a Warning or Error bookmark shows in the panel but not in the listing.
- The Decompiler "bytes" copy does not exist (only the listing row): copying the bytes of a function from the decompiler would need its size, which the function list has.
- The worktree had no `sidecar/.venv`; I symlinked the main checkout's (ignored by git). `npm start` and pytest need it.
- Two pytest tests failed once in a full run that overlapped with three Electron autotests on the same machine (`test_edits.py::test_get_comments_and_create_label`, `test_program.py::test_open_progress`) and pass alone; they look load-sensitive, not related to this work. The known `test_snapshot_survives_sigkill` and the mock autotest's "timeout waiting for import dialog" did not fail here (so there was nothing to confirm on `main`).

## Round 12: first packaged build

Branch `claude/packaging-first-build` off `main` d283214. Machine: Apple Silicon, macOS 26, JDK 25.0.5.1, `uv` 0.13.8 (Homebrew), network available. Ghidra commit `50b78476df10…` (12.3-DEV, build 2026-11-25), Python 3.12.16, Electron 41.7.1 (all also in the bundle's `Contents/Resources/BUILD_INFO.json`). Nothing signed with a real identity, nothing pushed.

**What broke and how it was fixed.** Less than expected: `prepare.sh` ran unchanged (the round 6 modules, the Java helper classes, the Function ID trim and the fixture provider were all staged correctly).
- `electron-builder: command not found`. The worktree's `node_modules` was a symlink to the main checkout's, which has no `electron-builder`. Not a script bug; fixed by `npm ci` in the worktree (documented as a prerequisite).
- Absolute paths of the build machine inside the bundle: `python/bin/{pyghidra,pyghidraw,websockets}` (shebangs), `*.dist-info/direct_url.json` of pyghidra, and `_sysconfigdata__darwin_darwin.py` (the `uvpy` staging path). `prepare.sh` now deletes the scripts and `direct_url.json` and rewrites the sysconfigdata prefix. After the fix `grep -r fjankowski` over `Resources` finds nothing (`/Users/` still appears in a few generic example strings of pip, Ghidra's docs and an icon).
- `python/` still carried Tcl/Tk (`libtcl*`, `tk9.0`, …) although tkinter was removed: now removed too (66 → 58 MB).
- `_jpype.so` is a universal (x86_64 + arm64) binary; found while checking that every Mach-O gets the hardened-runtime signature (the first version of the signing hook skipped fat binaries because they share their magic number with Java `.class` files).
- Added (asked for): `THIRD_PARTY_NOTICES/`, `BUILD_INFO.json`, the `afterSign` hook, `npm run dist:signed`.

**Sizes** (`du -sh` of `Contents/Resources`): `jdk` 63 MB, `ghidra` 387 MB, `python` 58 MB, `sidecar` 284 KB, `app.asar` 31 MB, notices 248 KB; app bundle 822 MB; **`Ghidrette-0.0.1-arm64.dmg` 365 MB**. `npm run dist` takes about 1.5 min on a warm cache (Electron and python-build-standalone already downloaded).

**Inspection.** All `providers.ts` paths exist; `os/mac_arm_64/decompile` is executable (3.4 MB); `sidecar/jscans/out/` holds the 5 classes; `providers/fixture.cjs` is there; no `__pycache__`, `.venv` or `*.pyc`. Test files that remain are third-party ones (`jpype/_pyinstaller/test_*.py`, pyghidra's `pypkg/tests/`, certifi's), a few KB.

**Clean-environment runs** (`env -i HOME PATH=/usr/bin:/bin`; the worktree's `sidecar/.venv` symlink was renamed during phase 2). The python, decompile and demangler processes all have paths inside `Ghidrette.app/Contents/Resources`; the JVM is in the python process (`Resources/jdk`).
- `AUTOTEST=/bin/ls` on a fresh `SIDECAR_PROJECTS_DIR`: `ok: true`; `AUTOTEST_PHASE=2` on the same directory: `ok: true` (edits, struct, bookmark persisted). Repeated on the final build: both `ok: true`.
- `GHIDRETTE_PROVIDER=fixture AUTOTEST_FLOW=browsing AUTOTEST=app/providers/example.ghidrette.json`: `ok: true`, lands on `overlay::fedcba9876543060`, no python/JVM process started.
- Also under the hardened runtime with entitlements (`SIGN_IDENTITY=-`, 51 nested Mach-O files re-signed ad-hoc with `--options runtime`): AUTOTEST `ok: true`. So the entitlements file is enough for HotSpot, JPype and the decompiler; this does not prove notarization acceptance.

**Quit paths.** Normal quit (osascript) with the `ls` program open and the autotest running: no process of the bundle after 10 s, no `*.lock`. `kill -TERM` of the main process: no process after 10 s; locks gone in 3 of 4 runs. **One run left `spike.lock` and `spike.lock~`**: the TERM arrived during the autotest's reopen sequence, the sidecar logged `shutdown: close finished`, the process was gone; Ghidra treats such a lock as stale on the next open (and `project.close` documents this fallback for a close that cannot get the project lock). Not reproduced in 3 further runs at 0, 4 and 8 s delay; not investigated. A quit while the import is still running (decompile process just started) also leaves the lock files (2 of 2), the same documented fallback; the shutdown cancels the import.

**Launch time.** Double-click (`open -n`) to the welcome screen with the sidecar connected ("Programs in this project" rendered, read over the DevTools port): **2.8–2.9 s** (5 runs, warm disk cache; JVM start inside it 2.2 s). The first launch after the build was not timed separately.

**First open of `/bin/ls`, packaged vs dev** (fresh project, full analysis, same machine, one run each): analysis `Total Time` 7 s in both; `analysis done in` 5.3 s packaged against 5.4 s dev; list-after-open `openMs` 206 against 264; JVM start 2.2 s against 2.7 s. No measurable difference.

**Windows PE with the bundled Function ID data.** `WinHelloCPP.exe` (Ghidra's exercise files), full analysis, run with the packaged python, JDK and Ghidra (the sidecar started by hand with the app's environment and driven over the protocol, not through the UI; the PE is not in the autotest): 296 functions, **28 named by analysis, 26 `Function ID Analyzer` bookmarks** (`_strlen`, `__SEH_prolog4`, `__CallSettingFrame@12`, …) plus one conflict. So yes, kept databases do match. But the **trim costs most of them**: the same run against the untrimmed install names 222 functions with 222 Function ID bookmarks. With the bundle's databases plus only `vsOlder_x86.fidbf` (39 MB) the result is 222 again; with `vs2012_x86` instead, 31. Decision for the owner: keeping `vsOlder_x86` (+39 MB, or +66 MB with x64) recovers this binary completely; vs2012 matters little here. Binaries from other toolchains were not tried.

**Gatekeeper.** DMG copied to a temp folder, mounted (`hdiutil attach`), app copied out, `xattr -w com.apple.quarantine "0083;<time>;Safari;"` added. `codesign --verify --deep --strict` passes (ad-hoc, no Team ID); `spctl -a -t exec -vv` says `rejected`; `open` of the quarantined copy starts no process: Gatekeeper blocks it. I could not capture the dialog (no screen-recording or accessibility permission for the tool), so its wording is not recorded. Documented in DEVELOPMENT.md from Apple's behaviour for macOS 15+ and **not observed here**: right-click → Open no longer offers an override; the user must go to System Settings → Privacy & Security → "Open Anyway", or run `xattr -dr com.apple.quarantine Ghidrette.app` before the first launch (the older doc said right-click → Open). `xattr -d com.apple.quarantine` failed with `Operation not permitted` inside my tool's sandbox, so the post-`xattr` launch of the quarantined copy was not checked (an unquarantined copy launches fine, as in all runs above). I did not disable Gatekeeper or touch system settings.

**License notices.** `Contents/Resources/THIRD_PARTY_NOTICES/` (index from `packaging/THIRD_PARTY_NOTICES.md`): Ghidra `LICENSE` (from the install) and `NOTICE` (from the checkout via `GHIDRA_SRC`; it is not in the distribution zip, so without `GHIDRA_SRC` the folder has no NOTICE), JDK `LICENSE`, `ASSEMBLY_EXCEPTION`, `ADDITIONAL_LICENSE_INFO` (copied from `jdk/legal/java.base`), CPython `LICENSE.txt`, python-build-standalone `LICENSE` (fetched from GitHub at build time: `prepare.sh` now needs network for that too), JPype `LICENSE`/`NOTICE`, websockets, packaging, typing_extensions, pyghidra, Electron (Chromium's `LICENSES.chromium.html` is shipped by Electron itself), Monaco incl. `ThirdPartyNotices.txt`, @monaco-editor/react and loader, state-local, React, React DOM, scheduler, TanStack Virtual. **Gaps:** the license texts of the C libraries inside python-build-standalone (OpenSSL, SQLite, libffi, zlib, xz, …) are not in the `install_only` archive and are not included; the transitive npm dependencies bundled by Vite beyond the ones listed were not enumerated (no tool run); Ghidra's own third-party licenses are in the copied `ghidra/licenses/`. Also note for the owner: `ghidra/GPL/` ships GNU-demangler and DMG code under GPL; this is a distribution of GPL binaries and needs the corresponding source offer, which I did not write.

**Signing hand-off.** `app/scripts/sign-nested.cjs` (`afterSign`; no-op without `SIGN_IDENTITY`) and `npm run dist:signed`. Exact variables and commands (`SIGN_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `notarytool`, `stapler`, `spctl`) are in `docs/DEVELOPMENT.md` "Signing". The default build still launches with the hook in place (it is the `dist` used for all runs above). I never saw or handled credentials.

**Not tested.** Real Developer ID signing, notarization and stapling (the hook ran only with the ad-hoc identity, and `--timestamp` is only used for a real one); a DMG opened by double-click in Finder and dragged to `/Applications`; the Gatekeeper dialog itself; Intel Macs or other macOS versions (built and run on macOS 26 only); `dist:signed` end to end; an 8 GB machine (memory section unchanged); the Windows PE through the UI (protocol only); upgrading over an older install; the packaged app reading a project written by the dev build (same `userData` folder, not exercised).

**Found, not fixed (outside packaging or a product decision).**
- `userData` is `~/Library/Application Support/ghidra-desktop-spike-app` (from `package.json` `name`), and the dev and packaged builds share it. The app menu and Dock name are "Ghidrette" (from the builder's productName); setting `productName` in `app/package.json` would rename the folder and orphan existing dev data.
- The Function ID trim (above) loses 194 of 222 matches on `WinHelloCPP.exe`.
- Stale `spike.lock` after a TERM or quit during an import/reopen (above), recovered by Ghidra on the next open.
- `providers/example.ghidrette.json` is not in the bundle: the packaged fixture provider has nothing to open unless the user brings a file.
- electron-builder warns that `description` and `author` are missing in `app/package.json`.

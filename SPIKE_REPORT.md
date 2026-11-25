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
Decompile cache never invalidated; single default address space (`addr`, `listing_info`); one process per projects dir (project lock); unanalyzed/half-analyzed program is just re-analyzed; first 16 bytes of big data units; second client rejected; no token when `SIDECAR_TOKEN` unset (tests only); whitespace-split `SIDECAR_CMD`; byte positions as JS numbers; single contiguous listing buffer.

## Deviations
- JDK 25, not 21 (Ghidra master requirement). Ghidra checkout untouched except git-ignored build output.
- Mid-size binary: the native `decompile` binary is 3.5 MB (below the 5-10 MB target), so I used `/opt/homebrew/Cellar/mysql-client/9.3.0/bin/mysqldump` (6.95 MB; first-open analysis 103 s).
- Fling/sweep are scripted renderer drivers, not a person scrolling.

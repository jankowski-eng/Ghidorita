# Spike report

Status: **partial.** The end-to-end flow works on `/bin/ls`. Everything that needed the large binary was cancelled at the user's request and is **not measured**: large-binary demo, large-binary import/analysis time, large-binary listing benchmark, decompile median/p95 over 50 functions.

## What works (verified on /bin/ls, real sidecar, real Ghidra)
- `AUTOTEST=/bin/ls npm start`: open binary → progress → 136 functions → decompile → click a call in the C → function selected, listing scrolled to its entry. Exit 0, no errors. No orphaned sidecar afterwards.
- Sidecar pytest (`sidecar/test_smoke.py`) passes: progress notifications, decompile with token slices matching the text, cache hit, `address_to_row`/`row_to_address` round-trip, cancel (-32002), exit on stdin close in 0.04 s.
- Screenshot: `screenshots/ls-real-sidecar.png` (Monaco with underlined call token, virtualized function list, listing aligned to the entry).
- Frontend also runs against a mock server (`MOCK=1`, 2M fake rows).
- Not tested: "scroll the whole large-binary listing without freezes" (no large binary run), real Electron SIGKILL (only emulated with a Python parent).

## Measurements (/bin/ls, arm64, Apple Silicon)
| Item | Value |
|---|---|
| JVM startup (time to port line) | 4.05 s |
| Import + auto-analysis | 13.8 s (136 functions) |
| Listing index build | 0.24 s for 23,475 rows (Python loop) |
| Decompile, one function (cold) | 52.7 ms (single sample, not median/p95) |
| Decompile, cache hit | 1.9 ms |
| `listing_rows(0,200)` in smoke test | 9.2 ms |
| Large binary (`llvm-exegesis`, 66 MB, stand-in) | import 17 s; analysis still running after 16 min when cancelled; no other numbers |

Listing benchmark, `/bin/ls` only (64,381 rows, `bench/results_ls.json`, 300 batches of 200; outputs verified identical across approaches on 30,400 rows):

| Approach | Rows/s | 200-row median | p95 |
|---|---|---|---|
| (i) naive per-object JPype | ~29k | 4.2 ms | 17 ms |
| (ii) tuned JPype (forward iterator, bound methods) | ~30k | 3.8-4.3 ms | 16-19 ms |
| (iii) Java helper (`bench/java/RowFetcher.java`) | ~138k | 0.7 ms | 4-5 ms |

The 50 ms rule is met by (i) on this small binary, so the Java helper is **not integrated**. Whether that holds on a 50 MB+ binary is unmeasured; per-row cost should not depend on binary size, but the index (below) does. The 98 ms first-page latency seen once in the app was a cold sample, not explained by the benchmark.

## Risks, ranked (extra weeks on the ~30-week v1 plan; my estimates, not measured)
1. **Listing at real binary scale (+2 to 4 wk).** Unmeasured. The index is a Python list of one int per code unit, built by a full pass; undefined bytes are rows, so a 50 MB+ binary can mean tens of millions of rows (memory, build time). The renderer breaks beyond ~2.09M rows (Chromium element height limit, `App.tsx`), so a scaled scrollbar is mandatory. Also not covered: labels/comments/function headers as extra display lines, address spaces other than one, index invalidation after edits/analysis. The 6-week listing budget looks tight.
2. **Build and toolchain coupling (+1 to 2 wk).** This Ghidra master needs JDK 25 and Gradle 9.x; the stock `pyghidra.start()` shells out to `java` on PATH and failed, so the sidecar builds `HeadlessPyGhidraLauncher` itself. Shipping needs a bundled JDK + Ghidra + Python and pinned versions.
3. **Sidecar security and lifecycle (+1 wk).** Review found the WebSocket accepted any Origin and gave arbitrary file read via `open_binary`/`listing_rows` to any local web page. **Fixed in this spike** with a per-launch secret in the URL path (verified: no token and wrong token rejected, right token accepted). Still open: cancel race (no request id; cancel while queued is lost), `dispose()` called from the shutdown thread, `open_binary` leaves half-open state on failure and cannot be cancelled, a mid-compute native `decompile` child might outlive a hard kill (not tested), no CSP or navigation blocking in Electron, second client rejected (reload can lock out).
4. **Long-running analysis blocks the single worker (+1 wk).** Import/analysis monopolise the one worker thread, so nothing else is served meanwhile; analysis progress is indeterminate (pct -1). On the large binary analysis ran >16 min. Needs cancel, partial results, and a worker model beyond one queue.
5. **Decompiler fidelity (+1 wk).** Indirect calls and thunks have no `targetFunction`; token map not tested on many functions (only one decompiled in tests). Median/p95 unmeasured.
6. **Per-call JPype overhead (+0.5 wk, if needed).** Fine on /bin/ls (4 ms/200 rows). If the large binary disagrees, the Java helper is written and verified.

## Shortcuts (marked `shortcut:` in code)
- Cache never invalidated (`sidecar/main.py:35`); one address space (`:87`, `:144`); in-memory program, no project (`:119`); programId == name (`:139`); second client rejected (`:323`); no token when `SIDECAR_TOKEN` unset, used by tests only.
- App: SIGTERM then immediate SIGKILL (`app/src/main/index.ts`), whitespace-split `SIDECAR_CMD`, 16 px rows capped near 2.09M rows, unbounded listing page cache (`App.tsx`).

## Deviations from the brief
- JDK 25, not 21 (Ghidra master requirement); installed `openjdk@25` via Homebrew at the user's instruction.
- Ghidra built from the checkout at the user's instruction. The only change there is git-ignored build output (`build/`, `dependencies/`).
- Large test binary was a placeholder; `llvm-exegesis` was used as a stand-in, then benchmarks were cancelled.
- The review agent was given the code, not my conclusions. Its threading verdict is from reading only (not stress-tested).

# Development setup

Electron (TypeScript, React, Monaco) ⇄ WebSocket JSON-RPC ⇄ Python sidecar (PyGhidra → Ghidra JVM, headless).

All commands below run from the repo root unless a `cd` says otherwise. Set `GHIDRA_SRC` to your Ghidra source checkout.
Protocol: `../protocol.md`, `../protocol.ts`. Results: `../SPIKE_REPORT.md`. Code layout: [../app/ARCHITECTURE.md](../app/ARCHITECTURE.md) (renderer), [../sidecar/ARCHITECTURE.md](../sidecar/ARCHITECTURE.md) (sidecar).

## One-time setup

Requires JDK 25 (this Ghidra master compiles to class version 69; JDK 21 fails), Python ≥ 3.10, Node LTS.

```bash
# 1. Build Ghidra from source (in the Ghidra checkout; first run fetches dependencies)
export JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home   # brew install openjdk@25
cd "$GHIDRA_SRC"
./gradlew -I gradle/support/fetchDependencies.gradle
./gradlew -Dorg.gradle.jvmargs=-Xmx3G buildGhidra -x ip

# 2. Unpack the distribution next to the spike
cd <this repo>
mkdir -p ghidra-install && unzip -q "$GHIDRA_SRC"/build/dist/ghidra_*_DEV_*.zip -d ghidra-install

# 3. Python sidecar venv (pyghidra comes from the Ghidra build)
cd sidecar && python3 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest \
  ../ghidra-install/ghidra_*/Ghidra/Features/PyGhidra/pypkg/dist/pyghidra-*.whl

# 4. App
cd ../app && npm install
```

## Run

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home
export GHIDRA_INSTALL_DIR=$PWD/ghidra-install/ghidra_12.3_DEV
cd app && npm start
```

`npm start` launches the PyGhidra sidecar itself (`GHIDRETTE_PROVIDER=fixture` launches the read-only fixture provider instead; see [PROVIDERS.md](../PROVIDERS.md)). Then "Open binary…" (or drop a file on the window), pick a file, wait for analysis.

Other modes:

```bash
MOCK=1 npm start                    # fake sidecar, 2M fake rows (MOCK_LOCKED=1: every project call answers ProjectLocked)
AUTOTEST=/bin/ls npm start          # scripted flow, prints AUTOTEST_RESULT, writes app/out/screenshot.png
cd ../sidecar && .venv/bin/python -m pytest -s   # sidecar tests on /bin/ls: test_smoke.py (timings.json) + one test_<domain>.py per sidecar module (layout: sidecar/ARCHITECTURE.md)
cd ../app && npm test                                          # renderer unit tests, incl. the provider-boundary import check
cd ../sidecar && .venv/bin/python -m pytest -q test_provider_contract.py test_provider_ui.py   # one browsing suite against the fixture and PyGhidra, the built Electron app against fixture, PyGhidra and mock
BENCH=1 AUTOTEST=<binary> npm start                            # listing/decompile measurements in the renderer
../sidecar/.venv/bin/python ../bench/bench_sidecar.py <binary> /tmp/bench-projects out.json   # sidecar-level measurements
../sidecar/.venv/bin/python ../bench/bench_navfind.py <binary> <projects dir with the analyzed program> out.json   # symbol table / strings / memory search (row 6)
```

Never modify the Ghidra source checkout; everything here lives in this repo.

Analyzed programs persist in a Ghidra project under `$SIDECAR_PROJECTS_DIR` (the app uses its userData dir, `~/Library/Application Support/<app>/projects`), keyed by file sha256. Delete that dir to force re-analysis.

## Editing (Ghidra's default keys)
Listing (row cursor: click or arrows): `L` rename label/function, `;` comment (kind selectable, EOL prefilled), `F` create function, `T` define data, `C` clear code. Decompiler (cursor on a token; also the context menu): `L` rename variable/param/function/label, `Cmd+L` retype variable, Edit menu > Edit Function Signature, `;` comment (pre). `Cmd+Z` / `Cmd+Shift+Z` program undo/redo (a text input keeps its own undo), `Cmd+S` save. Edits autosave when another binary is opened and on quit; saving drops Ghidra's undo history.
Autotest edit flow: `AUTOTEST=/bin/ls SIDECAR_PROJECTS_DIR=<fresh dir> npm start`, then `AUTOTEST_PHASE=2` with the same dir to check the edit persisted.
`L` on a row without a label creates one (`create_label`); `;` prefills the chosen kind from `get_comments` and follows the kind selector. View > Strings opens the strings panel (filter, paging, click goes to the address). Import dialog: analysis profile Full or Fast (default Fast above 20 MB).
Opening shows the program as soon as the import is saved; the analysis runs in the background (status bar: analyzer, count, Cancel; an interrupted analysis shows "Resume", a fast program "Run full analysis"). Edits, undo and redo are Busy while it runs (protocol.md "Analysis"). `bench/bench_background.py` and `bench/bench_headless.py` measure it against `analyzeHeadless`.
Listing rows show function headers, plate/pre/post/EOL/repeatable comments, all symbols, `XREF[n]` annotations (click to navigate, `X` opens the references panel) and structure/array data folded (click the arrow or Left/Right to unfold); all address spaces (overlay blocks too), addresses above 2^63 unsigned (protocol.md). Pytest for it: `sidecar/test_listing.py` (in-process, hand-built programs). `X` on a decompiler global opens its references; `X` on a temporary (`iVar1`) lists its writes and reads (`variable_uses`), a click navigates and highlights the token. Remaining gaps: SPIKE_REPORT "Round 8: listing completeness" and "Round 8 (second part)". `xrefs_to` lists memory references and imports; stack and register variables go through `xrefs_to_variable`, and `xrefs_from` also returns stack, register and external targets.

## Packaging (macOS, Apple Silicon)

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home GHIDRA_INSTALL_DIR=$PWD/ghidra-install/ghidra_12.3_DEV
cd app && npm run dist        # -> app/dist/Ghidrette-<ver>-arm64.dmg and app/dist/mac-arm64/Ghidrette.app
```

Status: no full `npm run dist` has been recorded since the sidecar became a package (SPIKE_REPORT Round 6, "Not tested"; later rounds added the Java helpers and the fixture provider to the bundle). Treat the bundle description below as the design until a build is run and launched.

`npm run dist` = `packaging/prepare.sh` (stages `app/bundle/`: `jdk`, `ghidra`, `python`, `sidecar`; needs `uv` and network for python-build-standalone) + `electron-vite build` + `electron-builder`. electron-builder was chosen over Forge because `extraResources` + dmg + ad-hoc signing need no plugin chain. The Ghidra checkout and `ghidra-install/` are only read.

What the bundle contains (`Contents/Resources/`):
- `jdk/`: `jlink` runtime with the modules found by `jdeps -s` over every Ghidra jar and `org.jpype.jar` (java.base, desktop, sql, xml, naming, rmi, management, scripting, net.http, jdk.compiler, jdk.unsupported, …) plus `jdk.zipfs jdk.crypto.ec jdk.management jdk.charsets java.prefs`. Verified by running analysis + decompile + the edit flow with it.
- `ghidra/`: copy of the distribution minus the older FunctionID databases (vs2012, vsOlder), docs, Extensions, Debug (debugger), GhidraServer, BSim, x86_64/other-OS natives, `*-src.zip`, unused `support/` launchers (sizes in `app/bundle/trim-log.txt`). The `os/mac_arm_64` decompiler binary is kept and `chmod +x`'d; electron-builder preserves the mode. Function ID: `Features/FunctionID/data` is 195 MB; the databases cover MSVC runtimes for Windows PE (x86/x64) only, nothing for Linux or macOS. The bundle keeps vs2015, vs2017 and vs2019 (x86 and x64, 93 MB) and cuts vs2012 and vsOlder (102 MB); the kept and cut files are in `trim-log.txt`. Kept although large: `Features/Base/data/typeinfo` (124 MB, data type archives), all processors.
- `python/`: python-build-standalone 3.12 with websockets, jpype1, packaging, typing_extensions, pyghidra (wheel from the Ghidra build). Links only against system libs.
- `sidecar/main.py` and the `sidecar/ghidrette/` package (code layout: [sidecar/ARCHITECTURE.md](../sidecar/ARCHITECTURE.md)), plus `sidecar/jscans/out/` with the Java helpers compiled by `prepare.sh`.

The PyGhidra launch configuration (`app/src/main/providers.ts`) uses these when `app.isPackaged` (JAVA_HOME, GHIDRA_INSTALL_DIR, PYTHONNOUSERSITE set; the shell's values are ignored); in dev it still uses the env vars and `sidecar/.venv`. `SIDECAR_MAXMEM`, `SIDECAR_ANALYSIS_DISABLE`, `SIDECAR_PROJECTS_DIR` (default `userData/projects`) pass through. Autotest output in the packaged app goes to `userData/out` (asar is read-only). `MOCK`/`AUTOTEST`/`BENCH` work as before.

### Memory
Round 4 on a 66 MB binary: JVM 3.5–4.1 GB peak plus up to 5.6 GB in the native decompiler (≈ 10 GB together). **Minimum 8 GB** (small and medium binaries; the default heap is half of RAM, so 4 GB on an 8 GB Mac; very large binaries will swap), **recommended 16 GB or more** for binaries in the 50+ MB range.

### Signing (current: ad-hoc)
The build is ad-hoc signed with the hardened runtime off (`mac.identity: "-"`, `hardenedRuntime: false`); the JVM's JIT would be killed under a hardened runtime without entitlements. Opening a downloaded copy needs right-click → Open (or `xattr -dr com.apple.quarantine Ghidrette.app`).

For Developer ID + notarization later (not attempted):
1. In `app/package.json` `build.mac` set `identity` to the "Developer ID Application: …" name, `hardenedRuntime: true`, `notarize: true` (needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in the env). `entitlements`/`entitlementsInherit` already point at `packaging/entitlements.mac.plist`.
2. Entitlements needed (in that plist): `com.apple.security.cs.allow-jit` and `…allow-unsigned-executable-memory` (HotSpot JIT, Python/ctypes), `…disable-library-validation` (JVM and JPype load libraries signed by other teams, Electron helpers). They must apply to every nested executable: `jdk/bin/*`, `jdk/lib/**/*.dylib`, `python/bin/python3.12`, python `*.so`, and `ghidra/**/os/mac_arm_64/decompile` (a plain C++ helper; it likely needs none, verify by running it under the hardened runtime). electron-builder signs only Electron's own code and main binary reliably, so add an `afterSign` hook (or `mac.binaries`) listing these nested Mach-O files, signing each with `codesign --options runtime --timestamp --entitlements …` before the app is sealed. Ghidra's `Ghidra/Features/*/os/*/` natives and jlink's `lib/*.dylib` must be signed too, or notarization rejects the upload.
3. `xcrun notarytool submit … --wait` on the dmg, then `xcrun stapler staple`.

### Linux / Windows (out of scope), what would differ
- jlink runtime and python-build-standalone per OS/arch; the python path becomes `python/python.exe` on Windows.
- Ghidra: keep `os/linux_x86_64` or `os/win_x86_64` natives instead of `mac_arm_64` (and decompile binaries become `.exe` on Windows); the `GPL/` demangler natives likewise.
- Packaging targets (AppImage/deb or NSIS/MSI), no dmg, Windows executable bits not needed; signing via signtool/GPG rather than codesign.
- `userData` path, default `SIDECAR_PROJECTS_DIR` fallback in `sidecar/ghidrette/domains/project.py` (`~/Library/Application Support/…`) and the macOS menu/dock code.

## Navigate and find
View menu: Symbol Table (Cmd+Shift+Y), Defined Strings (Cmd+Shift+E), Search Memory… (Cmd+Shift+F) open a dock under the panes; each window is server-paged (a click or Enter navigates the listing and the decompiler). Search Memory takes hex bytes with `??` wildcards or ASCII / UTF-16 text and streams pages until done; Cancel keeps what was found, Continue resumes. `X` on a listing row or a decompiler token (also Go > Show References To, and the decompiler context menu) pins the References panel to it ("follow cursor" unpins); its "from…" button lists what the current instruction references.

Data types: View > Data Type Manager (Cmd+Shift+T) or "Data Type Manager" in the command bar (Cmd+K, `>`); Edit > Create Structure from Data… on the listing cursor row. Struct/enum edits are undoable like any edit. The autotest also covers this flow (`AUTOTEST_PHASE=2` checks the struct survived).

## Round 9 additions
- `sidecar/jscans/GhidretteScans.java`: the strings scan and the symbol kind filter/sort run in Java. `ghidrette/core/jscans.py` compiles it with `$JAVA_HOME/bin/javac` at start when the class is missing or older (`prepare.sh` ships it precompiled). Do not name a directory `java` next to `main.py` (the sidecar directory): it shadows JPype's `java` package.
- Tests needing the big binary (`sidecar/test_big.py`, `sidecar/test_ui.py -k big`) skip unless its fast-profile analysis is stored: `SPIKE_BIG_BINARY`, `SPIKE_BIG_PROJECTS` (create it with `bench_open.py` and `SIDECAR_ANALYSIS_DISABLE="Call Convention ID;Decompiler Switch Analysis;Stack"`, 10-17 min). `test_ui.py` starts Electron and needs a display. Its focused flows are `AUTOTEST_FLOW=locked|big`; `sidecar/test_provider_ui.py` runs the browsing, replacement and open-preserve flows against each provider. Set `AUTOTEST_DECOMPILE_TIMEOUT=<secs>` to exercise the decompile timeout.
- Benchmarks wait for a quiet machine (`bench/common.py: wait_quiet`) and exit 3 instead of measuring under load. `bench/run_round9.sh` runs the repeats.
- A failed replacement open preserves the active program and undo history (protocol.md).
- `MANUAL_TEST.md`: the 30-minute checklist for what scripts cannot do.

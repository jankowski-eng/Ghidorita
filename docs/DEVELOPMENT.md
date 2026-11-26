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
All keys live in `app/src/keys.ts`; the menu, the command bar and the status-bar key hints read it.
Listing (row cursor: click or arrows): `L` rename label/function, `;` comment (kind selectable, EOL prefilled), `F` create function, `T` define data, `C` clear code. Decompiler (cursor on a token; also the context menu): `L` rename variable/param/function/label, `Cmd+L` retype variable, Edit menu > Edit Function Signature, `;` comment (pre). `Cmd+Z` / `Cmd+Shift+Z` program undo/redo (a text input keeps its own undo), `Cmd+S` save. Edits autosave when another binary is opened and on quit; saving drops Ghidra's undo history.
Autotest edit flow: `AUTOTEST=/bin/ls SIDECAR_PROJECTS_DIR=<fresh dir> npm start`, then `AUTOTEST_PHASE=2` with the same dir to check the edit persisted.
`L` on a row without a label creates one (`create_label`); `;` prefills the chosen kind from `get_comments` and follows the kind selector. View > Strings opens the strings panel (filter, paging, click goes to the address). Import dialog: analysis profile Full or Fast (default Fast above 20 MB).
Opening shows the program as soon as the import is saved; the analysis runs in the background (status bar: analyzer, count, Cancel; an interrupted analysis shows "Resume", a fast program "Run full analysis"). Edits, undo and redo are Busy while it runs (protocol.md "Analysis"). `bench/bench_background.py` and `bench/bench_headless.py` measure it against `analyzeHeadless`.
Listing rows show function headers, plate/pre/post/EOL/repeatable comments, all symbols, `XREF[n]` annotations (click to navigate, `X` opens the references panel) and structure/array data folded (click the arrow or Left/Right to unfold); all address spaces (overlay blocks too), addresses above 2^63 unsigned (protocol.md). Pytest for it: `sidecar/test_listing.py` (in-process, hand-built programs). `X` on a decompiler global opens its references; `X` on a temporary (`iVar1`) lists its writes and reads (`variable_uses`), a click navigates and highlights the token. Remaining gaps: SPIKE_REPORT "Round 8: listing completeness" and "Round 8 (second part)". `xrefs_to` lists memory references and imports; stack and register variables go through `xrefs_to_variable`, and `xrefs_from` also returns stack, register and external targets.

## Packaging (macOS, Apple Silicon)

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home GHIDRA_INSTALL_DIR=$PWD/ghidra-install/ghidra_12.3_DEV
export GHIDRA_SRC=~/Projekte/floss/ghidra    # optional: adds Ghidra's NOTICE file and its HEAD to the bundle
cd app && npm ci && npm run dist             # -> app/dist/Ghidrette-<ver>-arm64.dmg and app/dist/mac-arm64/Ghidrette.app
```

Prerequisites: JDK 25 (only `jlink` runs from it), `uv` and network (python-build-standalone), `npm ci` in `app/` (a real `node_modules` that includes `electron-builder`; the worktree symlink to another checkout's `node_modules` lacked it), the Ghidra distribution in `GHIDRA_INSTALL_DIR`. Status: verified end to end on 2026-11-26 (SPIKE_REPORT "Round 12: first packaged build"): the ad-hoc signed build passes the autotest (both phases), the fixture provider and the quit paths from a clean environment (`env -i`, no `JAVA_HOME`, no venv). Not verified: Developer ID signing and notarization (see Signing).

`npm run dist` = `packaging/prepare.sh` (stages `app/bundle/`: `jdk`, `ghidra`, `python`, `sidecar`, `THIRD_PARTY_NOTICES`, `BUILD_INFO.json`) + `electron-vite build` + `electron-builder`. electron-builder was chosen over Forge because `extraResources` + dmg + ad-hoc signing need no plugin chain. The Ghidra checkout and `ghidra-install/` are only read.

What the bundle contains (`Contents/Resources/`, sizes of the 2026-11-26 build; the .dmg is 382 MB, the .app 862 MB):
- `jdk/` (63 MB): `jlink` runtime with the modules found by `jdeps -s` over every Ghidra jar and `org.jpype.jar` (java.base, desktop, sql, xml, naming, rmi, management, scripting, net.http, jdk.compiler, jdk.unsupported, …) plus `jdk.zipfs jdk.crypto.ec jdk.management jdk.charsets java.prefs`.
- `ghidra/` (426 MB): copy of the distribution minus the FunctionID databases vs2012 and vsOlder_x64, docs, Extensions, Debug (debugger), GhidraServer, BSim, x86_64/other-OS natives, `*-src.zip`, unused `support/` launchers (sizes in `app/bundle/trim-log.txt`). The `os/mac_arm_64` decompiler binary is kept and `chmod +x`'d; electron-builder preserves the mode. Function ID: the databases cover MSVC runtimes for Windows PE (x86/x64) only. The bundle keeps vs2015, vs2017, vs2019 (93 MB) and `vsOlder_x86` (39 MB) and cuts vs2012 and `vsOlder_x64` (63 MB). On `WinHelloCPP.exe` the full install names 222 functions, the bundle 222 (without `vsOlder_x86`: 28); x64 binaries built with older MSVC were not tried, so `vsOlder_x64` (27 MB) may be worth keeping. Kept although large: `Features/Base/data/typeinfo` (124 MB), all processors.
- `python/` (58 MB): python-build-standalone 3.12 with websockets, jpype1, packaging, typing_extensions, pyghidra (wheel from the Ghidra build). tkinter, Tcl/Tk, idle, pip's console scripts with absolute shebangs, `direct_url.json` and the build prefix in `_sysconfigdata` are removed so no path of the build machine ends up in the bundle. Links only against system libs.
- `sidecar/main.py` and the `sidecar/ghidrette/` package (code layout: [sidecar/ARCHITECTURE.md](../sidecar/ARCHITECTURE.md)), plus `sidecar/jscans/out/` with the Java helpers compiled by `prepare.sh`.
- `providers/fixture.cjs` (the fixture provider; `providers/example.ghidrette.json` is not bundled, open the file from the repo).
- `THIRD_PARTY_NOTICES/` (license texts copied from the sources by `prepare.sh`; index: `packaging/THIRD_PARTY_NOTICES.md`) and `BUILD_INFO.json` (Ghidra commit and build date, JDK, Python, Electron and app versions).

The PyGhidra launch configuration (`app/src/main/providers.ts`) uses these when `app.isPackaged` (JAVA_HOME, GHIDRA_INSTALL_DIR, PYTHONNOUSERSITE set; the shell's values are ignored); in dev it still uses the env vars and `sidecar/.venv`. `SIDECAR_MAXMEM`, `SIDECAR_ANALYSIS_DISABLE`, `SIDECAR_PROJECTS_DIR` (default `userData/projects`) pass through. `userData` of the packaged app is `~/Library/Application Support/ghidra-desktop-spike-app` (the `name` in `package.json`, not the product name; dev uses the same folder). Autotest output in the packaged app goes to `userData/out` (asar is read-only). `MOCK`/`AUTOTEST`/`BENCH` work as before.

Checking a build from a clean environment (what the 2026-11-26 run did):
```bash
env -i HOME="$HOME" PATH=/usr/bin:/bin AUTOTEST=/bin/ls SIDECAR_PROJECTS_DIR=$(mktemp -d) app/dist/mac-arm64/Ghidrette.app/Contents/MacOS/Ghidrette
# then the same with AUTOTEST_PHASE=2 and the same SIDECAR_PROJECTS_DIR; the fixture: GHIDRETTE_PROVIDER=fixture AUTOTEST_FLOW=browsing AUTOTEST=app/providers/example.ghidrette.json
```
Both phases print `AUTOTEST_RESULT {"ok":true,…}`. The processes of a run (`ps`) are the app's helpers, `Resources/python/bin/python3` and, below it, `Resources/ghidra/.../os/mac_arm_64/decompile` and `demangler_gnu`; the JVM lives inside the python process (JPype, `Resources/jdk`).

### Memory
Round 4 on a 66 MB binary: JVM 3.5–4.1 GB peak plus up to 5.6 GB in the native decompiler (≈ 10 GB together). **Minimum 8 GB** (small and medium binaries; the default heap is half of RAM, so 4 GB on an 8 GB Mac; very large binaries will swap), **recommended 16 GB or more** for binaries in the 50+ MB range.

### Signing (current: ad-hoc)
The default build is ad-hoc signed with the hardened runtime off (`mac.identity: "-"`, `hardenedRuntime: false`). A downloaded copy carries the quarantine attribute and macOS refuses to open it (`spctl` reports `rejected`; the app does not start). On macOS 15 and later the "right-click → Open" override is gone: open System Settings → Privacy & Security, scroll to the message about Ghidrette and click "Open Anyway" (then confirm with the login password). Or remove the attribute before the first launch: `xattr -dr com.apple.quarantine /Applications/Ghidrette.app`. Files copied without a browser (scp, a local build) have no quarantine and open directly. (The dialog itself was not captured on screen in the 2026-11-26 check: see the report.)

Developer ID + notarization (the hook and the flow are in place; run with a real identity by the credential holder, not exercised yet):
- `app/scripts/sign-nested.cjs` is the `afterSign` hook. With `SIGN_IDENTITY` unset it does nothing (the default `npm run dist`). With it set, it signs every nested Mach-O under `Contents/Resources` (found by magic number, so `jdk/**`, `python/**` including the universal `_jpype.so`, `ghidra/**/os/mac_arm_64/*`, every `*.dylib` and `*.so`) with `--options runtime --timestamp --entitlements packaging/entitlements.mac.plist`, then re-signs the app bundle (its seal covers Resources). `SIGN_IDENTITY=-` runs the same flow ad-hoc (no timestamp): the hardened-runtime build launched and passed the autotest, so the JIT/library-validation entitlements are sufficient for the JVM, JPype and the decompiler.
- `npm run dist:signed` builds with `--config.mac.identity="$SIGN_IDENTITY" --config.mac.hardenedRuntime=true --config.mac.notarize=true --config.dmg.sign=true`; electron-builder submits the app to Apple's notary service and staples it.

Commands (credentials come from the environment; never commit them):
```bash
export SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"   # must be in the login keychain
export APPLE_ID=<apple id e-mail> APPLE_APP_SPECIFIC_PASSWORD=<app-specific password> APPLE_TEAM_ID=<TEAMID>
export JAVA_HOME=... GHIDRA_INSTALL_DIR=... GHIDRA_SRC=...
cd app && npm run dist:signed
# the .app is notarized and stapled by electron-builder; notarize the .dmg too and staple it:
xcrun notarytool submit dist/Ghidrette-<ver>-arm64.dmg --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple dist/Ghidrette-<ver>-arm64.dmg
spctl -a -t exec -vv dist/mac-arm64/Ghidrette.app      # expect: accepted, source=Notarized Developer ID
```
If notarization rejects the upload, `xcrun notarytool log <submission-id> --apple-id … --team-id …` names the unsigned or unhardened file.

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

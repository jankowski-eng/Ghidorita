# Ghidra desktop frontend spike

Electron (TypeScript, React, Monaco) ⇄ WebSocket JSON-RPC ⇄ Python sidecar (PyGhidra → Ghidra JVM, headless).
Protocol: `protocol.md`, `protocol.ts`. Results: `SPIKE_REPORT.md`.

## One-time setup

Requires JDK 25 (this Ghidra master compiles to class version 69; JDK 21 fails), Python ≥ 3.10, Node LTS.

```bash
# 1. Build Ghidra from source (in the Ghidra checkout; first run fetches dependencies)
export JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home   # brew install openjdk@25
cd /Users/fjankowski/Projekte/floss/ghidra
./gradlew -I gradle/support/fetchDependencies.gradle
./gradlew -Dorg.gradle.jvmargs=-Xmx3G buildGhidra -x ip

# 2. Unpack the distribution next to the spike
cd /Users/fjankowski/Projekte/floss/ghidra-desktop-spike
mkdir -p ghidra-install && unzip -q /Users/fjankowski/Projekte/floss/ghidra/build/dist/ghidra_*_DEV_*.zip -d ghidra-install

# 3. Python sidecar venv (pyghidra comes from the Ghidra build)
cd sidecar && python3 -m venv .venv
.venv/bin/pip install websockets pytest jpype1 packaging typing_extensions \
  ../ghidra-install/ghidra_*/Ghidra/Features/PyGhidra/pypkg/dist/pyghidra-*.whl

# 4. App
cd ../app && npm install
```

## Run

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home
export GHIDRA_INSTALL_DIR=$PWD/../ghidra-install/ghidra_12.3_DEV   # from app/
cd app && npm start
```

`npm start` spawns the sidecar itself. Then "Open binary…", pick a file, wait for analysis.

Other modes:

```bash
MOCK=1 npm start                    # fake sidecar, 2M fake rows
AUTOTEST=/bin/ls npm start          # scripted flow, prints AUTOTEST_RESULT, writes app/out/screenshot.png
cd ../sidecar && .venv/bin/python -m pytest -s test_smoke.py   # sidecar smoke test on /bin/ls, writes timings.json
```

Never modify the Ghidra source checkout; everything here lives in this repo.

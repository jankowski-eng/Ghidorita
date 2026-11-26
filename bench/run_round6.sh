#!/bin/bash
# Round 6 benchmark chain: 3 repeats each on the stored fast-profile analysis of llvm-exegesis. Every script waits for a quiet machine (common.wait_quiet) or exits 3.
cd "$(dirname "$0")"
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home}
export GHIDRA_INSTALL_DIR=${GHIDRA_INSTALL_DIR:-/Users/fjankowski/Projekte/floss/ghidra-desktop-spike/ghidra-install/ghidra_12.3_DEV}
BIN=${BIG_BINARY:-/opt/homebrew/Cellar/llvm/23.1.3_2/bin/llvm-exegesis}
PROJ=${BIG_PROJECTS:?set BIG_PROJECTS}
PY=../sidecar/.venv/bin/python
OUT=results_round6
for i in 1 2 3; do
  SIDECAR_ANALYSIS_DISABLE="Call Convention ID;Decompiler Switch Analysis;Stack" $PY bench_navfind.py $BIN $PROJ $OUT/navfind_$i.json > $OUT/navfind_$i.log 2>&1
  SIDECAR_ANALYSIS_DISABLE="Call Convention ID;Decompiler Switch Analysis;Stack" $PY bench_sidecar.py $BIN $PROJ $OUT/sidecar_$i.json > $OUT/sidecar_$i.log 2>&1
done
echo chain done > $OUT/DONE

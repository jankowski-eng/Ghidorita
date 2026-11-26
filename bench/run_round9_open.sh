#!/bin/bash
# Round 9 first-open runs (fresh projects dir each): fast profile x3, full profile x1. Each waits for a quiet machine or exits 3.
cd "$(dirname "$0")"
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home}
export GHIDRA_INSTALL_DIR=${GHIDRA_INSTALL_DIR:-/Users/fjankowski/Projekte/floss/ghidra-desktop-spike/ghidra-install/ghidra_12.3_DEV}
BIN=/opt/homebrew/Cellar/llvm/23.1.3_2/bin/llvm-exegesis
PY=../sidecar/.venv/bin/python
OUT=results_round9; T=$(cd "${TMPDIR:-/tmp}" && pwd -P)/r6open  # no "//": Ghidra rejects blank path elements; mkdir -p $T
for i in 1 2 3; do
  rm -rf $T/fast$i
  SIDECAR_ANALYSIS_DISABLE="Call Convention ID;Decompiler Switch Analysis;Stack" $PY bench_open.py $BIN $T/fast$i $OUT/open_fast_$i.json > $OUT/open_fast_$i.log 2>&1
  rm -rf $T/fast$i
done
rm -rf $T/full1
$PY bench_open.py $BIN $T/full1 $OUT/open_full_1.json > $OUT/open_full_1.log 2>&1
rm -rf $T/full1
echo done > $OUT/DONE_OPEN

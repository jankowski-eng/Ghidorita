#!/bin/bash
# BENCH=1 app run x3 on the stored fast analysis of llvm-exegesis (renderer measurements). Waits for a quiet machine before each run.
cd "$(dirname "$0")"
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home}
export GHIDRA_INSTALL_DIR=${GHIDRA_INSTALL_DIR:-$(cd "$(dirname "$0")/.." && pwd)/ghidra-install/ghidra_12.3_DEV}
BIN=/opt/homebrew/Cellar/llvm/23.1.3_2/bin/llvm-exegesis
PROJ=${BIG_PROJECTS:?set BIG_PROJECTS}
OUT=results_round9
while [ ! -f $OUT/DONE_OPEN ]; do sleep 30; done
(cd ../app && npm run build >/dev/null 2>&1)
for i in 1 2 3; do
  ../sidecar/.venv/bin/python -c "import common; print(common.wait_quiet())" > $OUT/app_$i.quiet.json || { echo "not quiet" > $OUT/app_$i.json; continue; }
  (cd ../app && BENCH=1 AUTOTEST=$BIN SIDECAR_PROJECTS_DIR=$PROJ SIDECAR_ALLOW_NO_AUTH=1 SIDECAR_ANALYSIS_DISABLE="Call Convention ID;Decompiler Switch Analysis;Stack" ./node_modules/.bin/electron . ) > $OUT/app_$i.log 2>&1
done
echo done > $OUT/DONE_APP

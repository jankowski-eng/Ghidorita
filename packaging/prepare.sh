#!/bin/bash
# Stage the self-contained runtime into app/bundle/{jdk,ghidra,python,sidecar} for electron-builder (extraResources).
# Inputs (same env as dev): JAVA_HOME (JDK 25, needed only to run jlink), GHIDRA_INSTALL_DIR. Needs `uv` (fetches python-build-standalone).
# Never touches the Ghidra checkout/install: everything is copied, then trimmed in the copy. Sizes of each cut go to bundle/trim-log.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${JAVA_HOME:?}" "${GHIDRA_INSTALL_DIR:?}"
B=app/bundle; rm -rf $B; mkdir -p $B
LOG=$B/trim-log.txt

# --- JDK: modules found with `jdeps -s` over every Ghidra jar + org.jpype.jar, plus a few runtime-loaded ones (see README)
MODS=java.base,java.compiler,java.datatransfer,java.desktop,java.instrument,java.logging,java.management,java.naming,java.net.http,java.prefs,java.rmi,java.scripting,java.security.jgss,java.sql,java.transaction.xa,java.xml,jdk.compiler,jdk.crypto.ec,jdk.httpserver,jdk.management,jdk.net,jdk.unsupported,jdk.zipfs,jdk.charsets
"$JAVA_HOME/bin/jlink" --add-modules $MODS --strip-debug --no-man-pages --no-header-files --compress=zip-6 --output $B/jdk

# --- Ghidra: copy, then cut what a headless-analysis + decompile app never loads
GH=$B/ghidra; mkdir -p $GH
rsync -a --exclude '.DS_Store' "$GHIDRA_INSTALL_DIR"/ $GH/
trim() { for p in "$@"; do if [ -e "$GH/$p" ]; then printf '%8s  %s\n' "$(du -sh "$GH/$p" | awk '{print $1}')" "$p" >> $LOG; rm -rf "$GH/$p"; fi; done; }
trim docs Extensions Ghidra/Debug Ghidra/Features/GhidraServer Ghidra/Features/BSim
trim GPL/DMG/data/os GPL/DemanglerGnu/os/mac_x86_64 Ghidra/Features/Decompiler/os/mac_x86_64 Ghidra/Features/FileFormats/os/mac_x86_64
trim support/GhidraGo support/bsim support/bsim_ctl support/eclipse support/jshellRun support/buildGhidraJar support/convertStorage support/updateServerAllowList support/ghidraClean support/ghidraDebug
find $GH -name '*-src.zip' -print0 | xargs -0 du -ch | tail -1 | sed 's/total/*-src.zip/' >> $LOG; find $GH -name '*-src.zip' -delete
chmod +x $GH/Ghidra/Features/Decompiler/os/mac_arm_64/*

# --- Python: relocatable python-build-standalone via uv, no Homebrew/asdf paths
uv python install 3.12 --install-dir $B/uvpy >/dev/null
cp -R "$(find $B/uvpy -maxdepth 1 -type d -name 'cpython-3.12.*')" $B/python; rm -rf $B/uvpy
PY=$B/python/bin/python3
WHL=$(echo $GH/Ghidra/Features/PyGhidra/pypkg/dist/pyghidra-*.whl)
uv pip install --python $PY --break-system-packages -q websockets jpype1 packaging typing_extensions "$WHL"
rm -rf $B/python/lib/python3.12/test $B/python/lib/python3.12/idlelib $B/python/lib/python3.12/tkinter $B/python/lib/python3.12/ensurepip $B/python/share
find $B/python -name __pycache__ -prune -exec rm -rf {} +

# --- sidecar
mkdir -p $B/sidecar; cp sidecar/main.py $B/sidecar/
echo "bundle staged:"; du -sh $B/jdk $B/ghidra $B/python $B/sidecar

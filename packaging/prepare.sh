#!/bin/bash
# Stage the self-contained runtime into app/bundle/{jdk,ghidra,python,sidecar} for electron-builder (extraResources).
# Inputs (same env as dev): JAVA_HOME (JDK 25, needed only to run jlink), GHIDRA_INSTALL_DIR. Needs `uv` (fetches python-build-standalone).
# Never touches the Ghidra checkout/install: everything is copied, then trimmed in the copy. Sizes of each cut go to bundle/trim-log.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${JAVA_HOME:?}" "${GHIDRA_INSTALL_DIR:?}"   # GHIDRA_SRC (the Ghidra git checkout) is optional: adds its NOTICE file and HEAD to the bundle
B=app/bundle; rm -rf $B; mkdir -p $B
LOG=$B/trim-log.txt

# --- JDK: modules found with `jdeps -s` over every Ghidra jar + org.jpype.jar, plus a few runtime-loaded ones (see README)
MODS=java.base,java.compiler,java.datatransfer,java.desktop,java.instrument,java.logging,java.management,java.naming,java.net.http,java.prefs,java.rmi,java.scripting,java.security.jgss,java.sql,java.transaction.xa,java.xml,jdk.compiler,jdk.crypto.ec,jdk.httpserver,jdk.management,jdk.net,jdk.unsupported,jdk.zipfs,jdk.charsets
"$JAVA_HOME/bin/jlink" --add-modules $MODS --strip-debug --no-man-pages --no-header-files --compress=zip-6 --output $B/jdk

# --- Ghidra: copy, then cut what a headless-analysis + decompile app never loads
GH=$B/ghidra; mkdir -p $GH
rsync -a --exclude '.DS_Store' "$GHIDRA_INSTALL_DIR"/ $GH/
trim() { for p in "$@"; do if [ -e "$GH/$p" ]; then printf '%8s  %s\n' "$(du -sh "$GH/$p" | awk '{print $1}')" "$p" >> $LOG; rm -rf "$GH/$p"; fi; done; }
# Function ID: the .fidbf databases cover MSVC runtimes for Windows PE (x86/x64) only, no Linux/macOS. Keep vs2015/2017/2019 (~93 MB), trim vs2012 and vsOlder (~102 MB).
FID=Ghidra/Features/FunctionID/data
trim $(cd $GH && ls -d $FID/vs2012_* $FID/vsOlder_* 2>/dev/null)
for p in $(cd $GH && ls -d $FID/vs20*.fidbf 2>/dev/null); do printf '%8s  %s (kept)\n' "$(du -sh "$GH/$p" | awk '{print $1}')" "$p" >> $LOG; done
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
uv pip install --python $PY --break-system-packages -q -r sidecar/requirements.txt "$WHL"
rm -rf $B/python/lib/python3.12/test $B/python/lib/python3.12/idlelib $B/python/lib/python3.12/tkinter $B/python/lib/python3.12/ensurepip $B/python/share
rm -rf $B/python/lib/python3.12/lib-dynload/_tkinter* $B/python/lib/{libtcl*,libtk*,tcl*,tk*,itcl*,thread*} $B/python/bin/idle3*
# nothing from this machine may end up in the bundle: console scripts with an absolute shebang (pyghidra, websockets; the app runs main.py directly), pip's direct_url.json, and the build prefix in sysconfigdata
{ grep -lI "$PWD" $B/python/bin/* || true; } | xargs rm -f
rm -f $B/python/lib/python3.12/site-packages/*.dist-info/direct_url.json
sed -i '' "s#$PWD/$B/uvpy/[^\"']*#/python-build-standalone#g" $B/python/lib/python3.12/_sysconfigdata_*.py
find $B/python -name __pycache__ -prune -exec rm -rf {} +

# --- sidecar
mkdir -p $B/sidecar/jscans/out; cp sidecar/main.py $B/sidecar/; cp -R sidecar/ghidrette $B/sidecar/
find $B/sidecar -name __pycache__ -prune -exec rm -rf {} +
# the scan helper ships precompiled (the jlink runtime has no javac launcher to rely on); core/jscans.py recompiles only if the class is missing
CP=$(find "$GHIDRA_INSTALL_DIR/Ghidra/Framework" "$GHIDRA_INSTALL_DIR/Ghidra/Features/Base" "$GHIDRA_INSTALL_DIR/Ghidra/Features/Decompiler" -name '*.jar' | tr '\n' ':')
"$JAVA_HOME/bin/javac" -nowarn -cp "$CP" -d $B/sidecar/jscans/out sidecar/jscans/*.java

# --- Notices and build info (license texts are copied from the sources, never retyped)
N=$B/THIRD_PARTY_NOTICES; mkdir -p $N/{ghidra,jdk,python,jpype,websockets,electron,monaco,react,tanstack}
cp "$GHIDRA_INSTALL_DIR/LICENSE" $N/ghidra/LICENSE; [ -n "${GHIDRA_SRC:-}" ] && cp "$GHIDRA_SRC/NOTICE" $N/ghidra/NOTICE   # NOTICE is not in the distribution zip
cp $B/jdk/legal/java.base/{LICENSE,ASSEMBLY_EXCEPTION,ADDITIONAL_LICENSE_INFO} $N/jdk/
cp $B/python/lib/python3.12/LICENSE.txt $N/python/LICENSE.cpython.txt
curl -fsSL https://raw.githubusercontent.com/astral-sh/python-build-standalone/main/LICENSE -o $N/python/LICENSE.python-build-standalone.txt
SP=$B/python/lib/python3.12/site-packages
cp $SP/jpype1-*.dist-info/licenses/{LICENSE,NOTICE} $N/jpype/; cp $SP/websockets-*.dist-info/licenses/LICENSE $N/websockets/
for f in $SP/packaging-*.dist-info/licenses/LICENSE*; do cp $f $N/python/LICENSE.packaging${f##*/LICENSE}; done
cp $SP/typing_extensions-*.dist-info/licenses/LICENSE $N/python/LICENSE.typing_extensions; cp $SP/pyghidra-*.dist-info/licenses/LICENSE $N/python/LICENSE.pyghidra
NM=app/node_modules
cp $NM/monaco-editor/{LICENSE,ThirdPartyNotices.txt} $N/monaco/; cp $NM/@monaco-editor/react/LICENSE $N/monaco/LICENSE.monaco-editor-react; cp $NM/@monaco-editor/loader/LICENSE $N/monaco/LICENSE.monaco-editor-loader
[ -f $NM/state-local/LICENSE ] && cp $NM/state-local/LICENSE $N/monaco/LICENSE.state-local
cp $NM/react/LICENSE $N/react/LICENSE.react; cp $NM/react-dom/LICENSE $N/react/LICENSE.react-dom; cp $NM/scheduler/LICENSE $N/react/LICENSE.scheduler
cp $NM/@tanstack/react-virtual/LICENSE $N/tanstack/LICENSE.react-virtual; cp $NM/@tanstack/virtual-core/LICENSE $N/tanstack/LICENSE.virtual-core
cp $NM/electron/dist/LICENSE $N/electron/LICENSE.electron   # LICENSES.chromium.html is already shipped by Electron in Contents/Resources
cp packaging/THIRD_PARTY_NOTICES.md $N/README.md
# Ghidra records the commit it was built from; GHIDRA_SRC (optional) is cross-checked against it
GP="$GHIDRA_INSTALL_DIR/Ghidra/application.properties"; prop() { sed -n "s/^$1=//p" "$GP"; }
node -e '
const [out, gc, gv, jdk, py, el, app, ghidraSrc] = process.argv.slice(1);
require("fs").writeFileSync(out, JSON.stringify({ app, ghidraCommit: gc, ghidraVersion: gv, ghidraSrcHead: ghidraSrc || null, jdk, python: py, electron: el, builtAt: new Date().toISOString() }, null, 2) + "\n");
' $B/BUILD_INFO.json "$(prop application.revision.ghidra)" "$(prop application.version)-$(prop application.release.name) ($(prop application.build.date.short))" \
  "$(sed -n 's/^JAVA_VERSION="\(.*\)"/\1/p' $B/jdk/release)" "$($PY -c 'import platform;print(platform.python_version())')" "$(node -p 'require("./app/node_modules/electron/package.json").version')" "$(node -p 'require("./app/package.json").version')" "$([ -n "${GHIDRA_SRC:-}" ] && git -C "$GHIDRA_SRC" rev-parse HEAD || true)"
cat $B/BUILD_INFO.json
echo "bundle staged:"; du -sh $B/jdk $B/ghidra $B/python $B/sidecar $B/THIRD_PARTY_NOTICES

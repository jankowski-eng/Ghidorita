#!/bin/sh
# compile RowFetcher against the Ghidra jars
D=$(cd "$(dirname "$0")" && pwd)
CP=$(find "$GHIDRA_INSTALL_DIR/Ghidra/Framework" "$GHIDRA_INSTALL_DIR/Ghidra/Features/Base" -name '*.jar' | tr '\n' ':')
mkdir -p "$D/java/out" && "$JAVA_HOME/bin/javac" -cp "$CP" -d "$D/java/out" "$D/java/RowFetcher.java"

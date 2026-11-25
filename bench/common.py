import os, pathlib, time
HERE = pathlib.Path(__file__).resolve().parent
GHIDRA = os.environ.get("GHIDRA_INSTALL_DIR", str(HERE.parent / "ghidra-install/ghidra_12.3_DEV"))
JAVA_HOME = os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home")
PROJ = HERE / "projects"


def start_jvm():
    from pyghidra.launcher import HeadlessPyGhidraLauncher
    l = HeadlessPyGhidraLauncher(install_dir=pathlib.Path(GHIDRA))
    l.java_home = pathlib.Path(JAVA_HOME)
    l.start()


def build_index(prog):
    it = prog.getListing().getCodeUnits(prog.getMemory().getLoadedAndInitializedAddressSet(), True)
    return [cu.getMinAddress().getOffset() for cu in it]

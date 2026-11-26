"""The Java helper (sidecar/jscans/GhidretteScans.java): the loops that were Python over JPype objects (defined-string scan, symbol kind
filter and sort) run in Java next to the data, so only results cross into Python and the GIL is released while they run."""
import glob, os, shutil, subprocess, sys, tempfile

SIDECAR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIR = None
_cls = []


def build():
    """Directory with the compiled GhidretteScans.class (loaded by `scans()`). Compiled with $JAVA_HOME/bin/javac against the Ghidra jars
    when the class is missing or older than the source; a bundle ships it precompiled (packaging/prepare.sh). Call before the JVM starts."""
    global DIR
    sources = sorted(glob.glob(os.path.join(SIDECAR, "jscans", "*.java")))
    out = os.path.join(SIDECAR, "jscans", "out")
    cls = os.path.join(out, "GhidretteScans.class")
    DIR = out
    if os.path.exists(cls) and all(os.path.getmtime(cls) >= os.path.getmtime(src) for src in sources):
        return out
    gh = os.environ["GHIDRA_INSTALL_DIR"]
    cp = ":".join(j for d in ("Framework", "Features/Base", "Features/Decompiler")
                  for j in glob.glob(os.path.join(gh, "Ghidra", d, "**", "*.jar"), recursive=True))
    javac = os.path.join(os.environ["JAVA_HOME"], "bin", "javac") if os.environ.get("JAVA_HOME") else shutil.which("javac")
    os.makedirs(out, exist_ok=True)
    tmp = tempfile.mkdtemp(dir=out)  # a concurrent sidecar compiling the same file must never see a half-written class
    try:
        subprocess.run([javac, "-nowarn", "-cp", cp, "-d", tmp, *sources], check=True, capture_output=True, text=True)
        for f in sorted(os.listdir(tmp), key=lambda f: f == "GhidretteScans.class"):
            os.replace(os.path.join(tmp, f), os.path.join(out, f))
    except subprocess.CalledProcessError as e:
        sys.exit("javac failed for sidecar scan helpers:\n%s" % e.stderr)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out


def scans():
    """The GhidretteScans class. Loaded through a URLClassLoader whose parent is Ghidra's own loader: the application class path does not see
    Ghidra's classes (NoClassDefFoundError for Program), so add_classpaths is not enough. Needs the JVM."""
    if not _cls:
        from java.io import File
        from java.net import URLClassLoader
        from jpype import JClass
        from ghidra.program.model.listing import Program
        cl = URLClassLoader([File(DIR).toURI().toURL()], Program.class_.getClassLoader())
        _cls.append(JClass(cl.loadClass("GhidretteScans")))
    return _cls[0]

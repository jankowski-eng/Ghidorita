"""In-process harness: the sidecar methods called directly on programs built by hand (no import, no analysis, no WebSocket)."""
import asyncio, glob, os, pathlib, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
JAVA = os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home")
INVALID = -32602


def start():
    gd = os.environ.get("GHIDRA_INSTALL_DIR") or sorted(glob.glob(os.path.join(HERE, "..", "ghidra-install", "ghidra_*/")))[-1]
    os.environ.setdefault("GHIDRA_INSTALL_DIR", str(gd))
    os.environ.setdefault("JAVA_HOME", JAVA)
    from ghidrette.core import jscans
    jscans.build()  # the Java scan helper is compiled before the JVM starts
    from pyghidra.launcher import HeadlessPyGhidraLauncher
    launcher = HeadlessPyGhidraLauncher(install_dir=pathlib.Path(gd))
    launcher.java_home = pathlib.Path(JAVA)
    launcher.add_vmargs("-Djava.awt.headless=true")
    launcher.start()
    from ghidrette.app import App
    return Shim(App(start=False))


class Shim:
    """The methods under test, called in-process: the session's helpers and every domain's RPCs behind one object."""
    def __init__(self, app):
        self.app, self.ses = app, app.ctx.session
        from ghidrette.core.lanes import Worker
        app.ctx.lanes.tl.w = Worker()  # this thread plays a decompiler worker
        app.ctx.loop = asyncio.new_event_loop()  # events.record schedules the change notification on it; never run here

    program = property(lambda s: s.ses.program, lambda s, v: setattr(s.ses, "program", v))

    def __getattr__(self, name):
        for o in (self.ses, *self.app.domains):
            if hasattr(o, name):
                return getattr(o, name)
        raise AttributeError(name)


def build(sc, name, blocks, lang="x86:LE:64:default"):
    """Program with initialized blocks: (name, offset, bytes, overlay). Becomes sc.program."""
    from java.io import ByteArrayInputStream
    from java.lang import Object
    from ghidra.program.database import ProgramDB
    from ghidra.program.model.lang import LanguageID
    from ghidra.program.util import DefaultLanguageService
    from ghidra.util.task import TaskMonitor
    from jpype import JArray, JByte
    language = DefaultLanguageService.getLanguageService().getLanguage(LanguageID(lang))
    prog = ProgramDB(name, language, language.getDefaultCompilerSpec(), Object())
    tx = prog.startTransaction("init")
    sp = prog.getAddressFactory().getDefaultAddressSpace()
    for bname, off, data, overlay in blocks:
        arr = JArray(JByte)([b - 256 if b > 127 else b for b in data])
        prog.getMemory().createInitializedBlock(bname, sp.getAddress(off - (1 << 64) if off >= 1 << 63 else off), ByteArrayInputStream(arr), len(data), TaskMonitor.DUMMY, overlay)
    prog.endTransaction(tx, True)
    ev = sc.app.ctx.events
    ev.detach(sc.ses.program)
    sc.program = prog
    ev.reset()  # derived caches (decompile) belong to the previous program
    ev.attach(prog)
    sc.ses.epoch += 1  # decompiler workers key their DecompInterface on it
    return prog


# push rbp; mov rbp,rsp; call +5 (-> 0xa); ret; push rbp; ret
CODE = bytes([0x55, 0x48, 0x89, 0xE5, 0xE8, 0x01, 0x00, 0x00, 0x00, 0xC3, 0x55, 0xC3]) + bytes(52)



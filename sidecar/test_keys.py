"""programId keys (protocol.md "Persistence key"); no JVM needed."""
import main

SHA = "a" * 64


def test_reduced_analysis_gets_its_own_key(monkeypatch):
    monkeypatch.delenv("SIDECAR_ANALYSIS_DISABLE", raising=False)
    full = main.Sidecar._program_key(SHA, {})
    raw = main.Sidecar._program_key(SHA, {"loader": "Raw Binary"})
    assert full == SHA
    monkeypatch.setenv("SIDECAR_ANALYSIS_DISABLE", "Stack;Call Convention ID")
    fast = main.Sidecar._program_key(SHA, {})
    assert fast != full and main.KEY_RE.match(fast)
    assert main.Sidecar._program_key(SHA, {"loader": "Raw Binary"}) not in (raw, fast)
    monkeypatch.setenv("SIDECAR_ANALYSIS_DISABLE", "Call Convention ID;Stack")  # order does not matter
    assert main.Sidecar._program_key(SHA, {}) == fast


def test_profile_keys(monkeypatch):
    monkeypatch.delenv("SIDECAR_ANALYSIS_DISABLE", raising=False)
    fast = main.Sidecar._program_key(SHA, {"profile": "fast"}, main.FAST_PROFILE)
    assert fast != SHA and main.KEY_RE.match(fast)
    # the profile is not an import option: "full" is the plain key, "fast" equals the old env-var key of round 4
    assert main.Sidecar._program_key(SHA, {"profile": "full"}, []) == SHA
    monkeypatch.setenv("SIDECAR_ANALYSIS_DISABLE", ";".join(main.FAST_PROFILE))
    assert main.Sidecar._program_key(SHA, {}) == fast
    assert main.Sidecar._program_key(SHA, {}, []) == SHA  # an explicit profile "full" beats the env var
    assert main.FAST_PROFILE == sorted(main.FAST_PROFILE)


def test_version_and_memory_errors_are_not_corruption():
    class Cls:
        def __init__(self, n): self.n = n
        def getSimpleName(self): return self.n

    class JavaErr(Exception):
        def __init__(self, n, ind=0): self.n, self.ind = n, ind
        def getClass(self): return Cls(self.n)
        def getVersionIndicator(self): return self.ind

    nc = main.Sidecar._not_corruption
    assert nc(JavaErr("VersionException", 2))      # saved by a newer Ghidra build
    assert nc(JavaErr("VersionException", 1))
    assert nc(JavaErr("OutOfMemoryError"))
    assert nc(MemoryError())
    assert not nc(JavaErr("VersionException", 0))  # unknown version: a damaged file
    assert not nc(JavaErr("IOException"))

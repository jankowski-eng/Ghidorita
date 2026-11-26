"""programId keys (protocol.md "Persistence key"); no JVM needed."""
from ghidrette.domains import project

SHA = "a" * 64


def test_reduced_analysis_gets_its_own_key(monkeypatch):
    monkeypatch.delenv("SIDECAR_ANALYSIS_DISABLE", raising=False)
    full = project.program_key(SHA, {})
    raw = project.program_key(SHA, {"loader": "Raw Binary"})
    assert full == SHA
    monkeypatch.setenv("SIDECAR_ANALYSIS_DISABLE", "Stack;Call Convention ID")
    fast = project.program_key(SHA, {})
    assert fast != full and project.KEY_RE.match(fast)
    assert project.program_key(SHA, {"loader": "Raw Binary"}) not in (raw, fast)
    monkeypatch.setenv("SIDECAR_ANALYSIS_DISABLE", "Call Convention ID;Stack")  # order does not matter
    assert project.program_key(SHA, {}) == fast


def test_profile_keys(monkeypatch):
    monkeypatch.delenv("SIDECAR_ANALYSIS_DISABLE", raising=False)
    fast = project.program_key(SHA, {"profile": "fast"}, project.FAST_PROFILE)
    assert fast != SHA and project.KEY_RE.match(fast)
    # the profile is not an import option: "full" is the plain key, "fast" equals the old env-var key of round 4
    assert project.program_key(SHA, {"profile": "full"}, []) == SHA
    monkeypatch.setenv("SIDECAR_ANALYSIS_DISABLE", ";".join(project.FAST_PROFILE))
    assert project.program_key(SHA, {}) == fast
    assert project.program_key(SHA, {}, []) == SHA  # an explicit profile "full" beats the env var
    assert project.FAST_PROFILE == sorted(project.FAST_PROFILE)

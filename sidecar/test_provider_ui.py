"""The same built Electron app with both providers, plus a fault-injection session regression."""
import json
import os
from pathlib import Path
import subprocess

import pytest

from testlib import BIN, JAVA, ghidra_dir

APP = Path(__file__).resolve().parent.parent / "app"


@pytest.fixture(scope="module")
def electron():
    subprocess.run(["npm", "run", "build"], cwd=APP, check=True, capture_output=True)
    return APP / "node_modules/.bin/electron"


@pytest.mark.parametrize("provider", ["fixture", "pyghidra", "mock"])
def test_provider_in_built_electron(electron, provider, tmp_path):
    env = {**os.environ, "GHIDRETTE_PROVIDER": provider, "AUTOTEST_FLOW": "browsing"}
    env.pop("JAVA_HOME", None)
    env.pop("GHIDRA_INSTALL_DIR", None)
    env.pop("SIDECAR_PROJECTS_DIR", None)
    if provider == "pyghidra":
        env.update(JAVA_HOME=JAVA, GHIDRA_INSTALL_DIR=ghidra_dir(),
                   SIDECAR_PROJECTS_DIR=str(tmp_path / "projects"), AUTOTEST=BIN)
    elif provider == "fixture":
        env["AUTOTEST"] = str(APP / "providers/example.ghidrette.json")
    else:
        env.update(AUTOTEST="/program-a", AUTOTEST_FLOW="replacement", MOCK_SWITCH_FAILURES="1")
    process = subprocess.run([electron, "."], cwd=APP, env=env, capture_output=True, text=True, timeout=180)
    results = [line for line in process.stdout.splitlines() if line.startswith("AUTOTEST_RESULT ")]
    assert results, (process.stdout[-2000:], process.stderr[-4000:])
    result = json.loads(results[-1].split(" ", 1)[1])
    print(provider, result)
    assert process.returncode == 0 and result["ok"], (result, process.stderr[-4000:])


@pytest.mark.parametrize("provider", ["pyghidra", "mock"])
def test_event_during_failed_open_is_applied_to_the_kept_session(electron, provider, tmp_path):
    env = {**os.environ, "GHIDRETTE_PROVIDER": provider, "AUTOTEST_FLOW": "open-preserve"}
    env.pop("SIDECAR_PROJECTS_DIR", None)
    if provider == "pyghidra":
        env.update(JAVA_HOME=JAVA, GHIDRA_INSTALL_DIR=ghidra_dir(), SIDECAR_PROJECTS_DIR=str(tmp_path / "projects"), AUTOTEST="/bin/ls")
    else:
        env["AUTOTEST"] = "/program-a"
    process = subprocess.run([electron, "."], cwd=APP, env=env, capture_output=True, text=True, timeout=180)
    results = [line for line in process.stdout.splitlines() if line.startswith("AUTOTEST_RESULT ")]
    assert results, (process.stdout[-2000:], process.stderr[-4000:])
    result = json.loads(results[-1].split(" ", 1)[1])
    print(provider, result)
    assert process.returncode == 0 and result["ok"], (result, process.stderr[-4000:])

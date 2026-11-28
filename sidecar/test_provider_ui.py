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
    env = {**os.environ, "GHIDORITA_PROVIDER": provider, "AUTOTEST_FLOW": "browsing"}
    env.pop("JAVA_HOME", None)
    env.pop("GHIDRA_INSTALL_DIR", None)
    env.pop("SIDECAR_PROJECTS_DIR", None)
    if provider == "pyghidra":
        env.update(JAVA_HOME=JAVA, GHIDRA_INSTALL_DIR=ghidra_dir(),
                   SIDECAR_PROJECTS_DIR=str(tmp_path / "projects"), AUTOTEST=BIN)
    elif provider == "fixture":
        env["AUTOTEST"] = str(APP / "providers/example.ghidorita.json")
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
    env = {**os.environ, "GHIDORITA_PROVIDER": provider, "AUTOTEST_FLOW": "open-preserve"}
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


def test_debugger_flow_in_built_electron_with_the_mock(electron):
    """Attach, stop highlight, registers, statement step, locals, history back/forward, memory, breakpoint, detach, through the UI (the mock fakes a stopped target)."""
    env = {**os.environ, "GHIDORITA_PROVIDER": "mock", "AUTOTEST_FLOW": "debug", "AUTOTEST": "/program-a"}
    process = subprocess.run([electron, "."], cwd=APP, env=env, capture_output=True, text=True, timeout=180)
    results = [line for line in process.stdout.splitlines() if line.startswith("AUTOTEST_RESULT ")]
    assert results, (process.stdout[-2000:], process.stderr[-4000:])
    result = json.loads(results[-1].split(" ", 1)[1])
    print(result)
    assert process.returncode == 0 and result["ok"], (result, process.stderr[-4000:])


@pytest.mark.parametrize("provider", ["mock", "pyghidra"])
def test_agent_access_flow_in_built_electron(electron, provider, tmp_path):
    """A scripted MCP client (SDK client -> bridge -> the app's socket) runs status, decompile, rename_variable and undo_agent_edit; the app shows the edit tagged with the client, refreshes, and undoes it (the mock and real Ghidra)."""
    import tempfile
    sock_dir = tempfile.mkdtemp(prefix="gh-", dir="/tmp")  # short: sockets have a 104 byte path limit
    env = {**os.environ, "GHIDORITA_PROVIDER": provider, "AUTOTEST_FLOW": "agent", "AUTOTEST": "/program-a",
           "GHIDORITA_AGENT_SOCKET": os.path.join(sock_dir, "a.sock"), "GHIDORITA_AGENT_MODE": "edit"}
    env.pop("SIDECAR_PROJECTS_DIR", None)
    if provider == "pyghidra":
        env.update(JAVA_HOME=JAVA, GHIDRA_INSTALL_DIR=ghidra_dir(), SIDECAR_PROJECTS_DIR=str(tmp_path / "projects"), AUTOTEST=BIN)
    app = subprocess.Popen([electron, "."], cwd=APP, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        client = subprocess.run(["node", "scripts/agent-autotest-client.mjs"], cwd=APP, env=env, capture_output=True, text=True, timeout=150)
        out, err = app.communicate(timeout=60)
    finally:
        app.kill()
    assert client.returncode == 0, (client.stdout[-2000:], client.stderr[-2000:])
    results = [line for line in out.splitlines() if line.startswith("AUTOTEST_RESULT ")]
    assert results, (out[-2000:], err[-4000:])
    result = json.loads(results[-1].split(" ", 1)[1])
    print(result)
    assert app.returncode == 0 and result["ok"], (result, err[-4000:])

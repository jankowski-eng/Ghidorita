"""The Electron app against the real sidecar, one focused flow each (AUTOTEST_FLOW, see app/src/renderer/autotest/autotestFlows.ts). Needs a display (the autotest opens a window)."""
import json, os, subprocess

import pytest

from testlib import HERE, JAVA, Client, Proc, ghidra_dir, run
from test_big import BIG, PROJECTS

APP = os.path.join(HERE, "..", "app")


def electron(flow, file, projects, extra=None, timeout=1200):
    env = dict(os.environ, AUTOTEST=file, AUTOTEST_FLOW=flow, SIDECAR_PROJECTS_DIR=str(projects), JAVA_HOME=JAVA, GHIDRA_INSTALL_DIR=os.path.realpath(ghidra_dir()), **(extra or {}))
    subprocess.run(["npm", "run", "build"], cwd=APP, env=env, check=True, capture_output=True)
    p = subprocess.run([os.path.join(APP, "node_modules", ".bin", "electron"), "."], cwd=APP, env=env, capture_output=True, text=True, timeout=timeout)
    lines = [l for l in p.stdout.splitlines() if l.startswith("AUTOTEST_RESULT ")]
    assert lines, "no AUTOTEST_RESULT\n" + p.stdout[-2000:] + p.stderr[-2000:]
    return json.loads(lines[-1].split(" ", 1)[1]), p.returncode


def test_project_locked_message_in_the_ui(tmp_path):
    """A second Ghidorita on a projects dir another sidecar holds: the programs pane shows 'projects dir in use by another Ghidorita'."""
    holder = Proc(tmp_path / "projects")

    async def hold():
        async with Client(holder.port) as c:
            await c.ok("list_programs")  # touches the project: the lock is taken
    try:
        run(hold())
        res, code = electron("locked", "/bin/ls", tmp_path / "projects")
    finally:
        holder.stop()
    print(res["locked"])
    assert res["ok"] and code == 0 and "projects dir in use by another Ghidorita" in res["locked"]["text"], res


def test_big_file_defaults_to_fast_and_huge_function_flow():
    """Real >20 MB file: the import dialog defaults to Fast; size warning, Cancel, Decompile anyway and a real Timeout on the real sidecar."""
    if not (os.path.isfile(BIG) and os.path.isdir(PROJECTS)):
        pytest.skip("no stored analysis of the big binary (see test_big.py)")
    res, code = electron("big", BIG, PROJECTS, {"AUTOTEST_DECOMPILE_TIMEOUT": "1"})
    print(res["big"])
    assert res["ok"] and code == 0, res


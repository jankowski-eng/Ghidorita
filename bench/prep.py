"""usage: prep.py NAME BINARY [max_analysis_minutes] -- import+analyse once, save in bench/projects/NAME."""
import json, sys, time
from common import *
name, binary = sys.argv[1], sys.argv[2]
cap = float(sys.argv[3]) if len(sys.argv) > 3 else 45
start_jvm()
import pyghidra
from ghidra.util.task import TimeoutTaskMonitor
from java.util.concurrent import TimeUnit
res = {"binary": binary}
t = time.monotonic()
with pyghidra.open_program(binary, PROJ, name, analyze=False, program_name="prog") as flat:
    prog = flat.getCurrentProgram()
    res["import_s"] = round(time.monotonic() - t, 1)
    print("imported", res["import_s"], flush=True)
    t = time.monotonic()
    mon = TimeoutTaskMonitor.timeoutIn(int(cap * 60), TimeUnit.SECONDS)
    pyghidra.analyze(prog, mon)
    res["analysis_s"] = round(time.monotonic() - t, 1)
    res["analysis_timed_out"] = bool(mon.isCancelled())
    res["functions"] = int(prog.getFunctionManager().getFunctionCount())
    print(res, flush=True)
    t = time.monotonic()
    idx = build_index(prog)
    res["index_s"], res["rows"] = round(time.monotonic() - t, 2), len(idx)
    print(res, flush=True)
json.dump(res, open(PROJ / (name + ".json"), "w"), indent=1)

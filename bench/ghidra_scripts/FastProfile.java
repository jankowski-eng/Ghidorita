// -preScript for bench_headless.py --fast: the same three analyzers Ghidrette's "fast" profile switches off (sidecar/ghidrette/domains/project.py FAST_PROFILE).
import ghidra.app.script.GhidraScript;

public class FastProfile extends GhidraScript {
    @Override
    protected void run() throws Exception {
        for (String n : new String[] {"Call Convention ID", "Decompiler Switch Analysis", "Stack"}) {
            setAnalysisOption(currentProgram, n, "false");
        }
    }
}

import { waitFor, type AutotestCtx } from "./autotest";

/**
 * The app's half of the agent's debugger steps (scripts/agent-autotest-debug.mjs, Full access, the mock's fake target): the agent attaches, steps, continues, pauses and
 * detaches through MCP; here we only watch that the UI follows (stop highlighted, state changes counted, detached at the end). Call it after the agent flow's own checks.
 */
export async function runAgentDebugFlow(c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.agentDebug = {});
  const stops = new Set<number>();
  let running = false;
  const timer = setInterval(() => { const d = c.debug(); if (d?.state === "stopped") stops.add(d.stop); if (d?.state === "running") running = true; }, 25);
  try {
    await waitFor(() => c.debug()?.state === "stopped", 60000, "the agent's attach");
    R.highlighted = await waitFor(() => !!document.querySelector(".lrow.pc"), 10000, "the stop highlighted in the listing").then(() => true, () => false);
    await waitFor(() => c.debug()?.state === "running", 60000, "the agent's continue");
    await waitFor(() => c.debug()?.state === "detached", 60000, "the agent's detach");
  } finally { clearInterval(timer); }
  R.stops = stops.size; R.sawRunning = running;
  return !!R.highlighted && stops.size >= 4 && running && c.errors.length === 0;
}

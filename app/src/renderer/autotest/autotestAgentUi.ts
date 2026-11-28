import { setFollowAgent } from "../features/agentFollow";
import { waitFor, type AutotestCtx } from "./autotest";

/**
 * The app side of scripts/agent-autotest-ui.mjs (not wired into runAgentFlow; the orchestrator calls it). The scripted client highlights `entry` and its first lines, then reads `follow`;
 * here we check the DOM: listing rows and decompiler tokens carry the value-trail classes, a clear removes them, "Follow agent" moves the view. NOT RUN in this stream (needs a display).
 */
export async function runAgentUiChecks(c: AutotestCtx, entry: string, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.agentUi = {});
  const rows = () => document.querySelectorAll(".lrow.trail-f").length, lines = () => document.querySelectorAll(".view-lines .trail-forward").length;
  await c.select(entry);
  R.listingMarked = await waitFor(() => rows() > 0, 8000, "listing rows tinted by highlight").then(() => true, () => false);
  R.decompilerMarked = await waitFor(() => lines() > 0, 8000, "decompiler marks from highlight").then(() => true, () => false);
  if (!R.decompilerMarked) R.dom = { spans: document.querySelectorAll('[class*="trail"]').length, viewLines: document.querySelectorAll(".view-lines").length, text: c.editorText().slice(0, 120) };
  R.cleared = await waitFor(() => rows() === 0 && lines() === 0, 30000, "highlight cleared").then(() => true, () => false);
  setFollowAgent(true); // what the Agent > Follow Agent menu command does
  R.followed = await waitFor(() => { const at = c.selected(); return !!at && at !== entry; }, 30000, "the view to follow the agent's decompile of another function").then(() => true, () => false);
  setFollowAgent(false);
  return R.listingMarked && R.decompilerMarked && R.cleared && R.followed && c.errors.length === 0;
}

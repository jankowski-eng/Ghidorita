import { setFollowAgent } from "../features/agentFollow";
import { waitFor, type AutotestCtx } from "./autotest";

/**
 * The app side of scripts/agent-autotest-ui.mjs (not wired into runAgentFlow; the orchestrator calls it). The scripted client highlights `entry` and its first lines, then reads `follow`;
 * here we check the DOM: listing rows and decompiler tokens carry the value-trail classes, a clear removes them, "Follow agent" moves the view. NOT RUN in this stream (needs a display).
 */
export async function runAgentUiChecks(c: AutotestCtx, entry: string, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.agentUi = {});
  const say = (comment: string) => c.program().bookmarks.set({ address: entry, category: "autotest", comment });
  const rows = () => document.querySelectorAll(".lrow.trail-f").length, lines = () => document.querySelectorAll(".view-lines .trail-forward").length;
  let seenRows = false, seenLines = false; // latched: the marks are on screen only until the client clears them
  const sampler = setInterval(() => { seenRows ||= rows() > 0; seenLines ||= lines() > 0; }, 40);
  await c.select(entry);
  await waitFor(() => seenRows && seenLines, 60000, "highlight marks in the listing and the decompiler").catch(() => {});
  clearInterval(sampler);
  R.listingMarked = seenRows; R.decompilerMarked = seenLines;
  await say("ui seen");
  R.cleared = await waitFor(() => rows() === 0 && lines() === 0, 30000, "highlight cleared").then(() => true, () => false);
  if (!R.cleared) R.left = { rows: rows(), lines: lines(), row: document.querySelector(".lrow.trail-f")?.textContent?.slice(0, 80), tok: document.querySelector(".view-lines .trail-forward")?.textContent?.slice(0, 80) };
  setFollowAgent(true); await say("ui armed"); // what the Agent > Follow Agent menu command does
  R.followed = await waitFor(() => { const at = c.selected(); return !!at && at !== entry; }, 30000, "the view to follow the agent's decompile of another function").then(() => true, () => false);
  setFollowAgent(false);
  return R.listingMarked && R.decompilerMarked && R.cleared && R.followed && c.errors.length === 0;
}

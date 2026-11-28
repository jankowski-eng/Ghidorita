import { changeLog, type Change } from "../changeLog";
import { sleep, waitFor, type AutotestCtx } from "./autotest";

export const AGENT_CLIENT = "agent-autotest", AGENT_NEWNAME = "agent_counter"; // the scripted client (scripts/agent-autotest-client.mjs) sends exactly these

/**
 * Agent access end to end: a scripted MCP client (a separate process, through the real bridge and socket) runs status -> decompile -> rename_variable -> undo_agent_edit.
 * Here we only watch the app: the edit shows in the Changes panel tagged with the client, the decompiler and the listing refresh, the undo flips the entry, the status bar names the client.
 */
export async function runAgentFlow(file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.agent = {});
  const fl = await c.open(file);
  void fl;
  c.command({ type: "dock", panel: "changes" });
  const text = () => document.body.innerText;
  let changes = 0; const off = c.backend.events.onChange(() => { changes++; });
  const seen: Change[] = []; // every state of every entry, in order
  const stop = changeLog.subscribe(() => { for (const e of changeLog.items) if (!seen.some((s) => s.id === e.id && s.undone === e.undone && s.by === e.by)) seen.push(e); });
  let clients = 0; const offState = (window as any).host.onAgentState((s: { clients: string[] }) => { clients = s.clients.length; });
  try {
    const live = await waitFor(() => changeLog.items.find((e) => !e.undone && e.by), 60000, "an agent edit in the change log");
    R.entry = { label: live.label, by: live.by };
    await c.select(live.address!); // the function the agent edited (a real binary has many; the client picks the first with a variable)
    await waitFor(() => c.editorText().includes(AGENT_NEWNAME), 30000, "the decompiler to show the renamed variable");
    R.panel = await waitFor(() => text().includes(`${live.label} · ${AGENT_CLIENT}`), 5000, "the Changes panel to name the client").then(() => true, () => false);
    R.statusBar = await waitFor(() => document.querySelector('button[aria-label*="Agent"]')?.textContent?.includes(AGENT_CLIENT), 5000, "the status bar to name the client").then(() => true, () => false);
    R.refreshed = await waitFor(() => changes > 0, 5000, "program_changed for the agent's edit").then(() => true, () => false); // it follows the change-log entry by the sidecar's coalescing window
    // the user edits too: the agent's undo must now refuse (the client checks), and our own undo must take only our edit
    await c.program().edits.setComment({ address: live.address!, kind: "eol", text: "user note" });
    const mine = await waitFor(() => changeLog.items.find((e) => !e.undone && !e.by && /Comment/.test(e.label)), 5000, "the user's edit in the change log");
    R.userUntagged = true;
    await sleep(1500); // the client's undo attempt
    R.agentKept = !changeLog.items.find((e) => e.id === live.id)?.undone;
    c.command({ type: "edit", action: "undo" });
    await waitFor(() => changeLog.items.find((e) => e.id === mine.id)?.undone, 10000, "our undo of the user's edit");
    await waitFor(() => changeLog.items.find((e) => e.id === live.id)?.undone, 30000, "the agent's undo");
    await waitFor(() => !c.editorText().includes(AGENT_NEWNAME), 30000, "the decompiler to show the original name again");
    R.undone = true;
    await waitFor(() => clients === 0, 30000, "the client to disconnect"); // it checks its own results after the undo
    R.statusBarGone = await waitFor(() => !document.querySelector('button[aria-label*="Agent"]'), 5000, "the badge to go").then(() => true, () => false);
    await sleep(100);
  } finally { off(); stop(); offState(); }
  R.byTags = seen.filter((e) => /Rename/.test(e.label)).every((e) => e.by === AGENT_CLIENT) && seen.filter((e) => /Comment/.test(e.label)).every((e) => !e.by);
  return R.entry.by === AGENT_CLIENT && /variable|Rename/i.test(R.entry.label) && R.panel && R.statusBar && R.refreshed && R.userUntagged && R.agentKept && R.undone && R.statusBarGone && R.byTags && c.errors.length === 0;
}

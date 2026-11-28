import type { Address } from "../../../../protocol";
import { resolveAddress } from "../../agent/resolve";
import type { ProgramOperations } from "../backend";
import type { Views } from "../store/views";

// "Follow agent" (Agent menu): the view goes to what a read tool targets. React-free; features/agent.ts wires it to `onCall`.
let on = false;
export const setFollowAgent = (v: boolean) => { on = v; };
export const followingAgent = () => on;

/** Per read tool, the arguments that name where it looks, first one present wins (xrefs: `function` when the target is a variable). Edit tools are not here: following is for reading. */
const TARGETS: Record<string, readonly string[]> = {
  decompile: ["function"], disassemble: ["at"], xrefs: ["function", "target"], calls: ["function"], call_graph: ["function"],
  stack_frame: ["function"], function_graph: ["function"], pcode: ["function"], value_trail: ["function"],
};
export function followTarget(tool: string, args: Record<string, unknown>): string | null {
  for (const k of TARGETS[tool] ?? []) { const v = args?.[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return null;
}

/** Follow agent: the view goes to what a read tool targets, once per burst of calls, and never while the user is in a dialog or the app is busy. Errors (an unknown name) leave the view alone. */
export function followAgent(s: { program(): { api: ProgramOperations } | null; blocked(): boolean; views: { getState(): Views } }, go: (a: Address) => Promise<void>, ms = 300) {
  return debounced((tool: string, args: Record<string, unknown>) => {
    const target = followTarget(tool, args), p = s.program(), v = s.views.getState();
    if (!target || !p || s.blocked() || v.dlg || v.formDlg || v.gotoOpen || v.searchOpen || v.agentAsk) return;
    void resolveAddress(target, p.api, undefined, true).then(go).catch(() => {});
  }, ms);
}

/** Trailing debounce: rapid calls (an agent reading ten functions) move the view once, to the last one. */
export function debounced<A extends unknown[]>(f: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Object.assign((...a: A) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }, { cancel: () => clearTimeout(t) });
}

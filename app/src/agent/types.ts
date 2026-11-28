import type { ActiveSession, Address, Capability, FunctionInfo } from "../../../protocol";
import type { ApplicationBackend, ProgramOperations } from "../renderer/backend";

// The contracts of the agent layer (docs/AGENTS_MCP.md). Main, the renderer executor and the tool files all build against this file.
// Layering: src/agent/ imports only renderer/backend.ts, protocol.ts, parseGoto.ts and address.ts (pure), never rpc.ts, wire.ts, React or the store.

/** What the user allows. `off` offers `status` only. Order matters: each mode includes the ones before it. */
export type AccessMode = "off" | "read" | "edit" | "full";
export const ACCESS_MODES: readonly AccessMode[] = ["off", "read", "edit", "full"];
const RANK: Record<AccessMode, number> = { off: 0, read: 1, edit: 2, full: 3 };
/** A tool's `access` is the lowest mode that offers it (`status` is "off": offered everywhere). */
export const modeAllows = (mode: AccessMode, access: AccessMode): boolean => RANK[mode] >= RANK[access];

/** The error text is returned to the agent as an `isError` tool result: write it as an instruction ("analysis is running: call wait_for_analysis"). */
export class ToolError extends Error {}

export interface JsonSchema { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: false }
/** MCP tool annotations. Set all three on every tool so clients that prompt per tool ask at the right moments. */
export interface ToolAnnotations { title?: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint?: false }

/** What the user is looking at (the `get_view` tool). Every field is null when there is nothing. */
export interface AgentView {
  /** the cursor address (listing or decompiler) */
  address: Address | null;
  function: { name: string; entry: Address } | null;
  /** entry of the active decompiler tab */
  tab: Address | null;
  /** the decompiler token or listing row under the cursor, as text */
  under: string | null;
  selection: string | null;
}
/** What the agent marks: addresses (rows and the decompiler tokens at them) and 1-based decompiler lines of a function, `entry` being resolved. Cleared on a program change. */
export interface AgentHighlight { addresses: Address[]; lines: { entry: Address; from: number; to: number }[]; label?: string }
/** UI access for app mode. Absent (`ctx.ui` undefined) in a headless host: tools with `appOnly` aren't listed there. */
export interface AgentUi {
  view(): Promise<AgentView>;
  /** navigate the user's view (history push, source "agent") */
  goto(address: Address): Promise<void>;
  /** tint listing rows and decompiler tokens/lines in the value-trail colours; replaces the previous highlight */
  highlight(h: AgentHighlight): Promise<void>;
  clearHighlight(): Promise<void>;
  /** ask the user in the app and resolve with the answer; false when declined or the window is closed */
  confirm(message: string): Promise<boolean>;
}

/** The newest change-log entries, for the `undo_agent_edit` guard. */
export interface ChangeView {
  /** the newest entry that is neither undone, saved nor locked, with the client that made it (`by`; absent = the user) and the provider's name for the undo step it committed (`undoName`; absent when the provider did not report one) */
  newest(): { label: string; by?: string; undoName?: string } | null;
}

export interface ToolCtx {
  /** The active program's operations; null when no program is open. Use `needProgram(ctx)`. */
  ops: ProgramOperations | null;
  session: ActiveSession | null;
  backend: ApplicationBackend;
  /** The active program's functions. The app serves its own list (kept current on program_changed) and fetches fresh only while that list is known to be behind; a headless host uses `ops.functions.list()`. Throws when no program is open. */
  functions(): Promise<FunctionInfo[]>;
  ui?: AgentUi;
  changes: ChangeView;
  /** aborted when the MCP client cancels or the call times out: cancel `Job`s */
  signal: AbortSignal;
  /** the MCP client's name (`clientInfo.name`) */
  client: string;
  mode: AccessMode;
  /** Mark a params object as the agent's (attribution.ts): pass the very object you hand to `ops.edits.*`, the change log entry is then tagged with `client`. */
  tag<T extends object>(params: T): T;
}
export function needProgram(ctx: ToolCtx): ProgramOperations {
  if (!ctx.ops) throw new ToolError("No program is open. Ask the user to open one in Ghidorita (call status to see what is open).");
  return ctx.ops;
}

export interface ToolDef<A = any> {
  /** snake_case; unique */
  name: string;
  /** what it does and when to use it, written for the agent; keep it short */
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  /** the lowest access mode that offers the tool */
  access: AccessMode;
  /** needs the UI (`ctx.ui`): not offered by a headless host */
  appOnly?: boolean;
  /** provider capabilities that must all be present, else the tool isn't listed (capabilities.ts) */
  capability?: Capability | Capability[];
  /** the tool's own limit; main times a call out after this plus a margin, and `signal` aborts it */
  timeoutSecs: number;
  /** returns the text the agent reads (capped, see format.ts); throws `ToolError` for what the agent should be told */
  handler(ctx: ToolCtx, args: A): Promise<string>;
}

// ---- IPC main <-> renderer. Main validates every payload it receives (reply shapes, sizes); the renderer validates `args` against the tool's schema only through main. ----
/** main -> renderer, "agent-call". Main has already checked mode, appOnly and arguments; `timeoutSecs` is the tool's. `client` is the connection's identity `<name>#<n>` (attribution.ts `agentName` for display). */
export interface AgentCall { callId: string; tool: string; args: Record<string, unknown>; client: string; mode: AccessMode; timeoutSecs: number }
/** renderer -> main, `agentReply`. `content` is capped by the tool; main truncates at 200 000 characters regardless. `error` becomes an `isError` result. */
export type AgentReply = { callId: string; ok: true; content: string } | { callId: string; ok: false; error: string };
/** main -> renderer, "agent-cancel": the client cancelled or main timed the call out. */
export interface AgentCancel { callId: string }
/** main -> renderer, "agent-state": who is connected (connection ids, `<name>#<n>`) and the mode, for the status bar. Sent on every change and once when the renderer announces itself ready. */
export interface AgentState { mode: AccessMode; clients: string[] }

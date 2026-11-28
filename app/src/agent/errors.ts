import { BackendError } from "../renderer/backend";
import { esc } from "./format";
import { ToolError } from "./types";

/**
 * Anything a handler's backend call throws, as the text the agent reads (docs/AGENTS_MCP.md "Errors are instructions").
 * A `ToolError` passes through. The executor applies this to every handler failure, and handlers use it to add context or to decide on a retry (`kind`).
 */
export function toToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof BackendError) {
    const m = esc(e.message, 300); // may carry names from the binary (a data type path, a symbol): escaped and bounded like every other untrusted text
    switch (e.kind) {
      case "busy": return new ToolError(`Busy: ${m.replace(/^busy:\s*/i, "")}. Reads still work but edits wait: call wait_for_analysis, then retry.`); // the provider's message often starts with "Busy:" itself
      case "stale":
      case "noProgram": return new ToolError("The user opened, replaced or closed the program while this ran. Call status to see what is open now.");
      case "timeout": return new ToolError(`Timed out: ${m}. Retry with a larger timeoutSecs, or on a smaller target.`);
      case "cancelled": return new ToolError(`Cancelled: ${m}. Another change raced this one; retry it.`);
      case "notFound": return new ToolError(`Not found: ${m}`);
      case "invalid": return new ToolError(`Invalid argument: ${m}`);
      case "unsupported": return new ToolError(`This provider does not support that (${m}). Check the capabilities in status.`);
      case "target": return new ToolError(`Debug target error: ${m}`);
      case "projectLocked": return new ToolError(`The project is locked by another Ghidorita process: ${m}`);
      default: return new ToolError(`Ghidorita's backend failed (${e.kind}): ${m}. Call status; the user may need to restart the app.`);
    }
  }
  if (e instanceof Error && e.name === "AbortError") return new ToolError("Cancelled.");
  return new ToolError(e instanceof Error ? e.message : String(e));
}
export const isKind = (e: unknown, kind: BackendError["kind"]): boolean => e instanceof BackendError && e.kind === kind;

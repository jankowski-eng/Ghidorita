import path from "node:path";

/** Strict check for paths coming from the renderer. They are only stored and echoed back, never executed. */
export function validPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.length <= 4096 && !p.includes("\0") && path.isAbsolute(p) && !p.startsWith("\\\\");
}

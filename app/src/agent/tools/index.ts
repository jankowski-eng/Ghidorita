import type { ToolDef } from "../types";
import { status } from "./status";

/**
 * The one tool table. Main imports it for tools/list and argument checks, the renderer executor for the handlers.
 * Each later step adds its own file and one import + spread line here.
 */
export const TOOLS: readonly ToolDef[] = [
  status,
];
export const toolByName = (name: string): ToolDef | undefined => TOOLS.find((t) => t.name === name);

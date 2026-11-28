import type { ToolDef } from "../types";
import { editTools } from "./edit";
import { fullTools } from "./full";
import { readTools } from "./read";
import { read2Tools } from "./read2";
import { status } from "./status";
import { typesTools } from "./types";
import { uiTools } from "./ui";

/**
 * The one tool table. Main imports it for tools/list and argument checks, the renderer executor for the handlers.
 * Each later step adds its own file and one import + spread line here.
 */
export const TOOLS: readonly ToolDef[] = [
  status,
  ...readTools,
  ...read2Tools,
  ...editTools,
  ...fullTools,
  ...uiTools,
  ...typesTools,
];
export const toolByName = (name: string): ToolDef | undefined => TOOLS.find((t) => t.name === name);

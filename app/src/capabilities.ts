import type { Capability } from "../../protocol";
import type { MenuCommand } from "./preload";

export const dockCapability = {
  symbols: "symbolTable", strings: "strings", memsearch: "memorySearch", changes: "editing", coverage: "coverage",
} as const;

export function allowsEdit(caps: ReadonlySet<Capability>, action: Extract<MenuCommand, { type: "edit" }>["action"]): boolean {
  switch (action) {
    case "save": return caps.has("save");
    case "undo": case "redo": return caps.has("undo");
    case "retype": case "autoStruct": return caps.has("decompile") && caps.has("variableEditing");
    case "defineData": case "createStruct": return caps.has("typeEditing");
    default: return caps.has("editing");
  }
}

export function allowsCommand(caps: ReadonlySet<Capability>, cmd: MenuCommand): boolean {
  switch (cmd.type) {
    case "edit": return allowsEdit(caps, cmd.action);
    case "dock": return caps.has(dockCapability[cmd.panel]);
    case "datatypes": return caps.has("dataTypes");
    case "coverage-path": case "coverage-load": case "coverage-clear": return caps.has("coverage");
    case "graph": return caps.has("controlFlowGraph") && caps.has("decompile");
    case "export": return caps.has("export");
    case "xrefs": return caps.has("references");
    case "toggle-pane": return cmd.pane !== "decompiler" || caps.has("decompile");
    case "close-tab": return caps.has("decompile");
    default: return true;
  }
}

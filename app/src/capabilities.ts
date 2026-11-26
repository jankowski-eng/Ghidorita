import type { Capability } from "../../protocol";
import type { MenuCommand } from "./preload";

export const dockCapability = {
  symbols: "symbolTable", strings: "strings", memsearch: "memorySearch", changes: "editing", coverage: "coverage", calls: "calls", bookmarks: "bookmarks",
} as const;

/** What the centre pane hosts: the decompiler (tabs, editor, control-flow graph) needs `decompile`; the call graph is a view of its own and needs only `callGraph`. */
export const centreViews = (caps: ReadonlySet<Capability>, callGraphOn: boolean) => ({ decompiler: caps.has("decompile"), callGraph: caps.has("callGraph") && callGraphOn });

export function allowsEdit(caps: ReadonlySet<Capability>, action: Extract<MenuCommand, { type: "edit" }>["action"]): boolean {
  switch (action) {
    case "save": return caps.has("save");
    case "undo": case "redo": return caps.has("undo");
    case "retype": case "autoStruct": return caps.has("decompile") && caps.has("variableEditing");
    case "defineData": case "createStruct": return caps.has("typeEditing");
    case "bookmark": return caps.has("bookmarks");
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
    case "callgraph": return caps.has("callGraph");
    case "export": return caps.has(cmd.kind === "gzf" ? "exportGzf" : "export");
    case "copy": return cmd.what === "address" || caps.has(cmd.what === "decompiled" ? "decompile" : "bytes");
    case "xrefs": return caps.has("references");
    case "toggle-pane": return cmd.pane !== "decompiler" || caps.has("decompile");
    case "close-tab": return caps.has("decompile");
    default: return true;
  }
}

import type { MenuCommand } from "../preload";

export interface CommandAction { label: string; cmd: MenuCommand }

/** The menu's commands, runnable from the command bar (">" prefix). The menu stays the source of truth for keys; each one does what its menu item does. */
export const ACTIONS: CommandAction[] = [
  { label: "Go to Address…", cmd: { type: "goto" } },
  { label: "Go Back", cmd: { type: "nav-back" } },
  { label: "Go Forward", cmd: { type: "nav-forward" } },
  { label: "Show References To", cmd: { type: "xrefs" } },
  { label: "Rename", cmd: { type: "edit", action: "rename" } },
  { label: "Retype", cmd: { type: "edit", action: "retype" } },
  { label: "Set Comment", cmd: { type: "edit", action: "comment" } },
  { label: "Edit Function Signature", cmd: { type: "edit", action: "signature" } },
  { label: "Create Function", cmd: { type: "edit", action: "createFunction" } },
  { label: "Define Data", cmd: { type: "edit", action: "defineData" } },
  { label: "Create Structure", cmd: { type: "edit", action: "createStruct" } },
  { label: "Auto Create Structure", cmd: { type: "edit", action: "autoStruct" } },
  { label: "Clear Code", cmd: { type: "edit", action: "clear" } },
  { label: "Undo", cmd: { type: "edit", action: "undo" } },
  { label: "Redo", cmd: { type: "edit", action: "redo" } },
  { label: "Save", cmd: { type: "edit", action: "save" } },
  { label: "Symbol Table", cmd: { type: "dock", panel: "symbols" } },
  { label: "Defined Strings", cmd: { type: "dock", panel: "strings" } },
  { label: "Changes", cmd: { type: "dock", panel: "changes" } },
  { label: "Search Memory", cmd: { type: "dock", panel: "memsearch" } },
  { label: "Data Type Manager", cmd: { type: "datatypes" } },
  { label: "Coverage", cmd: { type: "dock", panel: "coverage" } },
  { label: "Load Coverage…", cmd: { type: "coverage-load" } },
  { label: "Clear Coverage", cmd: { type: "coverage-clear" } },
  { label: "Toggle Control-Flow Graph", cmd: { type: "graph" } },
  { label: "Toggle Call Graph", cmd: { type: "callgraph" } },
  { label: "Export Symbol Map (JSON)", cmd: { type: "export", kind: "symbols" } },
  { label: "Export C Header", cmd: { type: "export", kind: "header" } },
  { label: "Export Ghidra Archive (.gzf)", cmd: { type: "export", kind: "gzf" } },
  { label: "Close Tab", cmd: { type: "close-tab" } },
  { label: "Close Program", cmd: { type: "close-program" } },
];

/** Actions whose label contains every word of `q` (case-insensitive); an empty query lists all. */
export const matchActions = (q: string): CommandAction[] => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return ACTIONS.filter((a) => words.every((w) => a.label.toLowerCase().includes(w)));
};

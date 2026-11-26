import type { Capability } from "../../protocol";
import type { MenuCommand } from "./preload";
import { allowsCommand } from "./capabilities";

/**
 * The one table of keys, shared by the application menu (main), the command bar and the key hint bar (renderer).
 * Id = `keyId(command)`; value = Electron accelerator syntax. Keys here are Ghidra's defaults; a later keymap replaces this table.
 * Display only: the keys themselves are handled by the menu accelerators (those with CmdOrCtrl) and by Listing / Decompiler / App (plain keys, Cmd+L).
 */
export const KEYS: Readonly<Record<string, string>> = {
  open: "CmdOrCtrl+O", save: "CmdOrCtrl+S", "close-tab": "CmdOrCtrl+W",
  "edit:undo": "CmdOrCtrl+Z", "edit:redo": "CmdOrCtrl+Shift+Z",
  "copy:address": "CmdOrCtrl+Shift+C", "copy:bytes": "CmdOrCtrl+Alt+C",
  "edit:bookmark": "CmdOrCtrl+D",
  "edit:rename": "L", "edit:retype": "CmdOrCtrl+L", "edit:comment": ";", "edit:createFunction": "F", "edit:defineData": "T", "edit:clear": "C",
  graph: "Space", callgraph: "CmdOrCtrl+Shift+G",
  "dock:symbols": "CmdOrCtrl+Shift+Y", "dock:strings": "CmdOrCtrl+Shift+E", "dock:changes": "CmdOrCtrl+Shift+H", "dock:calls": "CmdOrCtrl+Shift+J",
  "dock:bookmarks": "CmdOrCtrl+Shift+B", "dock:memsearch": "CmdOrCtrl+Shift+F", datatypes: "CmdOrCtrl+Shift+T",
  "nav-back": "CmdOrCtrl+[", "nav-forward": "CmdOrCtrl+]", search: "CmdOrCtrl+K", symbolSearch: "CmdOrCtrl+Shift+O", goto: "CmdOrCtrl+G", xrefs: "X",
};

/** Table id of a command. "edit:save" shares the id `save` with the File menu item. */
export const keyId = (c: MenuCommand): string =>
  c.type === "edit" ? (c.action === "save" ? "save" : "edit:" + c.action) : c.type === "copy" ? "copy:" + c.what : c.type === "dock" ? "dock:" + c.panel : c.type;

export const keyOf = (c: MenuCommand): string | undefined => KEYS[keyId(c)];

/** A key that only shows in a label because the view handles it itself (a real accelerator would swallow it in text inputs): plain keys and Cmd+L. */
export const isHint = (id: string): boolean => !KEYS[id]?.includes("CmdOrCtrl") || id === "edit:retype";

/** "CmdOrCtrl+Shift+G" -> "⌘⇧G" (mac) or "Ctrl+Shift+G". */
export function showKey(key: string, mac: boolean): string {
  const parts = key.split("+").map((p) => (p === "CmdOrCtrl" ? (mac ? "⌘" : "Ctrl") : mac && p === "Shift" ? "⇧" : mac && p === "Alt" ? "⌥" : p));
  return parts.join(mac ? "" : "+");
}

export type HintView = "listing" | "decompiler" | "graph" | "other";
type Hint = [word: string, cmd: MenuCommand];
const E = (action: Extract<MenuCommand, { type: "edit" }>["action"]): MenuCommand => ({ type: "edit", action });
const HINTS: Record<"listing" | "decompiler", Hint[]> = {
  listing: [["rename", E("rename")], ["comment", E("comment")], ["function", E("createFunction")], ["data", E("defineData")], ["clear", E("clear")], ["refs", { type: "xrefs" }], ["graph", { type: "graph" }]],
  decompiler: [["rename", E("rename")], ["retype", E("retype")], ["comment", E("comment")], ["refs", { type: "xrefs" }], ["graph", { type: "graph" }]],
};
const joined = (hs: Hint[], caps: ReadonlySet<Capability>, mac: boolean) =>
  hs.filter(([, c]) => allowsCommand(caps, c)).map(([w, c]) => `${showKey(keyOf(c)!, mac)} ${w}`).join(" · ");

/** The key hint line for the focused view; only actions the provider's capabilities allow. */
export function hintLine(view: HintView, caps: ReadonlySet<Capability>, mac: boolean): string {
  if (view === "graph") return `${showKey(KEYS.graph, mac)} back · wheel zoom · drag pan · Fit · 1:1`;
  if (view === "other") return joined([["commands", { type: "search" }], ["go to", { type: "goto" }]], caps, mac);
  return joined(HINTS[view], caps, mac);
}

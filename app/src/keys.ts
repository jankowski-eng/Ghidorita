import type { Capability } from "../../protocol";
import type { MenuCommand } from "./preload";
import { allowsCommand } from "./capabilities";

/**
 * The one table of keys, shared by the application menu (main), the command bar and the key hint bar (renderer).
 * Id = `keyId(command)`; value = Electron accelerator syntax. Keys are Ghidra 12.3's defaults (Ctrl is Cmd on macOS, as in Ghidra);
 * a key marked "app-only" is one Ghidra leaves free; an action Ghidra has no key for, or whose key Ghidra uses for something else, has none (menu / command bar only).
 * Display only: the keys themselves are handled by the menu accelerators (those with CmdOrCtrl) and by Listing / Decompiler / bootstrap (hint-only keys).
 */
export const KEYS: Readonly<Record<string, string>> = {
  open: "CmdOrCtrl+O", save: "CmdOrCtrl+S", "close-tab": "CmdOrCtrl+W",
  "edit:undo": "CmdOrCtrl+Z", "edit:redo": "CmdOrCtrl+Shift+Z",
  "copy:address": "CmdOrCtrl+Shift+C", "copy:bytes": "CmdOrCtrl+Alt+C", // app-only
  "edit:bookmark": "CmdOrCtrl+D",
  "edit:rename": "L", "edit:retype": "CmdOrCtrl+L", "edit:comment": ";", "edit:createFunction": "F", "edit:defineData": "T", "edit:setEquate": "E", // Set Equate: Ghidra 12.3 SetEquateAction (decompiler) and EquatePlugin (listing), VK_E; Split Out, Force Field and No Return have no key in Ghidra
  "edit:clear": "C",
  "edit:defineArray": "[", "edit:definePointer": "P", "edit:repeatData": "Y", "edit:createStruct": "Shift+[",
  // dock:stack (Stack Frame) has no key: Ghidra binds none to its stack window
  graph: "CmdOrCtrl+Space", callgraph: "CmdOrCtrl+Shift+G", // graph: Ghidra's "Toggle Listing and Function Graph"; call graph app-only
  "dock:symbols": "CmdOrCtrl+T", "dock:changes": "CmdOrCtrl+Shift+H", "dock:bookmarks": "CmdOrCtrl+B", "dock:memsearch": "S", // changes app-only
  "debug:continue": "F5", "debug:pause": "F6", "debug:step": "F7", "debug:stepi": "F8", "debug:breakpoint": "F9", "debug:stepinto": "F10", "debug:stepout": "Shift+F10",
  "debug:back": "Shift+F7", "debug:forward": "Shift+F8",
  "nav-back": "Alt+Left", "nav-forward": "Alt+Right", search: "CmdOrCtrl+K", symbolSearch: "CmdOrCtrl+Shift+O", goto: "G", xrefs: "CmdOrCtrl+Shift+F", trail: "J", // search, symbolSearch app-only
};

/** Table id of a command. "edit:save" shares the id `save` with the File menu item. */
export const keyId = (c: MenuCommand): string =>
  c.type === "edit" ? (c.action === "save" ? "save" : "edit:" + c.action) : c.type === "copy" ? "copy:" + c.what : c.type === "dock" ? "dock:" + c.panel : c.type === "debug" ? "debug:" + c.action : c.type;

export const keyOf = (c: MenuCommand): string | undefined => KEYS[keyId(c)];

/** A key that only shows in a label because the view handles it itself (a real accelerator would swallow it in text inputs): plain keys and Cmd+L. Function keys (the debugger's) are accelerators. */
export const isHint = (id: string): boolean => (!KEYS[id]?.includes("CmdOrCtrl") && !/^(Shift\+)?F\d+$/.test(KEYS[id] ?? "")) || id === "edit:retype"; // function keys type nothing: real accelerators

/** "CmdOrCtrl+Shift+G" -> "⌘⇧G" (mac) or "Ctrl+Shift+G". */
export function showKey(key: string, mac: boolean): string {
  const parts = key.split("+").map((p) => (p === "CmdOrCtrl" ? (mac ? "⌘" : "Ctrl") : mac ? ({ Shift: "⇧", Alt: "⌥", Left: "←", Right: "→" } as Record<string, string>)[p] ?? p : p));
  return parts.join(mac ? "" : "+");
}

/** Does a keydown match a hint-only key (plain letter or Alt+arrow)? The views and bootstrap use it so the table stays the one source. */
export function matchesKey(accel: string | undefined, e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  if (!accel) return false;
  const parts = accel.split("+"), main = parts.pop()!;
  if ((e.metaKey || e.ctrlKey) !== parts.includes("CmdOrCtrl") || e.altKey !== parts.includes("Alt") || e.shiftKey !== parts.includes("Shift")) return false;
  const named: Record<string, string> = { Left: "ArrowLeft", Right: "ArrowRight", Space: " " };
  return e.key.toLowerCase() === (named[main] ?? main).toLowerCase();
}

export type HintView = "listing" | "decompiler" | "graph" | "other";
type Hint = [word: string, cmd: MenuCommand];
const E = (action: Extract<MenuCommand, { type: "edit" }>["action"]): MenuCommand => ({ type: "edit", action });
// most used first: a narrow window cuts the line from the end (ellipsis), so the rarer keys go first
const HINTS: Record<"listing" | "decompiler", Hint[]> = {
  listing: [["rename", E("rename")], ["refs", { type: "xrefs" }], ["graph", { type: "graph" }], ["comment", E("comment")], ["function", E("createFunction")], ["data", E("defineData")], ["array", E("defineArray")], ["pointer", E("definePointer")], ["clear", E("clear")]],
  decompiler: [["rename", E("rename")], ["refs", { type: "xrefs" }], ["graph", { type: "graph" }], ["retype", E("retype")], ["trail", { type: "trail" }], ["comment", E("comment")]],
};
const joined = (hs: Hint[], caps: ReadonlySet<Capability>, mac: boolean) =>
  hs.filter(([, c]) => allowsCommand(caps, c)).map(([w, c]) => `${showKey(keyOf(c)!, mac)} ${w}`).join(" · ");

/** The key hint line for the focused view; only actions the provider's capabilities allow. */
export function hintLine(view: HintView, caps: ReadonlySet<Capability>, mac: boolean): string {
  if (view === "graph") return `${showKey(KEYS.graph, mac)} back · wheel zoom · drag pan · Fit · 1:1`;
  if (view === "other") return joined([["commands", { type: "search" }], ["go to", { type: "goto" }]], caps, mac);
  return joined(HINTS[view], caps, mac);
}

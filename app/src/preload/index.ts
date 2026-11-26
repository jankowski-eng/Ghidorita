import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Capability } from "../../../protocol";

// ---- IPC contract (main <-> renderer). Main must validate every payload it receives. ----
export type Pane = "functions" | "listing" | "decompiler";
/** main -> renderer, channel "menu". "open-path": File > Open Binary… (main shows the dialog) or File > Open Recent. */
export type MenuCommand =
  | { type: "open-path"; path: string } | { type: "coverage-path"; path: string } | { type: "coverage-clear" } | { type: "coverage-load" }
  | { type: "search" } | { type: "nav-back" } | { type: "nav-forward" } | { type: "goto" } | { type: "close-tab" } | { type: "close-program" } | { type: "datatypes" }
  | { type: "toggle-pane"; pane: Pane; visible: boolean }
  | { type: "dock"; panel: "strings" | "symbols" | "memsearch" | "changes" | "coverage" | "calls" | "bookmarks" | "registers" | "locals" | "memory" | "stack" | "undefined" | "hex" } | { type: "debug"; action: "attach" | "detach" | "continue" | "pause" | "step" | "stepinto" | "stepout" | "stepi" | "back" | "forward" | "breakpoint" } | { type: "xrefs" } | { type: "graph" } | { type: "callgraph" } | { type: "export"; kind: "symbols" | "header" | "gzf" } | { type: "copy"; what: "address" | "bytes" | "carray" | "decompiled" }
  | { type: "edit"; action: "rename" | "retype" | "comment" | "createFunction" | "defineData" | "defineArray" | "definePointer" | "repeatData" | "createStruct" | "bookmark" | "autoStruct" | "setEquate" | "noReturn" | "splitVariable" | "forceField" | "clear" | "signature" | "patch" | "undo" | "redo" | "save" };
/** renderer -> main, "menu-state": enables/disables Go > Back / Forward, File > Open Binary / Open Recent (disabled while an open runs) and Close Program. */
export interface MenuState {
  capabilities: Capability[]; hasProgram: boolean; recovery?: { snapshotIntervalSeconds: number };
  canBack: boolean; canForward: boolean; canOpen: boolean;
  canEdit: boolean;                 // an open program and no open in progress
  undoLabel: string | null;         // "Undo Rename symbol"; null = nothing to undo
  redoLabel: string | null;
  dirty: boolean;                   // unsaved edits: macOS document-edited dot
  canClose: boolean;                // File > Close Program (the sidecar autosaves on close)
}

export interface Host {
  getConfig(): Promise<{ port: number; token: string; autotest: string | null; bench: boolean; cancelFile: string | null; only?: string | null; flow: string | null; decompileTimeout: number | null; expect: unknown }>;
  pickFile(): Promise<string | null>;
  /** Drag and drop: the dropped items' paths (File.path is gone; webUtils reads it here), checked by main: one regular file, else an error message. */
  checkDrop(files: File[]): Promise<{ path: string } | { error: string }>;
  /** Native save dialog for an export, suggesting `name` (a bare file name); null = cancelled. */
  pickSavePath(name: string): Promise<string | null>;
  /** Fallback for navigator.clipboard.writeText: main validates (a string up to 8 MiB) and writes the system clipboard. */
  writeClipboard(text: string): Promise<void>;
  autotestDone(result: unknown): Promise<void>;
  /** Subscribe to menu commands; returns the unsubscribe function. */
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  /** renderer -> main, "recent-add": record a successfully opened path in Open Recent (absolute path string, <= 4096 chars). */
  recentAdd(path: string): Promise<void>;
  setMenuState(state: MenuState): Promise<void>;
  /** main -> renderer, "quit-requested": save the program (show "Saving…"), then call quitReady. */
  onQuitRequested(cb: () => void): () => void;
  /** renderer -> main: the save finished (ok) or failed (error text); main then stops the sidecar and quits. */
  quitReady(r: { ok: boolean; error?: string }): Promise<void>;
  /** autotest only: end the run through the real before-quit path. */
  autotestQuit(result: unknown): Promise<void>;
  /** autotest only: click an application-menu item by id (save, undo, redo). */
  autotestMenu(id: string): Promise<boolean>;
}

const host: Host = {
  getConfig: () => ipcRenderer.invoke("get-config"),
  checkDrop: (files) => ipcRenderer.invoke("drop-check", files.map((f) => webUtils.getPathForFile(f))),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  pickSavePath: (name) => ipcRenderer.invoke("pick-save-path", name),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard-write", text),
  autotestDone: (result) => ipcRenderer.invoke("autotest-done", result),
  onMenu: (cb) => {
    const h = (_e: unknown, cmd: MenuCommand) => cb(cmd);
    ipcRenderer.on("menu", h);
    return () => { ipcRenderer.removeListener("menu", h); };
  },
  recentAdd: (path) => ipcRenderer.invoke("recent-add", path),
  setMenuState: (state) => ipcRenderer.invoke("menu-state", state),
  onQuitRequested: (cb) => {
    const h = () => cb();
    ipcRenderer.on("quit-requested", h);
    return () => { ipcRenderer.removeListener("quit-requested", h); };
  },
  quitReady: (r) => ipcRenderer.invoke("quit-ready", r),
  autotestQuit: (result) => ipcRenderer.invoke("autotest-quit", result),
  autotestMenu: (id) => ipcRenderer.invoke("autotest-menu", id),
};
contextBridge.exposeInMainWorld("host", host);

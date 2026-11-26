import { contextBridge, ipcRenderer } from "electron";

// ---- IPC contract (main <-> renderer). Main must validate every payload it receives. ----
export type Pane = "functions" | "listing" | "decompiler";
/** main -> renderer, channel "menu". "open-path": File > Open Binary… (main shows the dialog) or File > Open Recent. */
export type MenuCommand =
  | { type: "open-path"; path: string }
  | { type: "search" } | { type: "nav-back" } | { type: "nav-forward" } | { type: "goto" } | { type: "close-tab" } | { type: "save" } | { type: "close-program" }
  | { type: "toggle-pane"; pane: Pane; visible: boolean };
/** renderer -> main, "menu-state": enables/disables Go > Back / Forward, File > Open Binary / Open Recent (disabled while an open runs), Save (dirty program) and Close Program. */
export interface MenuState { canBack: boolean; canForward: boolean; canOpen: boolean; canSave: boolean; canClose: boolean }

export interface Host {
  getConfig(): Promise<{ port: number; token: string; autotest: string | null; bench: boolean; cancelFile: string | null }>;
  pickFile(): Promise<string | null>;
  /** viaClose: after printing the result, main ends the run through the real window-close path (the renderer must then answer the quit prompt). */
  autotestDone(result: unknown, viaClose?: boolean): Promise<void>;
  /** autotest only: main calls win.close(), the same handler a user's window close hits. */
  autotestClose(): Promise<void>;
  /** main -> renderer, "quit-request": the window is closing or Cmd+Q was pressed; answer with quitAnswer(true) to quit, false to stay. */
  onQuitRequest(cb: () => void): () => void;
  quitAnswer(ok: boolean): Promise<void>;
  /** Subscribe to menu commands; returns the unsubscribe function. */
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  /** renderer -> main, "recent-add": record a successfully opened path in Open Recent (absolute path string, <= 4096 chars). */
  recentAdd(path: string): Promise<void>;
  setMenuState(state: MenuState): Promise<void>;
}

const host: Host = {
  getConfig: () => ipcRenderer.invoke("get-config"),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  autotestDone: (result, viaClose) => ipcRenderer.invoke("autotest-done", result, viaClose === true),
  autotestClose: () => ipcRenderer.invoke("autotest-close"),
  onQuitRequest: (cb) => {
    const h = () => cb();
    ipcRenderer.on("quit-request", h);
    return () => { ipcRenderer.removeListener("quit-request", h); };
  },
  quitAnswer: (ok) => ipcRenderer.invoke("quit-answer", ok === true),
  onMenu: (cb) => {
    const h = (_e: unknown, cmd: MenuCommand) => cb(cmd);
    ipcRenderer.on("menu", h);
    return () => { ipcRenderer.removeListener("menu", h); };
  },
  recentAdd: (path) => ipcRenderer.invoke("recent-add", path),
  setMenuState: (state) => ipcRenderer.invoke("menu-state", state),
};
contextBridge.exposeInMainWorld("host", host);

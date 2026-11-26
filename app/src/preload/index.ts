import { contextBridge, ipcRenderer } from "electron";

// ---- IPC contract (main <-> renderer). Main must validate every payload it receives. ----
export type Pane = "functions" | "listing" | "decompiler";
/** main -> renderer, channel "menu". "open-path": File > Open Binary… (main shows the dialog) or File > Open Recent. */
export type MenuCommand =
  | { type: "open-path"; path: string }
  | { type: "nav-back" } | { type: "nav-forward" } | { type: "goto" } | { type: "close-tab" }
  | { type: "toggle-pane"; pane: Pane };
/** renderer -> main, "menu-state": enables/disables Go > Back / Forward. */
export interface MenuState { canBack: boolean; canForward: boolean }

export interface Host {
  getConfig(): Promise<{ port: number; token: string; autotest: string | null; bench: boolean }>;
  pickFile(): Promise<string | null>;
  autotestDone(result: unknown): Promise<void>;
  /** Subscribe to menu commands; returns the unsubscribe function. */
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  /** renderer -> main, "recent-add": record a successfully opened path in Open Recent (absolute path string, <= 4096 chars). */
  recentAdd(path: string): Promise<void>;
  setMenuState(state: MenuState): Promise<void>;
}

const host: Host = {
  getConfig: () => ipcRenderer.invoke("get-config"),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  autotestDone: (result) => ipcRenderer.invoke("autotest-done", result),
  onMenu: (cb) => {
    const h = (_e: unknown, cmd: MenuCommand) => cb(cmd);
    ipcRenderer.on("menu", h);
    return () => { ipcRenderer.removeListener("menu", h); };
  },
  recentAdd: (path) => ipcRenderer.invoke("recent-add", path),
  setMenuState: (state) => ipcRenderer.invoke("menu-state", state),
};
contextBridge.exposeInMainWorld("host", host);

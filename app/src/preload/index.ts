import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("host", {
  getConfig: (): Promise<{ port: number; token: string; autotest: string | null; bench: boolean }> => ipcRenderer.invoke("get-config"),
  pickFile: (): Promise<string | null> => ipcRenderer.invoke("pick-file"),
  autotestDone: (result: unknown): Promise<void> => ipcRenderer.invoke("autotest-done", result),
});

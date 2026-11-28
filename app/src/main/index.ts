import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { randomBytes } from "node:crypto";
const token = randomBytes(24).toString("hex");
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMenu } from "./menu";
import { validPath } from "./recent";
import { checkDrop } from "./drop";
import { CAPABILITIES } from "../../../protocol";
import { providerLaunch } from "./providers";
import { ProviderProcess } from "./providerProcess";
import { createAgent, setupText, type Agent } from "./agent";

const appDir = path.resolve(__dirname, "../.."); // app/ (this file is app/out/main/index.js)
const outDir = app.isPackaged ? path.join(app.getPath("userData"), "out") : path.join(appDir, "out");
const provider = new ProviderProcess();
let quitting = false;
let recovery: { snapshotIntervalSeconds: number } | undefined;
let agent: Agent | undefined;
const stopSidecar = () => { quitting = true; agent?.stop().catch(() => {}); return provider.stop(); };
let stopped = false;
let rendererReady = false;          // the renderer mounted and can run the save-before-quit step
let exitCode: number | null = null; // set by the autotest to end through the real quit path
const QUIT_SAVE_MAX_MS = 5 * 60_000; // renderer hung or save stuck: stop waiting (the sidecar still saves on shutdown)
let quitSave: ((r: { ok: boolean; error?: string }) => void) | null = null;
/** Ask the renderer to save and wait for its answer; "Saving…" is shown there. Resolves true to go on quitting. */
async function saveBeforeQuit(): Promise<boolean> {
  if (!rendererReady || !win || win.isDestroyed() || win.webContents.isDestroyed()) return true;
  const r = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const t = setTimeout(() => { console.error("save before quit: no answer from the renderer"); resolve({ ok: true }); }, QUIT_SAVE_MAX_MS);
    quitSave = (x) => { clearTimeout(t); resolve(x); };
    win.webContents.send("quit-requested");
  });
  quitSave = null;
  if (r.ok) return true;
  const c = dialog.showMessageBoxSync(win, { type: "warning", buttons: ["Cancel", "Quit anyway"], defaultId: 0, cancelId: 0, message: "Saving failed", detail: (r.error ?? "unknown error") + "\n\nQuit anyway? Unsaved edits may be lost." });
  return c === 1;
}
app.on("before-quit", (e) => {
  if (stopped) return;
  e.preventDefault();
  if (quitSave) return; // a save is already in flight
  saveBeforeQuit().then((go) => {
    if (!go) return;
    stopped = true; quitting = true;
    return stopSidecar().then((code) => {
      if (code !== 0) {
        console.error(`sidecar shutdown failed (${code}); edits may not have been saved`);
        const opts = { type: "error" as const, buttons: ["OK"], message: "Saving may have failed", detail: "The backend did not complete shutdown successfully. Recent edits may not have been saved." };
        if (win && !win.isDestroyed()) dialog.showMessageBoxSync(win, opts);
        else dialog.showMessageBoxSync(opts);
        app.exit(1);
      } else if (exitCode === null) app.quit();
      else app.exit(exitCode);
    });
  });
});
ipcMain.handle("quit-ready", (e, r: unknown) => { const o = r as { ok?: unknown; error?: unknown } | null; if (fromWin(e) && o && typeof o.ok === "boolean") quitSave?.({ ok: o.ok, error: typeof o.error === "string" ? o.error.slice(0, 2000) : undefined }); });
process.on("exit", () => provider.kill());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopSidecar().then(() => process.exit(1)); });
process.on("uncaughtException", (e) => { console.error("uncaughtException", e); stopSidecar().then(() => process.exit(1)); });

/** The backend died under a running app (out of memory, kill): say so once. Restarting reopens the program and restores the sidecar's recovery snapshot. */
function sidecarDied(why: unknown) {
  if (stopped || autotest) return; // autotest: the renderer's failing calls report it
  stopped = quitting = true;
  const opts = { type: "error" as const, buttons: ["Restart", "Quit"], defaultId: 0, cancelId: 1, message: "The analysis backend stopped unexpectedly",
    detail: recovery
      ? `Exit: ${why}. Reopen the file after restarting to try to restore its latest recovery snapshot. The snapshot interval was ${recovery.snapshotIntervalSeconds} seconds.`
      : `Exit: ${why}.` };
  (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then((r) => { if (r.response === 0) app.relaunch(); app.exit(r.response === 0 ? 0 : 1); });
}

let win: BrowserWindow;
const autotest = process.env.AUTOTEST;

const fromWin = (e: IpcMainInvokeEvent) => !!win && !win.isDestroyed() && e.sender === win.webContents;
async function pickFile() {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"] });
  return r.canceled ? null : r.filePaths[0];
}
let menu: ReturnType<typeof createMenu>;

// Save dialog for exports; AUTOTEST_EXPORT_DIR answers it in autotest runs (a native dialog cannot be driven)
ipcMain.handle("pick-save-path", async (e, name: unknown) => {
  if (!fromWin(e) || typeof name !== "string" || !name || name.length > 200 || /[\\/]/.test(name)) return null;
  if (autotest && process.env.AUTOTEST_EXPORT_DIR) return path.join(process.env.AUTOTEST_EXPORT_DIR, name);
  const r = await dialog.showSaveDialog(win, { defaultPath: name });
  return r.canceled || !r.filePath ? null : r.filePath;
});
ipcMain.handle("clipboard-write", (e, text: unknown) => { if (fromWin(e) && typeof text === "string" && text.length <= 8 << 20) clipboard.writeText(text); });
ipcMain.handle("pick-file", async (e) => (fromWin(e) ? pickFile() : null));

ipcMain.handle("drop-check", (e, paths: unknown) => fromWin(e) ? checkDrop(paths, (p) => { try { const st = statSync(p); return st.isDirectory() ? "dir" : st.isFile() ? "file" : "none"; } catch { return "none"; } }) : { error: "Refused." });
ipcMain.handle("recent-add", (e, p: unknown) => { if (fromWin(e) && validPath(p)) menu?.addRecent(p); });
ipcMain.handle("menu-state", (e, s: unknown) => {
  const o = s as Record<string, unknown> | null;
  if (!fromWin(e) || !o || typeof o !== "object" || typeof o.canBack !== "boolean" || typeof o.canForward !== "boolean" || typeof o.canOpen !== "boolean") return;
  const lbl = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : null);
  const capabilities = CAPABILITIES.filter((cap) => Array.isArray(o.capabilities) && o.capabilities.includes(cap));
  const interval = (o.recovery as { snapshotIntervalSeconds?: unknown } | undefined)?.snapshotIntervalSeconds;
  recovery = capabilities.includes("recovery") && typeof interval === "number" && Number.isFinite(interval) && interval > 0
    ? { snapshotIntervalSeconds: interval } : undefined;
  const m = { capabilities, recovery, hasProgram: o.hasProgram === true, canBack: o.canBack, canForward: o.canForward, canOpen: o.canOpen, canEdit: o.canEdit === true, undoLabel: lbl(o.undoLabel), redoLabel: lbl(o.redoLabel), dirty: o.dirty === true, canClose: o.canClose === true,
    layouts: Array.isArray(o.layouts) ? o.layouts.filter((n): n is string => typeof n === "string").slice(0, 100).map((n) => n.slice(0, 40)) : undefined,
    panes: o.panes && typeof o.panes === "object" ? { functions: (o.panes as any).functions !== false, listing: (o.panes as any).listing !== false, decompiler: (o.panes as any).decompiler !== false } : undefined };
  menu?.setState(m);
  agent?.setCapabilities(new Set(capabilities));
  rendererReady = true;
  if (process.platform === "darwin") win.setDocumentEdited(m.dirty);
});

// autotest: invoke a real application-menu item (same click handler as the user's mouse click)
ipcMain.handle("autotest-menu", (e, id: unknown) => { if (!fromWin(e) || !autotest || typeof id !== "string") return false;
  const item = Menu.getApplicationMenu()?.getMenuItemById(id);
  if (!item?.enabled || !item.visible) return false;
  item.click();
  return true; });
ipcMain.handle("autotest-quit", async (e, result: { ok: boolean; persist?: unknown }) => {
  if (!fromWin(e)) return;
  await finishAutotest(result);
  exitCode = result.ok ? 0 : 1;
  app.quit(); // the real before-quit path: save, stop sidecar
});
ipcMain.handle("autotest-done", async (e, result: { ok: boolean }) => {
  if (!fromWin(e)) return;
  await finishAutotest(result);
  stopped = true;
  const code = await stopSidecar();
  app.exit(result.ok && code === 0 ? 0 : 1);
});
async function finishAutotest(result: { ok: boolean; persist?: unknown }) {
  await new Promise((r) => setTimeout(r, 300)); // let the last paint land
  try {
    const img = await win.webContents.capturePage();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "screenshot.png"), img.toPNG());
  } catch (e) { console.error("screenshot failed", e); }
  if (result.persist) writeFileSync(path.join(outDir, "autotest-persist.json"), JSON.stringify(result.persist));
  const wp = (win.webContents as any).getLastWebPreferences(); // what the window really runs with (hardening check; missing from the Electron typings)
  console.log("AUTOTEST_RESULT " + JSON.stringify({ ...result, webPreferences: { contextIsolation: wp.contextIsolation, sandbox: wp.sandbox, nodeIntegration: wp.nodeIntegration } }));
}

// The window only ever shows our own file: never navigate away, never open new windows (also for any webContents Electron creates later)
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
app.setName("Ghidorita");
app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock?.setIcon(path.join(appDir, "build/icon.png"));
  let port: number;
  try {
    port = await provider.start(providerLaunch({ appDir, resourcesPath: process.resourcesPath, userData: app.getPath("userData"),
      packaged: app.isPackaged, electron: process.execPath, token, env: process.env }),
      (why) => { if (!quitting) sidecarDied(why); });
  } catch (e) {
    console.error("Backend startup failed:", e);
    if (!autotest) dialog.showErrorBox("Could not start the analysis backend", String(e));
    provider.kill(); app.exit(1); return;
  }
  ipcMain.handle("get-config", (e) => !fromWin(e) ? null : ({ expect: process.env.AUTOTEST_PHASE === "2" ? JSON.parse(readFileSync(path.join(outDir, "autotest-persist.json"), "utf8")) : null, port, token, autotest: autotest ?? null, bench: process.env.BENCH === "1", cancelFile: process.env.AUTOTEST_CANCEL_FILE ?? null, only: process.env.AUTOTEST_ONLY ?? null, flow: process.env.AUTOTEST_FLOW ?? null, decompileTimeout: Number(process.env.AUTOTEST_DECOMPILE_TIMEOUT) || null }));
  win = new BrowserWindow({ width: 1400, height: 900, title: "Ghidorita", icon: path.join(appDir, "build/icon.png"), webPreferences: { preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const send = (ch: string, payload: unknown) => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(ch, payload); };
  const ag = agent = createAgent({ send, settingsFile: path.join(app.getPath("userData"), "agent.json"), version: app.getVersion(), ignoreEnvMode: app.isPackaged });
  ipcMain.handle("agent-reply", (e, r: unknown) => { if (fromWin(e)) ag.reply(r); });
  ipcMain.handle("agent-ready", (e, r: unknown) => { if (fromWin(e) && typeof r === "boolean") ag.setReady(r); });
  ipcMain.handle("agent-menu", (e) => { if (fromWin(e)) menu.popupAgent(); });
  win.webContents.on("did-start-loading", () => ag.setReady(false));
  win.webContents.on("render-process-gone", () => ag.setReady(false));
  win.on("closed", () => ag.setReady(false));
  menu = createMenu({ getWin: () => win, pick: pickFile, agent: { mode: ag.mode, setMode: ag.setMode, clients: ag.clients, setupText: () => setupText({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir }) } });
  ag.onChange(() => menu.refresh());
  void ag.start();
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
});
app.on("window-all-closed", () => app.quit());

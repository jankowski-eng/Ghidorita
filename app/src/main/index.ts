import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
const token = randomBytes(24).toString("hex");
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMenu } from "./menu";
import { validPath } from "./recent";

const appDir = path.resolve(__dirname, "../.."); // app/ (this file is app/out/main/index.js)
const repo = path.resolve(appDir, "..");
let sidecar: ChildProcess | null = null;

const alive = () => !!sidecar && sidecar.exitCode === null && sidecar.signalCode === null;
/** Graceful stop: close stdin + SIGTERM, SIGKILL only after a 3 s grace. Resolves when the sidecar has exited. */
function stopSidecar(): Promise<void> {
  const p = sidecar;
  if (!p || !alive()) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 3000);
    p.once("exit", () => { clearTimeout(t); resolve(); });
    try { p.stdin?.end(); } catch {}
    p.kill("SIGTERM");
  });
}
// last resort for sync exit paths only (the async path above normally already ran)
const killSidecarNow = () => { if (alive()) try { sidecar!.kill("SIGKILL"); } catch {} };
let stopped = false;
app.on("before-quit", (e) => {
  if (stopped) return;
  e.preventDefault();
  stopped = true;
  stopSidecar().then(() => app.quit());
});
process.on("exit", killSidecarNow);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopSidecar().then(() => process.exit(1)); });
process.on("uncaughtException", (e) => { console.error("uncaughtException", e); stopSidecar().then(() => process.exit(1)); });

function startSidecar(): Promise<number> {
  let cmd: string, args: string[];
  if (process.env.MOCK === "1") {
    cmd = "node"; args = [path.join(appDir, "mock/server.mjs")];
  } else if (process.env.SIDECAR_CMD) {
    // shortcut: whitespace split, no quoting support; use a wrapper script if paths contain spaces
    [cmd, ...args] = process.env.SIDECAR_CMD.split(/\s+/);
  } else {
    cmd = path.join(repo, "sidecar/.venv/bin/python"); args = [path.join(repo, "sidecar/main.py")];
  }
  // stdin stays an open pipe: when Electron dies the sidecar sees EOF and exits.
  sidecar = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, SIDECAR_TOKEN: token, SIDECAR_PROJECTS_DIR: process.env.SIDECAR_PROJECTS_DIR ?? path.join(app.getPath("userData"), "projects") } });
  return new Promise((resolve, reject) => {
    sidecar!.on("error", reject);
    sidecar!.on("exit", (code) => { reject(new Error(`sidecar exited early (${code})`)); if (!quitting) { console.error(`sidecar exited (${code})`); } });
    createInterface({ input: sidecar!.stdout! }).once("line", (l) => {
      const port = parseInt(l, 10);
      Number.isFinite(port) ? resolve(port) : reject(new Error("bad port line: " + l));
    });
  });
}
let quitting = false;
app.on("before-quit", () => { quitting = true; });

let win: BrowserWindow;
const autotest = process.env.AUTOTEST;

const fromWin = (e: IpcMainInvokeEvent) => !!win && !win.isDestroyed() && e.sender === win.webContents;
async function pickFile() {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"] });
  return r.canceled ? null : r.filePaths[0];
}
let menu: ReturnType<typeof createMenu>;

ipcMain.handle("pick-file", async (e) => (fromWin(e) ? pickFile() : null));

ipcMain.handle("recent-add", (e, p: unknown) => { if (fromWin(e) && validPath(p)) menu?.addRecent(p); });
ipcMain.handle("menu-state", (e, s: unknown) => {
  const o = s as Record<string, unknown> | null;
  if (!fromWin(e) || !o || typeof o !== "object" || typeof o.canBack !== "boolean" || typeof o.canForward !== "boolean" || typeof o.canOpen !== "boolean") return;
  menu?.setState({ canBack: o.canBack, canForward: o.canForward, canOpen: o.canOpen });
});

ipcMain.handle("autotest-done", async (e, result: { ok: boolean }) => {
  if (!fromWin(e)) return;
  await new Promise((r) => setTimeout(r, 300)); // let the last paint land
  try {
    const img = await win.webContents.capturePage();
    mkdirSync(path.join(appDir, "out"), { recursive: true });
    writeFileSync(path.join(appDir, "out/screenshot.png"), img.toPNG());
  } catch (e) { console.error("screenshot failed", e); }
  console.log("AUTOTEST_RESULT " + JSON.stringify(result));
  stopped = true;
  await stopSidecar();
  app.exit(result.ok ? 0 : 1);
});

app.whenReady().then(async () => {
  let port: number;
  try { port = await startSidecar(); } catch (e) { console.error("sidecar start failed:", e); killSidecarNow(); app.exit(1); return; }
  ipcMain.handle("get-config", (e) => !fromWin(e) ? null : ({ port, token, autotest: autotest ?? null, bench: process.env.BENCH === "1", cancelFile: process.env.AUTOTEST_CANCEL_FILE ?? null }));
  win = new BrowserWindow({ width: 1400, height: 900, webPreferences: { preload: path.join(__dirname, "../preload/index.js") } });
  menu = createMenu({ getWin: () => win, pick: pickFile });
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
});
app.on("window-all-closed", () => app.quit());

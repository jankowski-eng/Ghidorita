import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
const token = randomBytes(24).toString("hex");
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const appDir = path.resolve(__dirname, "../.."); // app/ (this file is app/out/main/index.js)
const repo = path.resolve(appDir, "..");
let sidecar: ChildProcess | null = null;

function killSidecar() {
  if (!sidecar || sidecar.killed) return;
  sidecar.kill("SIGTERM");
  // shortcut: SIGKILL immediately after SIGTERM (no async grace, 'exit' handlers are sync), when sidecar needs graceful shutdown add a wait
  try { sidecar.kill("SIGKILL"); } catch {}
}
app.on("before-quit", killSidecar);
app.on("will-quit", killSidecar);
process.on("exit", killSidecar);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { killSidecar(); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("uncaughtException", e); killSidecar(); process.exit(1); });

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
  sidecar = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, SIDECAR_TOKEN: token } });
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

ipcMain.handle("pick-file", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("autotest-done", async (_e, result: { ok: boolean }) => {
  await new Promise((r) => setTimeout(r, 300)); // let the last paint land
  try {
    const img = await win.webContents.capturePage();
    mkdirSync(path.join(appDir, "out"), { recursive: true });
    writeFileSync(path.join(appDir, "out/screenshot.png"), img.toPNG());
  } catch (e) { console.error("screenshot failed", e); }
  console.log("AUTOTEST_RESULT " + JSON.stringify(result));
  killSidecar();
  app.exit(result.ok ? 0 : 1);
});

app.whenReady().then(async () => {
  let port: number;
  try { port = await startSidecar(); } catch (e) { console.error("sidecar start failed:", e); killSidecar(); app.exit(1); return; }
  ipcMain.handle("get-config", () => ({ port, token, autotest: autotest ?? null }));
  win = new BrowserWindow({ width: 1400, height: 900, webPreferences: { preload: path.join(__dirname, "../preload/index.js") } });
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
});
app.on("window-all-closed", () => app.quit());

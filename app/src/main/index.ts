import { app, BrowserWindow, Menu, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
const token = randomBytes(24).toString("hex");
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMenu } from "./menu";
import { validPath } from "./recent";

const appDir = path.resolve(__dirname, "../.."); // app/ (this file is app/out/main/index.js)
const repo = path.resolve(appDir, "..");
let sidecar: ChildProcess | null = null;

const alive = () => !!sidecar && sidecar.exitCode === null && sidecar.signalCode === null;
// The sidecar saves a dirty program on shutdown (stdin EOF / SIGTERM) and exits only afterwards; a save can take a while on a big
// program, so the SIGKILL grace is long. It costs nothing when idle (the sidecar exits at once). Hard upper bound, logged.
const KILL_GRACE_MS = 60_000;
/** Graceful stop: close stdin + SIGTERM, SIGKILL only after KILL_GRACE_MS. Resolves when the sidecar has exited. */
function stopSidecar(): Promise<void> {
  const p = sidecar;
  if (!p || !alive()) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { console.error(`sidecar still running after ${KILL_GRACE_MS} ms, SIGKILL (an in-progress save may be lost)`); try { p.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS);
    p.once("exit", () => { clearTimeout(t); resolve(); });
    try { p.stdin?.end(); } catch {}
    p.kill("SIGTERM");
  });
}
// last resort for sync exit paths only (the async path above normally already ran)
const killSidecarNow = () => { if (alive()) try { sidecar!.kill("SIGKILL"); } catch {} };
let stopped = false;
let rendererReady = false;          // the renderer fetched its config, so it can run the save-before-quit step
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
    return stopSidecar().then(() => (exitCode === null ? app.quit() : app.exit(exitCode)));
  });
});
ipcMain.handle("quit-ready", (e, r: unknown) => { const o = r as { ok?: unknown; error?: unknown } | null; if (fromWin(e) && o && typeof o.ok === "boolean") quitSave?.({ ok: o.ok, error: typeof o.error === "string" ? o.error.slice(0, 2000) : undefined }); });
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
  // the sidecar requires a token: always a fresh random one, and never let the test-only no-auth escape hatch leak in from the shell
  const env: NodeJS.ProcessEnv = { ...process.env, SIDECAR_TOKEN: token, SIDECAR_PROJECTS_DIR: process.env.SIDECAR_PROJECTS_DIR ?? path.join(app.getPath("userData"), "projects") };
  delete env.SIDECAR_ALLOW_NO_AUTH;
  sidecar = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], env });
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
  const lbl = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : null);
  const m = { canBack: o.canBack, canForward: o.canForward, canOpen: o.canOpen, canEdit: o.canEdit === true, undoLabel: lbl(o.undoLabel), redoLabel: lbl(o.redoLabel), dirty: o.dirty === true, canClose: o.canClose === true };
  menu?.setState(m);
  if (process.platform === "darwin") win.setDocumentEdited(m.dirty);
});

// autotest: invoke a real application-menu item (same click handler as the user's mouse click)
ipcMain.handle("autotest-menu", (e, id: unknown) => { if (fromWin(e) && autotest && typeof id === "string") Menu.getApplicationMenu()?.getMenuItemById(id)?.click(); });
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
  await stopSidecar();
  app.exit(result.ok ? 0 : 1);
});
async function finishAutotest(result: { ok: boolean; persist?: unknown }) {
  await new Promise((r) => setTimeout(r, 300)); // let the last paint land
  try {
    const img = await win.webContents.capturePage();
    mkdirSync(path.join(appDir, "out"), { recursive: true });
    writeFileSync(path.join(appDir, "out/screenshot.png"), img.toPNG());
  } catch (e) { console.error("screenshot failed", e); }
  if (result.persist) writeFileSync(path.join(appDir, "out/autotest-persist.json"), JSON.stringify(result.persist));
  console.log("AUTOTEST_RESULT " + JSON.stringify(result));
}

app.whenReady().then(async () => {
  let port: number;
  try { port = await startSidecar(); } catch (e) { console.error("sidecar start failed:", e); killSidecarNow(); app.exit(1); return; }
  ipcMain.handle("get-config", (e) => !fromWin(e) ? null : (rendererReady = true, { expect: process.env.AUTOTEST_PHASE === "2" ? JSON.parse(readFileSync(path.join(appDir, "out/autotest-persist.json"), "utf8")) : null, port, token, autotest: autotest ?? null, bench: process.env.BENCH === "1", cancelFile: process.env.AUTOTEST_CANCEL_FILE ?? null }));
  win = new BrowserWindow({ width: 1400, height: 900, webPreferences: { preload: path.join(__dirname, "../preload/index.js") } });
  menu = createMenu({ getWin: () => win, pick: pickFile });
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
});
app.on("window-all-closed", () => app.quit());

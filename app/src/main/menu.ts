import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand, MenuState } from "../preload/index";
import { addRecent, clearRecent, getRecent } from "./recent";

type Deps = { getWin: () => BrowserWindow | undefined; pick: () => Promise<string | null> };

export function createMenu({ getWin, pick }: Deps) {
  let state: MenuState = { canBack: false, canForward: false, canOpen: true, canSave: false, canClose: false };

  const send = (cmd: MenuCommand) => {
    const w = getWin();
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send("menu", cmd);
  };
  const shown = { functions: true, listing: true, decompiler: true }; // survives menu rebuilds
  const pane = (label: string, p: keyof typeof shown): MenuItemConstructorOptions =>
    ({ label, type: "checkbox", checked: shown[p], click: (mi) => { shown[p] = mi.checked; send({ type: "toggle-pane", pane: p, visible: mi.checked }); } });

  function build() {
    const recent = getRecent();
    const recentItems: MenuItemConstructorOptions[] = recent.length
      ? [...recent.map((p): MenuItemConstructorOptions => ({ label: p.length > 80 ? "…" + p.slice(-79) : p, enabled: state.canOpen, click: () => send({ type: "open-path", path: p }) })),
         { type: "separator" }, { label: "Clear Recent", click: () => { clearRecent(); build(); } }]
      : [{ label: "(none)", enabled: false }];
    const mac = process.platform === "darwin";
    const template: MenuItemConstructorOptions[] = [
      ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
      { label: "File", submenu: [
        { label: "Open Binary…", accelerator: "CmdOrCtrl+O", enabled: state.canOpen, click: async () => {
          const p = await pick().catch(() => null);
          if (p) send({ type: "open-path", path: p });
        } },
        { label: "Open Recent", enabled: state.canOpen, submenu: recentItems },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", enabled: state.canSave, click: () => send({ type: "save" }) },
        { label: "Close Program", enabled: state.canClose, click: () => send({ type: "close-program" }) },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => send({ type: "close-tab" }) },
        ...(mac ? [] : [{ type: "separator" } as MenuItemConstructorOptions, { role: "quit" } as MenuItemConstructorOptions]),
      ] },
      { role: "editMenu" },
      { label: "View", submenu: [
        pane("Function List", "functions"), pane("Listing", "listing"), pane("Decompiler", "decompiler"),
        { type: "separator" }, { role: "toggleDevTools" },
      ] },
      { label: "Go", submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", enabled: state.canBack, click: () => send({ type: "nav-back" }) },
        { label: "Forward", accelerator: "CmdOrCtrl+]", enabled: state.canForward, click: () => send({ type: "nav-forward" }) },
        { label: "Search Symbols…", accelerator: "CmdOrCtrl+Shift+O", click: () => send({ type: "search" }) },
        { label: "Go to Address…", accelerator: "CmdOrCtrl+G", click: () => send({ type: "goto" }) },
      ] },
      { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  build();
  return {
    setState(s: MenuState) { state = s; build(); },
    addRecent(p: string) { addRecent(p); build(); },
  };
}

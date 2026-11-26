import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand, MenuState } from "../preload/index";
import { addRecent, clearRecent, getRecent } from "./recent";

type Deps = { getWin: () => BrowserWindow | undefined; pick: () => Promise<string | null> };

export function createMenu({ getWin, pick }: Deps) {
  let state: MenuState = { canBack: false, canForward: false, canOpen: true, canEdit: false, undoLabel: null, redoLabel: null, dirty: false, canClose: false };

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
        { id: "save", label: "Save", accelerator: "CmdOrCtrl+S", enabled: state.canEdit && state.dirty, click: () => send({ type: "edit", action: "save" }) },
        { id: "close-program", label: "Close Program", enabled: state.canClose, click: () => send({ type: "close-program" }) },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => send({ type: "close-tab" }) },
        ...(mac ? [] : [{ type: "separator" } as MenuItemConstructorOptions, { role: "quit" } as MenuItemConstructorOptions]),
      ] },
      { label: "Edit", submenu: [
        // registerAccelerator:false = shown but not intercepted, so Cmd+Z / letters still reach text inputs (the renderer routes them)
        { id: "undo", label: state.undoLabel ?? "Undo", accelerator: "CmdOrCtrl+Z", registerAccelerator: false, enabled: state.canEdit && !!state.undoLabel, click: () => send({ type: "edit", action: "undo" }) },
        { id: "redo", label: state.redoLabel ?? "Redo", accelerator: "CmdOrCtrl+Shift+Z", registerAccelerator: false, enabled: state.canEdit && !!state.redoLabel, click: () => send({ type: "edit", action: "redo" }) },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        { type: "separator" },
        ...(([["Rename…", "L", "rename"], ["Retype Variable…", "CmdOrCtrl+L", "retype"], ["Set Comment…", ";", "comment"], ["Create Function", "F", "createFunction"],
          ["Define Data…", "T", "defineData"], ["Create Structure from Data…", "", "createStruct"], ["Auto Create Structure (variable)…", "", "autoStruct"], ["Clear Code Bytes", "C", "clear"], ["Edit Function Signature…", "", "signature"]] as const).map(([label, key, action]): MenuItemConstructorOptions =>
          // the key is only a hint in the label: a real accelerator could swallow plain letters typed into text inputs
          ({ label: key ? `${label}   (${key.replace("CmdOrCtrl", process.platform === "darwin" ? "Cmd" : "Ctrl")})` : label, enabled: state.canEdit, click: () => send({ type: "edit", action }) }))),
      ] },
      { label: "View", submenu: [
        pane("Function List", "functions"), pane("Listing", "listing"), pane("Decompiler", "decompiler"),
        { type: "separator" },
        { label: "Symbol Table", accelerator: "CmdOrCtrl+Shift+Y", click: () => send({ type: "dock", panel: "symbols" }) },
        { label: "Defined Strings", accelerator: "CmdOrCtrl+Shift+E", click: () => send({ type: "dock", panel: "strings" }) },
        { label: "Search Memory…", accelerator: "CmdOrCtrl+Shift+F", click: () => send({ type: "dock", panel: "memsearch" }) },
        { label: "Data Type Manager", accelerator: "CmdOrCtrl+Shift+T", click: () => send({ type: "datatypes" }) },
        { type: "separator" }, { role: "toggleDevTools" },
      ] },
      { label: "Go", submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", enabled: state.canBack, click: () => send({ type: "nav-back" }) },
        { label: "Forward", accelerator: "CmdOrCtrl+]", enabled: state.canForward, click: () => send({ type: "nav-forward" }) },
        { label: "Search Symbols…", accelerator: "CmdOrCtrl+Shift+O", click: () => send({ type: "search" }) },
        { label: "Go to Address…", accelerator: "CmdOrCtrl+G", click: () => send({ type: "goto" }) },
        // the key is only a hint in the label (a real accelerator would swallow a typed x): Listing and Decompiler handle X themselves
        { label: `Show References To   (X)`, enabled: state.canEdit, click: () => send({ type: "xrefs" }) },
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

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand, MenuState } from "../preload/index";
import { allowsCommand, allowsEdit, dockCapability } from "../capabilities";
import { addRecent, clearRecent, getRecent } from "./recent";

type Deps = { getWin: () => BrowserWindow | undefined; pick: () => Promise<string | null> };

export function createMenu({ getWin, pick }: Deps) {
  let state: MenuState = { capabilities: [], hasProgram: false, canBack: false, canForward: false, canOpen: false, canEdit: false, undoLabel: null, redoLabel: null, dirty: false, canClose: false };

  let caps = new Set(state.capabilities);
  const send = (cmd: MenuCommand) => {
    if (!allowsCommand(caps, cmd)) return;
    const w = getWin();
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send("menu", cmd);
  };
  const shown = { functions: true, listing: true, decompiler: true }; // survives menu rebuilds
  const pane = (label: string, p: keyof typeof shown): MenuItemConstructorOptions =>
    ({ id: p, label, enabled: allowsCommand(caps, { type: "toggle-pane", pane: p, visible: true }), type: "checkbox", checked: shown[p], click: (mi) => { shown[p] = mi.checked; send({ type: "toggle-pane", pane: p, visible: mi.checked }); } });

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
        { id: "open", label: "Open Binary…", accelerator: "CmdOrCtrl+O", enabled: state.canOpen, click: async () => {
          const p = await pick().catch(() => null);
          if (p) send({ type: "open-path", path: p });
        } },
        { id: "load-coverage", label: "Load Coverage…", enabled: state.hasProgram && caps.has("coverage"), click: async () => {
          const p = await pick().catch(() => null);
          if (p) send({ type: "coverage-path", path: p });
        } },
        { label: "Clear All Coverage", enabled: state.hasProgram && caps.has("coverage"), click: () => send({ type: "coverage-clear" }) },
        { label: "Open Recent", enabled: state.canOpen, submenu: recentItems },
        { id: "save", label: "Save", accelerator: "CmdOrCtrl+S", enabled: state.hasProgram && caps.has("save") && state.dirty, click: () => send({ type: "edit", action: "save" }) },
        { id: "close-program", label: "Close Program", enabled: state.canClose, click: () => send({ type: "close-program" }) },
        { type: "separator" },
        { id: "close-tab", label: "Close Tab", enabled: state.hasProgram && caps.has("decompile"), accelerator: "CmdOrCtrl+W", click: () => send({ type: "close-tab" }) },
        ...(mac ? [] : [{ type: "separator" } as MenuItemConstructorOptions, { role: "quit" } as MenuItemConstructorOptions]),
      ] },
      { label: "Edit", submenu: [
        // registerAccelerator:false = shown but not intercepted, so Cmd+Z / letters still reach text inputs (the renderer routes them)
        { id: "undo", label: state.undoLabel ?? "Undo", accelerator: "CmdOrCtrl+Z", registerAccelerator: false, enabled: state.hasProgram && caps.has("undo") && !!state.undoLabel, click: () => send({ type: "edit", action: "undo" }) },
        { id: "redo", label: state.redoLabel ?? "Redo", accelerator: "CmdOrCtrl+Shift+Z", registerAccelerator: false, enabled: state.hasProgram && caps.has("undo") && !!state.redoLabel, click: () => send({ type: "edit", action: "redo" }) },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        { type: "separator" },
        ...(([["Rename…", "L", "rename"], ["Retype Variable…", "CmdOrCtrl+L", "retype"], ["Set Comment…", ";", "comment"], ["Create Function", "F", "createFunction"],
          ["Define Data…", "T", "defineData"], ["Create Structure from Data…", "", "createStruct"], ["Auto Create Structure (variable)…", "", "autoStruct"], ["Clear Code Bytes", "C", "clear"], ["Edit Function Signature…", "", "signature"]] as const).map(([label, key, action]): MenuItemConstructorOptions =>
          // the key is only a hint in the label: a real accelerator could swallow plain letters typed into text inputs
          ({ id: action, label: key ? `${label}   (${key.replace("CmdOrCtrl", process.platform === "darwin" ? "Cmd" : "Ctrl")})` : label, enabled: state.hasProgram && allowsEdit(caps, action), click: () => send({ type: "edit", action }) }))),
      ] },
      { label: "View", submenu: [
        pane("Function List", "functions"), pane("Listing", "listing"), pane("Decompiler", "decompiler"),
        // Space is only a hint in the label (a real accelerator would swallow the space typed into text inputs): App handles the key itself
        { label: "Control-Flow Graph   (Space)", enabled: state.canEdit, click: () => send({ type: "graph" }) },
        { type: "separator" },
        { id: "symbols", label: "Symbol Table", enabled: state.hasProgram && caps.has(dockCapability.symbols), accelerator: "CmdOrCtrl+Shift+Y", click: () => send({ type: "dock", panel: "symbols" }) },
        { id: "strings", label: "Defined Strings", enabled: state.hasProgram && caps.has(dockCapability.strings), accelerator: "CmdOrCtrl+Shift+E", click: () => send({ type: "dock", panel: "strings" }) },
        { id: "changes", label: "Changes", enabled: state.hasProgram && caps.has(dockCapability.changes), accelerator: "CmdOrCtrl+Shift+H", click: () => send({ type: "dock", panel: "changes" }) },
        { id: "coverage", label: "Coverage", enabled: state.hasProgram && caps.has(dockCapability.coverage), click: () => send({ type: "dock", panel: "coverage" }) },
        { id: "memsearch", label: "Search Memory…", enabled: state.hasProgram && caps.has(dockCapability.memsearch), accelerator: "CmdOrCtrl+Shift+F", click: () => send({ type: "dock", panel: "memsearch" }) },
        { id: "datatypes", label: "Data Type Manager", enabled: state.hasProgram && caps.has("dataTypes"), accelerator: "CmdOrCtrl+Shift+T", click: () => send({ type: "datatypes" }) },
        { type: "separator" }, { role: "toggleDevTools" },
      ] },
      { label: "Go", submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", enabled: state.canBack, click: () => send({ type: "nav-back" }) },
        { label: "Forward", accelerator: "CmdOrCtrl+]", enabled: state.canForward, click: () => send({ type: "nav-forward" }) },
        { id: "command-bar", label: "Command Bar…", enabled: state.hasProgram, accelerator: "CmdOrCtrl+K", click: () => send({ type: "search" }) },
        { id: "search-symbols", label: "Search Symbols…", enabled: state.hasProgram && caps.has("symbolSearch"), accelerator: "CmdOrCtrl+Shift+O", click: () => send({ type: "search" }) },
        { id: "goto", label: "Go to Address…", enabled: state.hasProgram, accelerator: "CmdOrCtrl+G", click: () => send({ type: "goto" }) },
        // the key is only a hint in the label (a real accelerator would swallow a typed x): Listing and Decompiler handle X themselves
        { id: "xrefs", label: `Show References To   (X)`, enabled: state.hasProgram && caps.has("references"), click: () => send({ type: "xrefs" }) },
      ] },
      { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  build();
  return {
    setState(s: MenuState) { state = s; caps = new Set(s.capabilities); build(); },
    addRecent(p: string) { addRecent(p); build(); },
  };
}

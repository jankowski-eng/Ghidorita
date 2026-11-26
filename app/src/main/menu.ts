import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand, MenuState } from "../preload/index";
import { allowsCommand, allowsEdit, dockCapability } from "../capabilities";
import { KEYS, isHint, showKey } from "../keys";
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
  const mac = process.platform === "darwin";
  const acc = (id: string) => (KEYS[id] && !isHint(id) ? KEYS[id] : undefined); // a real accelerator
  // a hint-only key (plain letters, Space, Cmd+L) is shown in the label: a real accelerator would swallow it when typed into text inputs; the views handle it themselves
  const lab = (label: string, id: string) => (KEYS[id] && isHint(id) ? `${label}   (${showKey(KEYS[id], mac)})` : label);
  const shown = { functions: true, listing: true, decompiler: true }; // survives menu rebuilds
  const pane = (label: string, p: keyof typeof shown): MenuItemConstructorOptions =>
    ({ id: p, label, enabled: allowsCommand(caps, { type: "toggle-pane", pane: p, visible: true }), type: "checkbox", checked: shown[p], click: (mi) => { shown[p] = mi.checked; send({ type: "toggle-pane", pane: p, visible: mi.checked }); } });

  function build() {
    const recent = getRecent();
    const recentItems: MenuItemConstructorOptions[] = recent.length
      ? [...recent.map((p): MenuItemConstructorOptions => ({ label: p.length > 80 ? "…" + p.slice(-79) : p, enabled: state.canOpen, click: () => send({ type: "open-path", path: p }) })),
         { type: "separator" }, { label: "Clear Recent", click: () => { clearRecent(); build(); } }]
      : [{ label: "(none)", enabled: false }];
    const template: MenuItemConstructorOptions[] = [
      ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
      { label: "File", submenu: [
        { id: "open", label: "Open Binary…", accelerator: acc("open"), enabled: state.canOpen, click: async () => {
          const p = await pick().catch(() => null);
          if (p) send({ type: "open-path", path: p });
        } },
        { id: "load-coverage", label: "Load Coverage…", enabled: state.hasProgram && caps.has("coverage"), click: async () => {
          const p = await pick().catch(() => null);
          if (p) send({ type: "coverage-path", path: p });
        } },
        { label: "Clear All Coverage", enabled: state.hasProgram && caps.has("coverage"), click: () => send({ type: "coverage-clear" }) },
        { label: "Export", enabled: state.hasProgram && (caps.has("export") || caps.has("exportGzf")), submenu: [
          { label: "Symbol Map (JSON)…", enabled: allowsCommand(caps, { type: "export", kind: "symbols" }), click: () => send({ type: "export", kind: "symbols" }) },
          { label: "C Header…", enabled: allowsCommand(caps, { type: "export", kind: "header" }), click: () => send({ type: "export", kind: "header" }) },
          { label: "Ghidra Archive (.gzf)…", enabled: allowsCommand(caps, { type: "export", kind: "gzf" }), click: () => send({ type: "export", kind: "gzf" }) },
        ] },
        { label: "Open Recent", enabled: state.canOpen, submenu: recentItems },
        { id: "save", label: "Save", accelerator: acc("save"), enabled: state.hasProgram && caps.has("save") && state.dirty, click: () => send({ type: "edit", action: "save" }) },
        { id: "close-program", label: "Close Program", enabled: state.canClose, click: () => send({ type: "close-program" }) },
        { type: "separator" },
        { id: "close-tab", label: "Close Tab", enabled: state.hasProgram && caps.has("decompile"), accelerator: acc("close-tab"), click: () => send({ type: "close-tab" }) },
        ...(mac ? [] : [{ type: "separator" } as MenuItemConstructorOptions, { role: "quit" } as MenuItemConstructorOptions]),
      ] },
      { label: "Edit", submenu: [
        // registerAccelerator:false = shown but not intercepted, so Cmd+Z / letters still reach text inputs (the renderer routes them)
        { id: "undo", label: state.undoLabel ?? "Undo", accelerator: acc("edit:undo"), registerAccelerator: false, enabled: state.hasProgram && caps.has("undo") && !!state.undoLabel, click: () => send({ type: "edit", action: "undo" }) },
        { id: "redo", label: state.redoLabel ?? "Redo", accelerator: acc("edit:redo"), registerAccelerator: false, enabled: state.hasProgram && caps.has("undo") && !!state.redoLabel, click: () => send({ type: "edit", action: "redo" }) },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        { type: "separator" },
        // Cmd+C stays the focused control's own copy (a selection in the decompiler); these copy what the cursor stands for
        ...(([["Copy Address", "address"], ["Copy Bytes (Hex)", "bytes"], ["Copy Bytes (C Array)", "carray"], ["Copy Decompiled Function", "decompiled"]] as const).map(([label, what]): MenuItemConstructorOptions =>
          ({ id: "copy-" + what, label, accelerator: acc("copy:" + what), enabled: state.hasProgram && allowsCommand(caps, { type: "copy", what }), click: () => send({ type: "copy", what }) }))),
        { type: "separator" },
        { id: "bookmark", label: "Add Bookmark…", accelerator: acc("edit:bookmark"), enabled: state.hasProgram && allowsEdit(caps, "bookmark"), click: () => send({ type: "edit", action: "bookmark" }) },
        ...(([["Rename…", "rename"], ["Retype Variable…", "retype"], ["Set Comment…", "comment"], ["Create Function", "createFunction"],
          ["Define Data…", "defineData"], ["Define Array…", "defineArray"], ["Define Pointer", "definePointer"], ["Repeat Last Data Type", "repeatData"], ["Create Structure from Data…", "createStruct"], ["Auto Create Structure (variable)…", "autoStruct"], ["Set Equate…", "setEquate"], ["Mark Function as No Return", "noReturn"], ["Split Out As New Variable…", "splitVariable"], ["Force Field…", "forceField"], ["Clear Code Bytes", "clear"], ["Edit Function Signature…", "signature"]] as const).map(([label, action]): MenuItemConstructorOptions =>
          ({ id: action, label: lab(label, "edit:" + action), enabled: state.hasProgram && allowsEdit(caps, action), click: () => send({ type: "edit", action }) }))),
      ] },
      { label: "View", submenu: [
        pane("Function List", "functions"), pane("Listing", "listing"), pane("Decompiler", "decompiler"),
        { label: "Control-Flow Graph", accelerator: acc("graph"), enabled: state.hasProgram && allowsCommand(caps, { type: "graph" }), click: () => send({ type: "graph" }) },
        { label: "Call Graph", enabled: state.hasProgram && allowsCommand(caps, { type: "callgraph" }), accelerator: acc("callgraph"), click: () => send({ type: "callgraph" }) },
        { type: "separator" },
        { id: "symbols", label: "Symbol Table", enabled: state.hasProgram && caps.has(dockCapability.symbols), accelerator: acc("dock:symbols"), click: () => send({ type: "dock", panel: "symbols" }) },
        { id: "strings", label: "Defined Strings", enabled: state.hasProgram && caps.has(dockCapability.strings), accelerator: acc("dock:strings"), click: () => send({ type: "dock", panel: "strings" }) },
        { id: "undefined", label: "Undefined Data References", enabled: state.hasProgram && caps.has(dockCapability.undefined), click: () => send({ type: "dock", panel: "undefined" }) }, // Ghidra has no key for it
        { id: "changes", label: "Changes", enabled: state.hasProgram && caps.has(dockCapability.changes), accelerator: acc("dock:changes"), click: () => send({ type: "dock", panel: "changes" }) },
        { id: "stack", label: "Stack Frame", enabled: state.hasProgram && caps.has(dockCapability.stack), click: () => send({ type: "dock", panel: "stack" }) }, // Ghidra has no key for its stack window
        { id: "calls", label: "Calls (callers and callees)", enabled: state.hasProgram && caps.has(dockCapability.calls), accelerator: acc("dock:calls"), click: () => send({ type: "dock", panel: "calls" }) },
        { id: "bookmarks", label: "Bookmarks", enabled: state.hasProgram && caps.has(dockCapability.bookmarks), accelerator: acc("dock:bookmarks"), click: () => send({ type: "dock", panel: "bookmarks" }) },
        { id: "coverage", label: "Coverage", enabled: state.hasProgram && caps.has(dockCapability.coverage), click: () => send({ type: "dock", panel: "coverage" }) },
        { id: "registers", label: "Registers", enabled: state.hasProgram && caps.has(dockCapability.registers), click: () => send({ type: "dock", panel: "registers" }) },
        { id: "locals", label: "Locals", enabled: state.hasProgram && caps.has(dockCapability.locals), click: () => send({ type: "dock", panel: "locals" }) },
        { id: "memory", label: "Target Memory", enabled: state.hasProgram && caps.has(dockCapability.memory), click: () => send({ type: "dock", panel: "memory" }) },
        { id: "memsearch", label: lab("Search Memory…", "dock:memsearch"), enabled: state.hasProgram && caps.has(dockCapability.memsearch), accelerator: acc("dock:memsearch"), click: () => send({ type: "dock", panel: "memsearch" }) },
        { id: "datatypes", label: "Data Type Manager", enabled: state.hasProgram && caps.has("dataTypes"), accelerator: acc("datatypes"), click: () => send({ type: "datatypes" }) },
        { type: "separator" }, { role: "toggleDevTools" },
      ] },
      { label: "Go", submenu: [
        { label: lab("Back", "nav-back"), accelerator: acc("nav-back"), enabled: state.canBack, click: () => send({ type: "nav-back" }) },
        { label: lab("Forward", "nav-forward"), accelerator: acc("nav-forward"), enabled: state.canForward, click: () => send({ type: "nav-forward" }) },
        { id: "command-bar", label: "Command Bar…", enabled: state.hasProgram, accelerator: acc("search"), click: () => send({ type: "search" }) },
        { id: "search-symbols", label: "Search Symbols…", enabled: state.hasProgram && caps.has("symbolSearch"), accelerator: acc("symbolSearch"), click: () => send({ type: "search" }) },
        { id: "goto", label: lab("Go to Address…", "goto"), enabled: state.hasProgram, accelerator: acc("goto"), click: () => send({ type: "goto" }) },
        { id: "xrefs", label: "Show References To", accelerator: acc("xrefs"), enabled: state.hasProgram && caps.has("references"), click: () => send({ type: "xrefs" }) },
      ] },
      { label: "Debug", submenu: ([
        ["Attach to QEMU…", "attach"], ["Detach", "detach"], [null, ""],
        ["Continue", "continue"], ["Pause", "pause"], ["Step Over Statement", "step"], ["Step Into", "stepinto"], ["Step Out", "stepout"], ["Step Instruction", "stepi"], [null, ""],
        ["Back in History", "back"], ["Forward in History", "forward"], ["Toggle Breakpoint", "breakpoint"],
      ] as const).map(([label, action]): MenuItemConstructorOptions => label === null ? { type: "separator" }
        : { id: "debug-" + action, label, accelerator: acc("debug:" + action), enabled: state.hasProgram && allowsCommand(caps, { type: "debug", action }), click: () => send({ type: "debug", action }) }) },
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

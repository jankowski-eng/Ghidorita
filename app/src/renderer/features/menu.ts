import { useEffect } from "react";
import type { Address } from "../../../../protocol";
import { allowsCommand } from "../../capabilities";
import type { MenuCommand, MenuState } from "../../preload/index";
import { windowTitle } from "../session";
import { useProgram, useSession, useViews, type Session } from "../store/session";
import type { Views } from "../store/views";
import type { EditAction } from "../editActions";
import { requestOpen } from "./dialogs";
import { exportAs } from "./exports";
import type { CoverageActions } from "./coverage";

export interface MenuTargets {
  back(): void; forward(): void; goTab(entry: Address | null): void; closeActive(): Address | null;
  edit(a: EditAction): Promise<void> | void; showXrefs(): void; coverage: CoverageActions;
}

/** Every menu command (and the command bar's actions, and the autotest's `command`) ends here. */
export function routeMenu(s: Session, c: MenuCommand, t: MenuTargets) {
  const { views } = s, opened = () => !!s.program();
  const set = (patch: Partial<Views>) => views.dispatch({ type: "set", patch });
  if (!allowsCommand(s.caps, c) || s.blocked() || views.getState().importFor) return;
  if (c.type === "open-path") requestOpen(s, c.path);
  else if (c.type === "coverage-path") void t.coverage.load(c.path);
  else if (c.type === "coverage-clear") t.coverage.clear();
  else if (c.type === "coverage-load") { if (opened()) void t.coverage.pick(); }
  else if (c.type === "close-program") void s.closeProgram();
  else if (c.type === "search") { if (opened()) set({ searchOpen: true }); }
  else if (c.type === "nav-back") t.back();
  else if (c.type === "nav-forward") t.forward();
  else if (c.type === "goto") { if (opened()) set({ gotoOpen: true }); }
  else if (c.type === "close-tab") t.goTab(t.closeActive());
  else if (c.type === "edit") void t.edit(c.action);
  else if (c.type === "dock") { if (opened()) set({ dock: c.panel }); }
  else if (c.type === "xrefs") t.showXrefs();
  else if (c.type === "export") void exportAs(s, c.kind);
  else if (c.type === "graph") { if (opened()) set({ graphOn: !views.getState().graphOn, callGraphOn: false }); }
  else if (c.type === "callgraph") { if (opened()) set({ callGraphOn: !views.getState().callGraphOn, graphOn: false }); }
  else if (c.type === "datatypes") { if (opened()) set({ typesOpen: !views.getState().typesOpen }); }
  else if (c.type === "toggle-pane") set({ visible: { ...views.getState().visible, [c.pane]: c.visible } });
}

/** True while something modal runs: opening, the import dialog, closing, or a lost connection. */
export function useBusy() {
  const running = useProgram((s) => !!s.opening || s.closing || s.unavailable), importing = useViews((v) => !!v.importFor);
  return running || importing;
}

/** The menu's enabled items and undo labels follow the program state. */
export function useMenuState(canBack: boolean, canForward: boolean) {
  const s = useSession();
  const opened = useProgram((p) => !!p.program), saving = useProgram((p) => p.saving), undo = useProgram((p) => p.undo);
  const busy = useBusy();
  useEffect(() => {
    const state: MenuState = {
      canBack: canBack && !busy, canForward: canForward && !busy, canOpen: !busy, canEdit: opened && !busy && !saving && s.caps.has("editing"),
      hasProgram: opened && !busy && !saving, capabilities: [...s.caps], recovery: s.backend.recovery,
      undoLabel: undo.canUndo ? "Undo " + (undo.undoName ?? "") : null, redoLabel: undo.canRedo ? "Redo " + (undo.redoName ?? "") : null, dirty: undo.dirty, canClose: opened && !busy && !saving,
    };
    s.menu.current = state; window.host.setMenuState(state).catch(() => {});
  }, [canBack, canForward, busy, opened, saving, undo.canUndo, undo.canRedo, undo.undoName, undo.redoName, undo.dirty]); // eslint-disable-line
}
export function useWindowTitle() {
  const name = useProgram((p) => p.program?.session.name ?? null), dirty = useProgram((p) => p.undo.dirty);
  useEffect(() => { document.title = windowTitle(name, !!name && dirty); }, [name, dirty]);
}

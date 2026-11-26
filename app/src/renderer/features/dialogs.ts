import type { ImportOptions } from "../../../../protocol";
import type { Session } from "../store/session";

/** Opening a path: with import options on offer the import dialog comes first (views.importFor), otherwise the open starts at once. */
export const requestOpen = (s: Session, path: string) => {
  if (s.blocked() || s.views.getState().importFor) return;
  if (!s.caps.has("importOptions")) { void s.open(path); return; }
  s.views.dispatch({ type: "set", patch: { importFor: path } });
};
export const confirmImport = (s: Session, path: string, options: ImportOptions | undefined) => {
  s.views.dispatch({ type: "set", patch: { importFor: null } });
  void s.open(path, options);
};
export const cancelImport = (s: Session) => s.views.dispatch({ type: "set", patch: { importFor: null } });

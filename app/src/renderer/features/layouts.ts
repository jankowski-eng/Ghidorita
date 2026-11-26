import { dockCapability } from "../../capabilities";
import { DEFAULT_NAME, DOCKS, cleanName, deleteLayout, fitLayout, layoutNames, readLayouts, saveLayout, saveSizes, type Center, type Layout } from "../layouts";
import type { PaneId } from "../Layout";
import type { Session } from "../store/session";
import type { Views } from "../store/views";

export const centerOf = (v: Pick<Views, "graphOn" | "callGraphOn" | "pcodeOn">): Center => (v.graphOn ? "graph" : v.callGraphOn ? "callgraph" : v.pcodeOn ? "pcode" : "c");

/** The arrangement on screen now, as a layout. */
export const currentLayout = (v: Views): Layout => ({ order: [...v.paneOrder], visible: { ...v.visible }, sizes: { ...v.paneSizes }, center: centerOf(v), dock: v.dock && (DOCKS as readonly string[]).includes(v.dock) ? v.dock : null });

const refreshNames = (s: Session) => s.views.dispatch({ type: "set", patch: { layoutNames: layoutNames(readLayouts()) } });

/** Save the current arrangement under `name` (an existing name is replaced). Throws a message for the dialog to show. */
export function saveCurrentLayout(s: Session, name: string) {
  const r = saveLayout(name, currentLayout(s.views.getState()));
  if (!r.ok) throw new Error(r.error);
  refreshNames(s);
  s.flash(`Saved layout ${cleanName(name)}.`);
}

/** Restore a stored layout; what the provider cannot show (a graph, a dock tab) falls back to the plain arrangement. */
export function applyLayout(s: Session, name: string) {
  const l = readLayouts().layouts[name];
  if (!l) return s.flash(`No layout named ${name}.`);
  const f = fitLayout(l, s.caps, dockCapability);
  s.views.dispatch({ type: "set", patch: { paneOrder: f.order, visible: f.visible, paneSizes: f.sizes, graphOn: f.center === "graph", callGraphOn: f.center === "callgraph", pcodeOn: f.center === "pcode", dock: f.dock } });
  saveSizes(f.sizes);
  s.flash(`Layout ${name}.`);
}

export function removeLayout(s: Session, name: string) {
  const r = deleteLayout(name);
  if (!r.ok) return s.flash(r.error!);
  refreshNames(s);
  s.flash(`Deleted layout ${name}.`);
}

/** Move a pane one place left (-1) or right (1). */
export function movePane(s: Session, pane: PaneId, dir: -1 | 1) {
  const order = [...s.views.getState().paneOrder], i = order.indexOf(pane), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  s.views.dispatch({ type: "set", patch: { paneOrder: order } });
}
export { DEFAULT_NAME };

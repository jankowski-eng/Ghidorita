import type { Address } from "../../../../protocol";
import type { Nav } from "../nav";
import type { FuncAt } from "../symbols";
import type { DockId } from "../Dock";
import type { PaneId } from "../Layout";
import type { EditSpec } from "../EditDialog";
import type { FormField, FormPreview } from "../FormDialog";
import type { XrefTarget } from "../editActions";
import type { CommentKind, ValueTrail } from "../../../../protocol";
import { emptyNav } from "../nav";
import { createStore } from "./createStore";
import { layoutNames, readLayouts, startupLayout, type Sizes } from "../layouts";

export type RangeList = { start: Address; end: Address }[] | null;
export interface EditDialogState { spec: EditSpec; submit: (v: string, k: CommentKind) => Promise<void> }
export interface FormDialogState { title: string; submit: string; fields: FormField[]; preview?: FormPreview; go: (v: Record<string, string>) => Promise<void> }

/** What the panes show about the open program (position, panels, dialogs). Everything but `visible`, `graphOn`, `callGraphOn`, `pcodeOn`, `covVersion`, `dataVersion`, `typesVersion` and `importFor` is dropped on a reset. */
export interface Views {
  nav: Nav;
  fn: FuncAt | null;
  scrollReq: { address: Address; n: number; refresh?: boolean };
  listingChange: { n: number; ranges: RangeList };
  xrefVersion: number;
  cursorAt: Address | null;            // the shared cursor: the listing row or decompiler token last clicked or moved to (the hex view follows it)
  xrefTarget: XrefTarget | null;       // pinned "show references" target; null = follow the cursor
  trailSeq: number;                    // bumped whenever a trail starts or is cleared (Esc, command, a program change): a reply for an older one is dropped
  trail: { entry: Address; name: string; trail: ValueTrail } | null; // the value trail shown in the decompiler and listing (Esc clears it)
  useHl: { name: string; address: Address } | null; // a clicked decompiler-variable use: its token is highlighted
  dock: DockId | null;
  graphOn: boolean;                    // the decompiler pane shows the control-flow graph of the active function
  callGraphOn: boolean;                // ... or the call graph around it
  pcodeOn: boolean;                    // ... or its p-code (at most one of the three)
  searchOpen: boolean; gotoOpen: boolean; typesOpen: boolean;
  dlg: EditDialogState | null; formDlg: FormDialogState | null;
  visible: Record<PaneId, boolean>;
  paneOrder: PaneId[];                 // left to right
  paneSizes: Sizes;                    // widths of the functions and listing panes
  layoutNames: string[];               // the saved layouts (a user setting, not part of any program)
  dataVersion: number;                 // bumped on every program change: the dock windows refetch
  typesVersion: number;
  covVersion: number;                  // bumped whenever the coverage runs or their selection change
  importFor: string | null;
}
export const initialViews: Views = {
  nav: emptyNav, fn: null, scrollReq: { address: "" as Address, n: 0 }, listingChange: { n: 0, ranges: null }, xrefVersion: 0, cursorAt: null, xrefTarget: null, trail: null, trailSeq: 0, useHl: null,
  dock: null, graphOn: false, callGraphOn: false, pcodeOn: false, searchOpen: false, gotoOpen: false, typesOpen: false, dlg: null, formDlg: null,
  visible: { functions: true, listing: true, decompiler: true }, paneOrder: ["functions", "listing", "decompiler"], paneSizes: { functions: 260, listing: 560 }, layoutNames: ["Default"], dataVersion: 0, typesVersion: 0, covVersion: 0, importFor: null,
};

export type ViewsAction = { type: "set"; patch: Partial<Views> | ((v: Views) => Partial<Views>) } | { type: "reset" };
export function viewsReducer(v: Views, a: ViewsAction): Views {
  if (a.type === "set") return { ...v, ...(typeof a.patch === "function" ? a.patch(v) : a.patch) };
  // the scroll request keeps counting so the listing notices the new position
  return { ...initialViews, scrollReq: { address: "" as Address, n: v.scrollReq.n + 1 }, trailSeq: v.trailSeq, visible: v.visible, paneOrder: v.paneOrder, paneSizes: v.paneSizes, layoutNames: v.layoutNames, graphOn: v.graphOn, callGraphOn: v.callGraphOn, pcodeOn: v.pcodeOn, dataVersion: v.dataVersion, typesVersion: v.typesVersion, covVersion: v.covVersion, importFor: v.importFor };
}
/** Patch that clears the value trail and invalidates any request still in flight for it. */
export const clearTrail = (v: Views): Partial<Views> => ({ trail: null, trailSeq: v.trailSeq + 1 });

/** The views store; the pane sizes and order start from the stored Default layout and the sizes last dragged to (storage read in try/catch, the built-in sizes if it fails). */
export function createViews() {
  const start = startupLayout();
  return createStore(viewsReducer, { ...initialViews, paneOrder: start.order, paneSizes: start.sizes, layoutNames: layoutNames(readLayouts()) });
}

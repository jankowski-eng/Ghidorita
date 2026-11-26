import type { Address } from "../../../../protocol";
import type { Nav } from "../nav";
import type { FuncAt } from "../symbols";
import type { DockId } from "../Dock";
import type { PaneId } from "../Layout";
import type { EditSpec } from "../EditDialog";
import type { FormField } from "../FormDialog";
import type { XrefTarget } from "../editActions";
import type { CommentKind } from "../../../../protocol";
import { emptyNav } from "../nav";
import { createStore } from "./createStore";

export type RangeList = { start: Address; end: Address }[] | null;
export interface EditDialogState { spec: EditSpec; submit: (v: string, k: CommentKind) => Promise<void> }
export interface FormDialogState { title: string; submit: string; fields: FormField[]; go: (v: Record<string, string>) => Promise<void> }

/** What the panes show about the open program (position, panels, dialogs). Everything but `visible`, `covVersion`, `dataVersion`, `typesVersion` and `importFor` is dropped on a reset. */
export interface Views {
  nav: Nav;
  fn: FuncAt | null;
  scrollReq: { address: Address; n: number; refresh?: boolean };
  listingChange: { n: number; ranges: RangeList };
  xrefVersion: number;
  xrefTarget: XrefTarget | null;       // pinned "show references" target; null = follow the cursor
  useHl: { name: string; address: Address } | null; // a clicked decompiler-variable use: its token is highlighted
  dock: DockId | null;
  searchOpen: boolean; gotoOpen: boolean; typesOpen: boolean;
  dlg: EditDialogState | null; formDlg: FormDialogState | null;
  visible: Record<PaneId, boolean>;
  dataVersion: number;                 // bumped on every program change: the dock windows refetch
  typesVersion: number;
  covVersion: number;                  // bumped whenever the coverage runs or their selection change
  importFor: string | null;
}
export const initialViews: Views = {
  nav: emptyNav, fn: null, scrollReq: { address: "" as Address, n: 0 }, listingChange: { n: 0, ranges: null }, xrefVersion: 0, xrefTarget: null, useHl: null,
  dock: null, searchOpen: false, gotoOpen: false, typesOpen: false, dlg: null, formDlg: null,
  visible: { functions: true, listing: true, decompiler: true }, dataVersion: 0, typesVersion: 0, covVersion: 0, importFor: null,
};

export type ViewsAction = { type: "set"; patch: Partial<Views> | ((v: Views) => Partial<Views>) } | { type: "reset" };
export function viewsReducer(v: Views, a: ViewsAction): Views {
  if (a.type === "set") return { ...v, ...(typeof a.patch === "function" ? a.patch(v) : a.patch) };
  // the scroll request keeps counting so the listing notices the new position
  return { ...initialViews, scrollReq: { address: "" as Address, n: v.scrollReq.n + 1 }, visible: v.visible, dataVersion: v.dataVersion, typesVersion: v.typesVersion, covVersion: v.covVersion, importFor: v.importFor };
}
export const createViews = () => createStore(viewsReducer, initialViews);

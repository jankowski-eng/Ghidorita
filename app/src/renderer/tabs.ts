import type { Address } from "../../../protocol";

export interface Tab { id: number; entry: Address; pinned: boolean }
/** Decompiler tabs with one optional preview (unpinned) tab, VS Code style. Immutable. */
export interface Tabs { tabs: Tab[]; active: number | null; nextId: number }
export const emptyTabs: Tabs = { tabs: [], active: null, nextId: 1 };

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

/** Show a function: reuse its tab, else replace the preview tab, else add a new preview tab. `pin` also pins it. */
export function openFunction(t: Tabs, entry: Address, pin = false): Tabs {
  const hit = t.tabs.find((x) => same(x.entry, entry));
  if (hit) return { ...t, active: hit.id, tabs: pin && !hit.pinned ? t.tabs.map((x) => (x === hit ? { ...x, pinned: true } : x)) : t.tabs };
  const tab: Tab = { id: t.nextId, entry, pinned: pin };
  const at = pin ? -1 : t.tabs.findIndex((x) => !x.pinned);
  const tabs = at >= 0 ? t.tabs.map((x, i) => (i === at ? tab : x)) : [...t.tabs, tab];
  return { tabs, active: tab.id, nextId: t.nextId + 1 };
}
export const pinTab = (t: Tabs, id: number): Tabs => ({ ...t, tabs: t.tabs.map((x) => (x.id === id ? { ...x, pinned: true } : x)) });
export const activateTab = (t: Tabs, id: number): Tabs => (t.tabs.some((x) => x.id === id) ? { ...t, active: id } : t);
export function closeTab(t: Tabs, id: number): Tabs {
  const i = t.tabs.findIndex((x) => x.id === id);
  if (i < 0) return t;
  const tabs = t.tabs.filter((x) => x.id !== id);
  const active = t.active !== id ? t.active : tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : null;
  return { ...t, tabs, active };
}
/** Tab ids present in `before` but not in `after` (closed or replaced): cancel their decompiles, drop their state. */
export const droppedIds = (before: Tabs, after: Tabs): number[] => before.tabs.filter((x) => !after.tabs.some((y) => y.id === x.id)).map((x) => x.id);

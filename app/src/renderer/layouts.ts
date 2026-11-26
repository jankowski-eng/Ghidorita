import type { DockId } from "./Dock";
import type { PaneId } from "./Layout";

/** What a named layout holds: the panes shown and their order, the sizes of the two sized panes, what replaces the decompiler (C, a graph, p-code) and the open dock tab. */
export type Center = "c" | "graph" | "callgraph" | "pcode";
export interface Sizes { functions: number; listing: number }
export interface Layout { order: PaneId[]; visible: Record<PaneId, boolean>; sizes: Sizes; center: Center; dock: DockId | null }

export const DEFAULT_NAME = "Default";
export const PANES: readonly PaneId[] = ["functions", "listing", "decompiler"];
export const DOCKS = ["strings", "symbols", "memsearch", "changes", "coverage", "calls", "bookmarks", "hex"] as const satisfies readonly DockId[];
const CENTERS: readonly Center[] = ["c", "graph", "callgraph", "pcode"];
export const MIN = 120, MAX = 2000;
export const KEY = "ghidorita.layouts.v1", OLD_KEY = "ghidra.layout.v1"; // OLD_KEY: the sizes saved before named layouts existed
export const BUILTIN: Layout = { order: [...PANES], visible: { functions: true, listing: true, decompiler: true }, sizes: { functions: 260, listing: 560 }, center: "c", dock: null };

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void }
/** localStorage, or undefined where it is blocked or missing (private window, cleared site data, tests). */
export function browserStorage(): StorageLike | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

const clamp = (n: number) => Math.min(MAX, Math.max(MIN, Math.round(n)));
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
export function cleanSizes(x: unknown): Sizes | null {
  return isObj(x) && typeof x.functions === "number" && typeof x.listing === "number" && Number.isFinite(x.functions) && Number.isFinite(x.listing)
    ? { functions: clamp(x.functions), listing: clamp(x.listing) } : null;
}
/** A stored layout checked field by field; null if it is not one (a bad entry is dropped, the others stay). */
export function cleanLayout(x: unknown): Layout | null {
  if (!isObj(x)) return null;
  const sizes = cleanSizes(x.sizes), order = x.order, vis = x.visible;
  if (!sizes || !Array.isArray(order) || order.length !== PANES.length || !PANES.every((p) => order.includes(p))) return null;
  if (!isObj(vis) || !PANES.every((p) => typeof vis[p] === "boolean")) return null;
  if (!CENTERS.includes(x.center as Center)) return null;
  if (x.dock !== null && !(DOCKS as readonly unknown[]).includes(x.dock)) return null;
  return { order: [...order] as PaneId[], visible: { functions: !!vis.functions, listing: !!vis.listing, decompiler: !!vis.decompiler }, sizes, center: x.center as Center, dock: x.dock as DockId | null };
}

export interface LayoutStore { layouts: Record<string, Layout>; sizes: Sizes | null } // sizes: what the panes were last dragged to (null: the Default's)

/** The stored layouts. Missing or corrupt storage gives the built-in Default alone; the sizes of the old single key become the Default's. */
export function readLayouts(st: StorageLike | undefined = browserStorage()): LayoutStore {
  let layouts: Record<string, Layout> = {}, sizes: Sizes | null = null, found = false;
  try {
    const raw = st?.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (isObj(p) && isObj(p.layouts)) {
        found = true;
        for (const [name, l] of Object.entries(p.layouts)) { const c = cleanLayout(l); if (c && name.trim()) layouts[name] = c; }
        sizes = cleanSizes(p.sizes);
      }
    }
  } catch { layouts = {}; sizes = null; found = false; }
  if (!found) { // first run with named layouts: carry the old saved sizes over
    try { const old = cleanSizes(JSON.parse(st?.getItem(OLD_KEY) ?? "null")); if (old) layouts[DEFAULT_NAME] = { ...BUILTIN, sizes: old }; } catch { /* corrupt: defaults */ }
    if (layouts[DEFAULT_NAME]) { writeLayouts({ layouts, sizes: null }, st); try { st?.removeItem?.(OLD_KEY); } catch { /* keep it */ } }
  }
  if (!layouts[DEFAULT_NAME]) layouts[DEFAULT_NAME] = { ...BUILTIN, order: [...BUILTIN.order], visible: { ...BUILTIN.visible }, sizes: { ...BUILTIN.sizes } };
  return { layouts, sizes };
}
export function writeLayouts(s: LayoutStore, st: StorageLike | undefined = browserStorage()): boolean {
  try { st?.setItem(KEY, JSON.stringify(s)); return !!st; } catch { return false; }
}
/** Names in the order they are listed: the Default first, then the others alphabetically. */
export const layoutNames = (s: LayoutStore): string[] => [DEFAULT_NAME, ...Object.keys(s.layouts).filter((n) => n !== DEFAULT_NAME).sort((a, b) => a.localeCompare(b))];

/** A valid layout name: trimmed, 1 to 40 characters. */
export const cleanName = (n: string): string | null => { const t = n.trim(); return t && t.length <= 40 ? t : null; };
export function saveLayout(name: string, layout: Layout, st?: StorageLike): { ok: boolean; error?: string } {
  const n = cleanName(name);
  if (!n) return { ok: false, error: "A layout name is 1 to 40 characters." };
  const s = readLayouts(st);
  s.layouts[n] = layout;
  return writeLayouts(s, st) ? { ok: true } : { ok: false, error: "Could not store the layout (browser storage is unavailable)." };
}
export function deleteLayout(name: string, st?: StorageLike): { ok: boolean; error?: string } {
  if (name === DEFAULT_NAME) return { ok: false, error: "The Default layout cannot be deleted." };
  const s = readLayouts(st);
  if (!s.layouts[name]) return { ok: false, error: `No layout named ${name}.` };
  delete s.layouts[name];
  return writeLayouts(s, st) ? { ok: true } : { ok: false, error: "Could not store the layouts." };
}
export function saveSizes(sizes: Sizes, st?: StorageLike): void {
  const s = readLayouts(st);
  writeLayouts({ ...s, sizes }, st);
}
/** The layout to start with: the stored sizes (or the Default's) on the Default arrangement. */
export function startupLayout(st?: StorageLike): Layout {
  const s = readLayouts(st), d = s.layouts[DEFAULT_NAME];
  return { ...d, order: [...d.order], visible: { ...d.visible }, sizes: s.sizes ?? d.sizes };
}
/** Panes and docks the provider cannot show fall back to the plain arrangement when a layout is applied. */
export function fitLayout(l: Layout, caps: { has(c: string): boolean }, dockCap: Record<string, string>): Layout {
  const center = (l.center === "pcode" && !(caps.has("pcode") && caps.has("decompile"))) || (l.center === "graph" && !(caps.has("controlFlowGraph") && caps.has("decompile"))) || (l.center === "callgraph" && !caps.has("callGraph")) ? "c" : l.center;
  const dock = l.dock && dockCap[l.dock] && caps.has(dockCap[l.dock]) ? l.dock : null;
  return { ...l, center, dock };
}

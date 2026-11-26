import type { DataTypeHit } from "../../../protocol";

export interface Level { categories: { name: string; path: string }[]; types: DataTypeHit[] }
export type TreeRow =
  | { key: string; depth: number; kind: "category"; label: string; source: string; path: string; open: boolean }
  | { key: string; depth: number; kind: "type"; label: string; source: string; path: string; node: DataTypeHit };

/** Tree key of a category (also "source|/" for a source root). */
export const catKey = (source: string, path: string) => `${source}|${path}`;
export const typeKey = (source: string, path: string) => `${source}|type|${path}`;

/**
 * Flatten the lazily loaded tree into visible rows: each source is a root category; an open category lists its
 * sub-categories then its types. Categories not loaded yet contribute only their own row.
 */
export function flatten(sources: { id: string; name: string }[], open: Set<string>, level: (source: string, path: string) => Level | undefined): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (source: string, path: string, label: string, depth: number) => {
    const key = catKey(source, path), isOpen = open.has(key);
    out.push({ key, depth, kind: "category", label, source, path, open: isOpen });
    const l = isOpen ? level(source, path) : undefined;
    if (!l) return;
    for (const c of l.categories) walk(source, c.path, c.name, depth + 1);
    for (const t of l.types) out.push({ key: typeKey(source, t.path), depth: depth + 1, kind: "type", label: t.name, source, path: t.path, node: t });
  };
  for (const s of sources) walk(s.id, "/", s.name, 0);
  return out;
}

export const parentPath = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
export const fmtSize = (n: number) => (n < 0 ? "dyn" : String(n));
export const hex = (n: number) => "0x" + n.toString(16);

/** Address text typed by a user -> the protocol's lowercase 0x form, or null. */
export function normAddress(s: string): string | null {
  const m = /^\s*(?:0x)?([0-9a-f]+)\s*$/i.exec(s);
  return m ? "0x" + m[1].toLowerCase().replace(/^0+(?=.)/, "") : null;
}

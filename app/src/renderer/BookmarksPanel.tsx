import { useRef, useState } from "react";
import type { Address, BookmarkItem } from "../../../protocol";
import type { Bookmarks } from "./backend";
import { useDebounced } from "./hooks";
import { scanner } from "./scan";
import { usePaged, VirtualTable, type Col, type Sort } from "./VirtualTable";

/**
 * Bookmarks (list_bookmarks): sortable by address, type and category, a type filter (Note = your own bookmarks, the default; the analyzers
 * make Analysis, Warning, Error and Info ones in the thousands) and a text filter. Click or Enter navigates; × removes exactly that row (its address, type and category).
 */
const PROBLEMS = "Error,Warning"; // list_bookmarks takes a comma list of types
export function BookmarksPanel({ bookmarks, version, onGo, onError }: { bookmarks: Bookmarks; version: number; onGo: (a: Address) => void; onError: (e: unknown) => void }) {
  const [type, setType] = useState("Note"); // "" = every type
  const [types, setTypes] = useState<{ type: string; count: number }[]>([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "address", desc: false });
  const dq = useDebounced(q.trim(), 250);
  const sc = useRef(scanner()).current;
  const t = usePaged<BookmarkItem>((offset, limit) => sc.run(bookmarks.list({ type: type || undefined, query: dq || undefined, offset, limit, sort: sort.key as "address", desc: sort.desc })).then((r) => { setTypes(r.types); return r; }),
    JSON.stringify([type, dq, sort, version]), onError, sc.cancelAll);
  const remove = (r: BookmarkItem) => bookmarks.remove({ address: r.address, type: r.type, category: r.category }).catch(onError);
  const cols: Col<BookmarkItem>[] = [
    { key: "address", label: "Address", width: 130, sort: "address", render: (r) => r.address },
    { key: "type", label: "Type", width: 90, sort: "type", render: (r) => r.type },
    { key: "category", label: "Category", width: 140, sort: "category", render: (r) => r.category },
    { key: "comment", label: "Comment", render: (r) => r.comment },
    { key: "remove", label: "", width: 30, render: (r) => <button className="x" aria-label={`Remove bookmark at ${r.address}${r.category ? " " + r.category : ""}`} title="Remove" onClick={(e) => { e.stopPropagation(); void remove(r); }}>×</button> },
  ];
  const problems = types.filter((x) => x.type === "Error" || x.type === "Warning").reduce((n, x) => n + x.count, 0);
  const known = types.some((x) => x.type === type) || type === PROBLEMS;
  return (
    <div className="panel" role="region" aria-label="Bookmarks">
      <div className="ph-bar">
        <select aria-label="Bookmark type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types ({types.reduce((n, x) => n + x.count, 0)})</option>
          <option value={PROBLEMS}>Problems ({problems})</option>
          {!known && type && <option value={type}>{type} (0)</option>}
          {types.map((x) => <option key={x.type} value={x.type}>{x.type} ({x.count})</option>)}
        </select>
        <button aria-label="Problems" aria-pressed={type === PROBLEMS} onClick={() => setType(type === PROBLEMS ? "Note" : PROBLEMS)} title="The analyzers' Error and Warning bookmarks">Problems</button>
        <input aria-label="Filter bookmarks" placeholder="filter by category or comment" value={q} onChange={(e) => setQ(e.target.value)} />
        <span role="status" aria-label="Bookmark count">{t.ready ? `${t.total} bookmarks` : "loading…"}</span>
      </div>
      <VirtualTable label="Bookmarks" count={t.total} rowAt={t.rowAt} onVisible={t.onVisible} cols={cols} sort={sort}
        onSort={(key) => setSort((s) => ({ key, desc: s.key === key && !s.desc }))}
        onActivate={(r) => onGo(r.address)} empty={t.ready ? (type === "Note" ? "no bookmarks of your own yet (Cmd+D adds one at the cursor)" : "no bookmarks") : ""} />
    </div>
  );
}

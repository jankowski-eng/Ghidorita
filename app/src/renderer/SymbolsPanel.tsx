import { useRef, useState } from "react";
import type { Address, SymbolKind, SymbolRow, SymbolSort } from "../../../protocol";
import { useDebounced } from "./hooks";
import { scanner } from "./scan";
import { usePaged, VirtualTable, type Col, type Sort } from "./VirtualTable";

const KINDS: SymbolKind[] = ["function", "label", "data", "external", "variable", "other"];
const COLS: Col<SymbolRow>[] = [
  { key: "name", label: "Name", sort: "name", render: (r) => r.name },
  { key: "address", label: "Address", width: 130, sort: "address", render: (r) => r.address ?? "-" },
  { key: "kind", label: "Kind", width: 80, sort: "kind", render: (r) => r.kind },
  { key: "namespace", label: "Namespace", width: 140, sort: "namespace", render: (r) => r.namespace || "Global" },
  { key: "source", label: "Source", width: 80, sort: "source", render: (r) => r.source },
];

/** Symbol table: server-paged (list_symbols), sortable by every column, name filter and kind filter; click or Enter navigates. */
export function SymbolsPanel({ version, onGo, onError }: { version: number; onGo: (a: Address) => void; onError: (e: unknown) => void }) {
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<SymbolKind[]>([]);
  const [sort, setSort] = useState<Sort>({ key: "address", desc: false });
  const dq = useDebounced(q.trim(), 250);
  const sc = useRef(scanner()).current;
  const t = usePaged<SymbolRow>((offset, limit) => sc.call("list_symbols", { offset, limit, query: dq, kinds, sort: sort.key as SymbolSort, desc: sort.desc }),
    JSON.stringify([dq, kinds, sort, version]), onError, sc.cancelAll);
  const toggle = (k: SymbolKind) => setKinds((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]));
  return (
    <div className="panel" role="region" aria-label="Symbol table">
      <div className="ph-bar">
        <input aria-label="Filter symbols" placeholder="filter by name (* and ? are wildcards)" value={q} onChange={(e) => setQ(e.target.value)} />
        {KINDS.map((k) => <label key={k} className="chip"><input type="checkbox" aria-label={`Kind ${k}`} checked={kinds.includes(k)} onChange={() => toggle(k)} />{k}</label>)}
        <span role="status" aria-label="Symbol count">{t.ready ? `${t.total} symbols` : "loading…"}{t.busy && t.ready ? " …" : ""}</span>
      </div>
      <VirtualTable label="Symbols" count={t.total} rowAt={t.rowAt} onVisible={t.onVisible} cols={COLS} sort={sort}
        onSort={(key) => setSort((s) => ({ key, desc: s.key === key && !s.desc }))}
        onActivate={(r) => { if (r.address) onGo(r.address); }} empty={t.ready ? "no symbols" : ""} />
    </div>
  );
}

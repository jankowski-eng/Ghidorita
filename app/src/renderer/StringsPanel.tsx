import type { Searches } from "./backend";
import { useRef, useState } from "react";
import type { Address, StringItem } from "../../../protocol";
import { useDebounced } from "./hooks";
import { scanner } from "./scan";
import { usePaged, VirtualTable, type Col } from "./VirtualTable";

/** Strings -> code: the first referrers as buttons (a click goes to the referencing instruction, not to the string), "+n" for the rest. */
const usedBy = (go: (a: Address) => void) => (r: StringItem) => {
  if (!r.refs) return <span className="dim">unreferenced</span>;
  const from = r.refFrom ?? [];
  return <>{from.map((f) => <button key={f.from} className="lnk" title={`referenced from ${f.from}`} onClick={(e) => { e.stopPropagation(); go(f.from); }}>{f.function ?? f.from}</button>)}{r.refs > from.length && <span className="dim"> +{r.refs - from.length}</span>}</>;
};

/** Defined strings: server-paged (list_strings), text filter and minimum length; click or Enter navigates. */
export function StringsPanel({ listStrings, version, onGo, onError }: { listStrings: Searches["listStrings"]; version: number; onGo: (a: Address) => void; onError: (e: unknown) => void }) {
  const [q, setQ] = useState("");
  const [min, setMin] = useState("4");
  const [refOnly, setRefOnly] = useState(false);
  const dq = useDebounced(q.trim(), 250), dmin = useDebounced(Math.max(1, Math.floor(Number(min)) || 1), 250);
  const sc = useRef(scanner()).current;
  const t = usePaged<StringItem>((offset, limit) => sc.run(listStrings({ offset, limit, minLength: dmin, query: dq, referencedOnly: refOnly })), JSON.stringify([dq, dmin, refOnly, version]), onError, sc.cancelAll);
  const cols: Col<StringItem>[] = [
    { key: "address", label: "Address", width: 130, render: (r) => r.address },
    { key: "refs", label: "Used by", width: 260, render: usedBy(onGo) },
    { key: "length", label: "Length", width: 70, render: (r) => r.length },
    { key: "value", label: "Value", render: (r) => r.value },
  ];
  return (
    <div className="panel" role="region" aria-label="Defined strings">
      <div className="ph-bar">
        <input aria-label="Filter strings" placeholder="filter text" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chip">min length <input type="number" aria-label="Minimum length" min={1} value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 56 }} /></label>
        <label className="chip"><input type="checkbox" aria-label="Referenced only" checked={refOnly} onChange={(e) => setRefOnly(e.target.checked)} /> referenced only</label>
        <span role="status" aria-label="String count">{t.ready ? `${t.total} strings` : "scanning…"}{t.busy && t.ready ? " …" : ""}</span>
      </div>
      <VirtualTable label="Strings" count={t.total} rowAt={t.rowAt} onVisible={t.onVisible} cols={cols} onActivate={(r) => onGo(r.address)} empty={t.ready ? "no strings" : ""} />
    </div>
  );
}

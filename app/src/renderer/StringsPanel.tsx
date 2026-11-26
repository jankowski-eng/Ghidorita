import type { Searches } from "./backend";
import { useRef, useState } from "react";
import type { Address, StringItem } from "../../../protocol";
import { useDebounced } from "./hooks";
import { scanner } from "./scan";
import { usePaged, VirtualTable, type Col } from "./VirtualTable";

const COLS: Col<StringItem>[] = [
  { key: "address", label: "Address", width: 130, render: (r) => r.address },
  { key: "length", label: "Length", width: 70, render: (r) => r.length },
  { key: "value", label: "Value", render: (r) => r.value },
];

/** Defined strings: server-paged (list_strings), text filter and minimum length; click or Enter navigates. */
export function StringsPanel({ listStrings, version, onGo, onError }: { listStrings: Searches["listStrings"]; version: number; onGo: (a: Address) => void; onError: (e: unknown) => void }) {
  const [q, setQ] = useState("");
  const [min, setMin] = useState("4");
  const dq = useDebounced(q.trim(), 250), dmin = useDebounced(Math.max(1, Math.floor(Number(min)) || 1), 250);
  const sc = useRef(scanner()).current;
  const t = usePaged<StringItem>((offset, limit) => sc.run(listStrings({ offset, limit, minLength: dmin, query: dq })), JSON.stringify([dq, dmin, version]), onError, sc.cancelAll);
  return (
    <div className="panel" role="region" aria-label="Defined strings">
      <div className="ph-bar">
        <input aria-label="Filter strings" placeholder="filter text" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chip">min length <input type="number" aria-label="Minimum length" min={1} value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 56 }} /></label>
        <span role="status" aria-label="String count">{t.ready ? `${t.total} strings` : "scanning…"}{t.busy && t.ready ? " …" : ""}</span>
      </div>
      <VirtualTable label="Strings" count={t.total} rowAt={t.rowAt} onVisible={t.onVisible} cols={COLS} onActivate={(r) => onGo(r.address)} empty={t.ready ? "no strings" : ""} />
    </div>
  );
}

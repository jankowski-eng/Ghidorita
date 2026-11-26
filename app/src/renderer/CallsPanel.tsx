import { useEffect, useRef, useState } from "react";
import type { Address, CallEdge, FunctionCalls } from "../../../protocol";
import type { References } from "./backend";
import { isCancelled, isNoProgram, scanner } from "./scan";
import { VirtualTable, type Col } from "./VirtualTable";

type Row = { dir: "caller" | "callee"; edge: CallEdge };
const label = (e: CallEdge) => (e.thunk && e.target ? `${e.name} → ${e.target.name}` : e.name);
const kind = (e: CallEdge) => (e.external ? "external" : e.thunk ? (e.target?.external ? "thunk to external" : "thunk") : "");
/** A thunk with a memory target opens the stub itself; an external has nowhere to go. */
export const goTo = (e: CallEdge): Address | null => e.entry;
const COLS: Col<Row>[] = [
  { key: "dir", label: "", width: 70, render: (r) => (r.dir === "caller" ? "← from" : "→ to") },
  { key: "name", label: "Function", render: (r) => label(r.edge) },
  { key: "address", label: "Address", width: 130, render: (r) => r.edge.entry ?? "-" },
  { key: "kind", label: "", width: 130, render: (r) => kind(r.edge) },
];

/** Callers and callees of the function at the cursor (function_calls). Click or Enter navigates the listing and decompiler; externals are shown but not navigable. */
export function CallsPanel({ calls, entry, name, version, onGo, onError }: { calls: References["calls"]; entry: Address | null; name: string; version: number; onGo: (a: Address) => void; onError: (e: unknown) => void }) {
  const [data, setData] = useState<FunctionCalls | null>(null);
  const [msg, setMsg] = useState("");
  const sc = useRef(scanner()).current;
  useEffect(() => {
    if (!entry) { setData(null); setMsg("no function at the cursor"); return; }
    let live = true;
    setMsg("loading…");
    sc.run(calls({ entry })).then((r) => { if (live) { setData(r); setMsg(""); } }, (e) => {
      if (!live || isCancelled(e) || isNoProgram(e)) return;
      setData(null); setMsg(e instanceof Error ? e.message : String(e)); onError(e);
    });
    return () => { live = false; sc.cancelAll(); };
  }, [entry, version]); // eslint-disable-line
  const rows: Row[] = data ? [...data.callers.map((edge) => ({ dir: "caller" as const, edge })), ...data.callees.map((edge) => ({ dir: "callee" as const, edge }))] : [];
  return (
    <div className="panel" role="region" aria-label="Calls">
      <div className="ph-bar">
        <span role="status" aria-label="Call counts">{entry ? `${name}: ${data ? `${data.callers.length} callers, ${data.callees.length} callees` : msg}` : msg}</span>
      </div>
      <VirtualTable label="Calls" count={rows.length} rowAt={(i) => rows[i]} onVisible={() => {}} cols={COLS}
        onActivate={(r) => { const a = goTo(r.edge); if (a) onGo(a); }} empty={data ? "no callers or callees" : ""} />
    </div>
  );
}

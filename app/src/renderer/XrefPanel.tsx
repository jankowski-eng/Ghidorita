import { useEffect, useRef, useState } from "react";
import type { Address, XrefTo } from "../../../protocol";
import { rpc } from "./client";
import { latest } from "./latest";

/** Read-only references to the current address; click or Enter navigates to the referencing address. */
export function XrefPanel({ address, version, onGo }: { address: Address | null; version: number; onGo: (a: Address) => void }) {
  const [rows, setRows] = useState<XrefTo[]>([]);
  const [msg, setMsg] = useState("");
  const run = useRef(latest()).current;
  useEffect(() => {
    if (!address) { run(Promise.resolve(null)); setRows([]); setMsg(""); return; }
    run(rpc.call("xrefs_to", { address, limit: 200 })).then((r) => { if (r) { setRows(r); setMsg(r.length ? "" : "no references"); } },
      (e) => { setRows([]); setMsg(e instanceof Error ? e.message : String(e)); });
  }, [address, version]); // eslint-disable-line
  return (
    <div className="xrefs" role="region" aria-label="References to current address">
      <div className="xh">References to {address ?? "-"} ({rows.length})</div>
      <div className="xl" role="list">
        {rows.map((x, i) => (
          <button key={i} role="listitem" className="xr" onClick={() => onGo(x.from)} title={x.type}>
            <span className="a">{x.from}</span> <span className="t">{x.type}</span> {x.function && <span className="f">{x.function}</span>}
          </button>
        ))}
        {msg && <div className="msg">{msg}</div>}
      </div>
    </div>
  );
}

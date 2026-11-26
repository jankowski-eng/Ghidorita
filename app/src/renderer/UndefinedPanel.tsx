import { useRef } from "react";
import type { Address, UndefinedRef } from "../../../protocol";
import type { Searches } from "./backend";
import { scanner } from "./scan";
import { usePaged, VirtualTable, type Col } from "./VirtualTable";

/**
 * Bytes that code references but nobody defined (list_undefined_refs): server-paged, one row per reference. A click or Enter goes to the target
 * in the listing; T, [ or P there define it in place, and the row is gone after the refresh the edit triggers (`version`).
 */
export function UndefinedPanel({ listUndefinedRefs, version, onGo, onError }: { listUndefinedRefs: Searches["listUndefinedRefs"]; version: number; onGo: (a: Address) => void; onError: (e: unknown) => void }) {
  const sc = useRef(scanner()).current;
  const t = usePaged<UndefinedRef>((offset, limit) => sc.run(listUndefinedRefs({ offset, limit })), JSON.stringify([version]), onError, sc.cancelAll);
  const cols: Col<UndefinedRef>[] = [
    { key: "address", label: "Target", width: 130, render: (r) => r.address },
    { key: "type", label: "Access", width: 90, render: (r) => r.type },
    { key: "from", label: "From", width: 130, render: (r) => <button className="lnk" title="go to the referring instruction" onClick={(e) => { e.stopPropagation(); onGo(r.from); }}>{r.from}</button> },
    { key: "function", label: "Function", render: (r) => r.function ?? <span className="dim">outside functions</span> },
  ];
  return (
    <div className="panel" role="region" aria-label="Undefined data references">
      <div className="ph-bar">
        <span role="status" aria-label="Reference count">{t.ready ? `${t.total} references into undefined bytes` : "scanning…"}{t.busy && t.ready ? " …" : ""}</span>
        <span className="dim">click goes to the target; T, [ or P define it there</span>
      </div>
      <VirtualTable label="Undefined data references" count={t.total} rowAt={t.rowAt} onVisible={t.onVisible} cols={cols} onActivate={(r) => onGo(r.address)} empty={t.ready ? "nothing references undefined bytes" : ""} />
    </div>
  );
}

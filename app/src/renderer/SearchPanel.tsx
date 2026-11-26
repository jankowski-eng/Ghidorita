import { useEffect, useRef, useState } from "react";
import type { Address, SymbolHit } from "../../../protocol";
import { searchSymbols } from "./symbols";
import { latest } from "./latest";
import { useDebounced } from "./hooks";

/** Symbol search palette: type, arrows to move, Enter to navigate, Escape to close. */
export function SearchPanel({ onGo, onClose }: { onGo: (a: Address) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [cur, setCur] = useState(0);
  const [msg, setMsg] = useState("");
  const dq = useDebounced(q, 150);
  const run = useRef(latest()).current;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (!dq.trim()) { run(Promise.resolve(null)); setHits([]); setMsg(""); return; }
    run(searchSymbols(dq, 100)).then((r) => { if (r) { setHits(r); setCur(0); setMsg(r.length ? "" : "no matches"); } }, (e) => { setHits([]); setMsg(e instanceof Error ? e.message : String(e)); });
  }, [dq]); // eslint-disable-line
  const go = (h?: SymbolHit) => { if (h) { onGo(h.address); onClose(); } };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCur((c) => Math.min(hits.length - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); go(hits[cur]); }
    else if (e.key === "Escape") onClose();
  };
  useEffect(() => { document.getElementById(`sym-${cur}`)?.scrollIntoView({ block: "nearest" }); }, [cur]);
  return (
    <div className="search" role="dialog" aria-label="Search symbols" onKeyDown={onKey}>
      <input ref={input} role="combobox" aria-expanded={hits.length > 0} aria-controls="sym-list" aria-activedescendant={hits[cur] ? `sym-${cur}` : undefined}
        aria-label="Symbol name" placeholder="Search symbols…" value={q} onChange={(e) => { setQ(e.target.value); setHits([]); }} />
      <div id="sym-list" role="listbox" aria-label="Symbols">
        {hits.map((h, i) => (
          <div key={h.address + h.name} id={`sym-${i}`} role="option" aria-selected={i === cur} className={"hit" + (i === cur ? " cur" : "")}
            onMouseDown={(e) => e.preventDefault()} onClick={() => go(h)}>
            <span className="k">{h.kind}</span><span className="n">{h.name}</span><span className="a">{h.address}</span>
          </div>
        ))}
      </div>
      <div className="msg" role="status">{msg}</div>
    </div>
  );
}

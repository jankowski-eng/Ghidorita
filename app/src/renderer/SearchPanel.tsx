import { useEffect, useRef, useState } from "react";
import type { Address, Capability, SymbolHit } from "../../../protocol";
import type { Searches } from "./backend";
import { allowsCommand } from "../capabilities";
import { latest } from "./latest";
import { matchActions, type CommandAction } from "./commandActions";
import type { MenuCommand } from "../preload";
import { useDebounced, useRestoreFocus } from "./hooks";

/** Command bar (Cmd+K): type to search symbols (a hex address goes there), ">" lists menu actions; arrows to move, Enter to run, Escape to close. */
export function SearchPanel({ capabilities, searchSymbols, onGo, onRun, onClose }: { capabilities: ReadonlySet<Capability>; searchSymbols?: Searches["searchSymbols"]; onGo: (a: Address) => void; onRun: (c: MenuCommand) => void; onClose: () => void }) {
  useRestoreFocus();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [cur, setCur] = useState(0);
  const [msg, setMsg] = useState("");
  const dq = useDebounced(q, 150);
  const actionMode = !searchSymbols || q.startsWith(">");
  const acts: CommandAction[] = actionMode ? matchActions(q.replace(/^>/, "")).filter(({ cmd }) => allowsCommand(capabilities, cmd)) : [];
  const n = actionMode ? acts.length : hits.length;
  const run = useRef(latest()).current;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (!searchSymbols || !dq.trim() || dq.startsWith(">")) { run(Promise.resolve(null)); setHits([]); setMsg(""); return; }
    const job = searchSymbols({ query: dq, limit: 100 });
    run(job.result).then((r) => { if (r) { setHits(r); setCur(0); setMsg(r.length ? "" : "no matches"); } }, (e) => { setHits([]); setMsg(e instanceof Error ? e.message : String(e)); });
    return () => { void run(Promise.resolve(null)); job.cancel(); };
  }, [dq, searchSymbols]); // eslint-disable-line
  const go = (h?: SymbolHit) => { if (h) { onGo(h.address); onClose(); } };
  const runAct = (a?: CommandAction) => { if (a) { onClose(); setTimeout(() => onRun(a.cmd), 0); } }; // after the bar unmounts and focus is back in the code pane, which edit actions read
  const enter = () => (actionMode ? runAct(acts[cur]) : go(hits[cur]));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCur((c) => Math.min(n - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); enter(); }
    else if (e.key === "Escape") onClose();
  };
  useEffect(() => { document.getElementById(`sym-${cur}`)?.scrollIntoView({ block: "nearest" }); }, [cur]);
  return (
    <div className="search" role="dialog" aria-label={searchSymbols ? "Search symbols" : "Command bar"} onKeyDown={onKey}>
      <input ref={input} role="combobox" aria-expanded={n > 0} aria-controls="sym-list" aria-activedescendant={n > cur ? `sym-${cur}` : undefined}
        aria-label="Symbol or action" placeholder={searchSymbols ? "Search symbols or address; > for actions" : "Search commands"} value={q} onChange={(e) => { setQ(e.target.value); setHits([]); setCur(0); }} />
      <div id="sym-list" role="listbox" aria-label="Symbols">
        {acts.map((a, i) => (
          <div key={a.label} id={`sym-${i}`} role="option" aria-selected={i === cur} className={"hit" + (i === cur ? " cur" : "")}
            onMouseDown={(e) => e.preventDefault()} onClick={() => runAct(a)}>
            <span className="k">action</span><span className="n">{a.label}</span>
          </div>
        ))}
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

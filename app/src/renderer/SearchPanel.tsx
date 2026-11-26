import { useEffect, useRef, useState } from "react";
import type { Address, SymbolKind } from "../../../protocol";
import { rpc } from "./client";
import { addressOf } from "./parseGoto";
import { searchSymbols } from "./symbols";
import { latest } from "./latest";
import { matchActions, type CommandAction } from "./commandActions";
import type { MenuCommand } from "../preload";
import { useDebounced, useRestoreFocus } from "./hooks";

/** One row of the bar: a typed address, a symbol or a defined string. */
type Hit = { kind: SymbolKind | "string" | "address"; name: string; address: Address };
const short = (v: string) => (v.length > 80 ? v.slice(0, 80) + "…" : v).replace(/\s+/g, " ");

/** Command bar (Cmd+K): symbols, defined strings and typed addresses; ">" lists menu actions; arrows to move, Enter to run, Escape to close. */
export function SearchPanel({ onGo, onRun, onClose }: { onGo: (a: Address) => void; onRun: (c: MenuCommand) => void; onClose: () => void }) {
  useRestoreFocus();
  const [q, setQ] = useState("");
  const [syms, setSyms] = useState<Hit[]>([]);
  const [strs, setStrs] = useState<Hit[]>([]);
  const [cur, setCur] = useState(0);
  const [msg, setMsg] = useState("");
  const dq = useDebounced(q, 150);
  const actionMode = q.startsWith(">");
  const acts: CommandAction[] = actionMode ? matchActions(q.slice(1)) : [];
  const addr = actionMode ? null : addressOf(q);
  const hits: Hit[] = [...(addr ? [{ kind: "address" as const, name: "Go to address", address: addr }] : []), ...syms, ...strs];
  const n = actionMode ? acts.length : hits.length;
  const runSyms = useRef(latest()).current, runStrs = useRef(latest()).current;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = dq.trim();
    if (!t || t.startsWith(">")) { runSyms(Promise.resolve(null)); runStrs(Promise.resolve(null)); setSyms([]); setStrs([]); setMsg(""); return; }
    const fail = (e: unknown) => setMsg(e instanceof Error ? e.message : String(e));
    runSyms(searchSymbols(t, 100)).then((r) => { if (r) { setSyms(r.map((h) => ({ kind: h.kind, name: h.name, address: h.address }))); setCur(0); setMsg(""); } }, (e) => { setSyms([]); fail(e); });
    // strings need a few characters to be useful; a scan that fails (no program yet) just shows no strings
    if (t.length >= 3) runStrs(rpc.call("list_strings", { query: t, limit: 20, minLength: 3 })).then((r) => { if (r) setStrs(r.items.map((s) => ({ kind: "string" as const, name: short(s.value), address: s.address }))); }, () => setStrs([]));
    else { runStrs(Promise.resolve(null)); setStrs([]); }
  }, [dq]); // eslint-disable-line
  const go = (h?: Hit) => { if (h) { onGo(h.address); onClose(); } };
  const runAct = (a?: CommandAction) => { if (a) { onClose(); setTimeout(() => onRun(a.cmd), 0); } }; // after the bar unmounts and focus is back in the code pane, which edit actions read
  const enter = () => (actionMode ? runAct(acts[cur]) : go(hits[cur]));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCur((c) => Math.min(n - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); enter(); }
    else if (e.key === "Escape") onClose();
  };
  useEffect(() => { document.getElementById(`sym-${cur}`)?.scrollIntoView({ block: "nearest" }); }, [cur]);
  const empty = !actionMode && q.trim() && !hits.length && !msg;
  return (
    <div className="search" role="dialog" aria-label="Search symbols" onKeyDown={onKey}>
      <input ref={input} role="combobox" aria-expanded={n > 0} aria-controls="sym-list" aria-activedescendant={n > cur ? `sym-${cur}` : undefined}
        aria-label="Symbol or action" placeholder="Search symbols, strings or an address; > for actions" value={q} onChange={(e) => { setQ(e.target.value); setSyms([]); setStrs([]); setCur(0); }} />
      <div id="sym-list" role="listbox" aria-label="Symbols">
        {acts.map((a, i) => (
          <div key={a.label} id={`sym-${i}`} role="option" aria-selected={i === cur} className={"hit" + (i === cur ? " cur" : "")}
            onMouseDown={(e) => e.preventDefault()} onClick={() => runAct(a)}>
            <span className="k">action</span><span className="n">{a.label}</span>
          </div>
        ))}
        {hits.map((h, i) => (
          <div key={h.kind + h.address + h.name} id={`sym-${i}`} role="option" aria-selected={i === cur} className={"hit" + (i === cur ? " cur" : "")}
            onMouseDown={(e) => e.preventDefault()} onClick={() => go(h)}>
            <span className="k">{h.kind}</span><span className="n">{h.name}</span><span className="a">{h.address}</span>
          </div>
        ))}
      </div>
      <div className="msg" role="status">{msg || (empty ? "no matches" : "")}</div>
    </div>
  );
}

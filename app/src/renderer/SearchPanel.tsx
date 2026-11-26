import { useEffect, useRef, useState } from "react";
import type { Address, Capability } from "../../../protocol";
import type { Searches } from "./backend";
import { allowsCommand } from "../capabilities";
import { addressOf } from "./parseGoto";
import { latest } from "./latest";
import { isLeadString, rank, type Cand } from "./rank";
import { layoutActions, matchActions, type CommandAction } from "./commandActions";
import { keyOf, showKey } from "../keys";
import { isMac } from "./platform";
import type { MenuCommand } from "../preload";
import { useDebounced, useRestoreFocus } from "./hooks";

/** One row of the bar: a typed address, a symbol or a defined string (`why`: what ranks it, `used`: a string's first referencing function). */
type Hit = Omit<Cand, "kind"> & { kind: Cand["kind"] | "address"; why?: string; score?: number };
const short = (v: string) => (v.length > 80 ? v.slice(0, 80) + "…" : v).replace(/\s+/g, " ");

/** Command bar (Cmd+K): symbols, defined strings and typed addresses (each when the provider offers it); ">" lists menu actions; arrows to move, Enter to run, Escape to close. */
export function SearchPanel({ capabilities, searchSymbols, topSymbols, listStrings, layouts, onGo, onRun, onClose }: { layouts: string[]; capabilities: ReadonlySet<Capability>; searchSymbols?: Searches["searchSymbols"]; topSymbols?: Searches["topSymbols"]; listStrings?: Searches["listStrings"]; onGo: (a: Address) => void; onRun: (c: MenuCommand) => void; onClose: () => void }) {
  useRestoreFocus();
  const [q, setQ] = useState("");
  const [syms, setSyms] = useState<Cand[]>([]);
  const [strs, setStrs] = useState<Cand[]>([]);
  const [cur, setCur] = useState(0);
  const [msg, setMsg] = useState("");
  const dq = useDebounced(q, 150);
  const addr = q.startsWith(">") ? null : addressOf(q);
  const actionMode = q.startsWith(">") || (!searchSymbols && !addr);
  const acts: CommandAction[] = actionMode ? matchActions(q.replace(/^>/, ""), layoutActions(layouts)).filter(({ cmd }) => allowsCommand(capabilities, cmd)) : [];
  const hits: Hit[] = actionMode ? [] : [...(addr ? [{ kind: "address" as const, name: "Go to address", address: addr }] : []), ...rank(q, [...syms, ...strs])];
  const n = actionMode ? acts.length : hits.length;
  const runSyms = useRef(latest()).current, runStrs = useRef(latest()).current;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = dq.trim();
    const fail = (e: unknown) => setMsg(e instanceof Error ? e.message : String(e));
    const asStr = (s: { address: Address; value: string; refs?: number; refFrom?: { function?: string }[] }): Cand => ({ kind: "string", name: short(s.value), address: s.address, refs: s.refs ?? 0, used: s.refFrom?.[0]?.function });
    if (t.startsWith(">")) { runSyms(Promise.resolve(null)); runStrs(Promise.resolve(null)); setSyms([]); setStrs([]); setMsg(""); return; }
    if (!t) { // nothing typed: what is most worth looking at (entry point, most used strings and imports, most called functions)
      const top = topSymbols?.({ limit: 8 }), strJob = listStrings?.({ limit: 1000, minLength: 4, referencedOnly: true });
      if (top) runSyms(top.result).then((r) => { if (r) { setSyms(r); setCur(0); setMsg(""); } }, (e) => { setSyms([]); fail(e); }); else runSyms(Promise.resolve(null));
      if (strJob) runStrs(strJob.result).then((r) => { if (r) setStrs(r.items.filter((s) => isLeadString(s.value)).map(asStr).sort((a, b) => b.refs! - a.refs!).slice(0, 5)); }, () => setStrs([])); else runStrs(Promise.resolve(null));
      return () => { void runSyms(Promise.resolve(null)); void runStrs(Promise.resolve(null)); top?.cancel(); strJob?.cancel(); };
    }
    const symJob = searchSymbols?.({ query: t, limit: 100 });
    if (symJob) runSyms(symJob.result).then((r) => { if (r) { setSyms(r); setCur(0); setMsg(""); } }, (e) => { setSyms([]); fail(e); });
    // strings need a few characters to be useful; a scan that fails (no program yet) just shows no strings
    const strJob = t.length >= 3 ? listStrings?.({ query: t, limit: 20, minLength: 3 }) : undefined;
    if (strJob) runStrs(strJob.result).then((r) => { if (r) setStrs(r.items.map(asStr)); }, () => setStrs([]));
    else { runStrs(Promise.resolve(null)); setStrs([]); }
    return () => { void runSyms(Promise.resolve(null)); void runStrs(Promise.resolve(null)); symJob?.cancel(); strJob?.cancel(); };
  }, [dq, searchSymbols, topSymbols, listStrings]); // eslint-disable-line
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
    <div className="search" role="dialog" aria-label={searchSymbols ? "Search symbols" : "Command bar"} onKeyDown={onKey}>
      <input ref={input} role="combobox" aria-expanded={n > 0} aria-controls="sym-list" aria-activedescendant={n > cur ? `sym-${cur}` : undefined}
        aria-label="Symbol or action" placeholder={searchSymbols ? "Search symbols, strings or an address; > for actions" : "Go to an address; > for actions"} value={q} onChange={(e) => { setQ(e.target.value); setSyms([]); setStrs([]); setCur(0); }} />
      <div id="sym-list" role="listbox" aria-label="Symbols">
        {acts.map((a, i) => (
          <div key={a.label} id={`sym-${i}`} role="option" aria-selected={i === cur} className={"hit" + (i === cur ? " cur" : "")}
            onMouseDown={(e) => e.preventDefault()} onClick={() => runAct(a)}>
            <span className="k">action</span><span className="n">{a.label}</span>{keyOf(a.cmd) && <kbd className="kb">{showKey(keyOf(a.cmd)!, isMac)}</kbd>}
          </div>
        ))}
        {hits.map((h, i) => (
          <div key={h.kind + h.address + h.name} id={`sym-${i}`} role="option" aria-selected={i === cur} className={"hit" + (i === cur ? " cur" : "")}
            onMouseDown={(e) => e.preventDefault()} onClick={() => go(h)}>
            <span className="k">{h.kind}</span><span className="n">{h.name}{h.why && <span className="dim"> · {h.why}</span>}{h.score !== undefined && <span className="dim" title="kind weight + 10 × log2(1 + references)"> · score {h.score}</span>}{h.used && <span className="dim"> · first in {h.used}</span>}</span><span className="a">{h.address}</span>
          </div>
        ))}
      </div>
      <div className="msg" role="status">{msg || (empty ? "no matches" : "")}</div>
    </div>
  );
}

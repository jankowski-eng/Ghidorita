import type { Searches } from "./backend";
import { useEffect, useRef, useState } from "react";
import type { Address, MemoryHit } from "../../../protocol";
import { isCancelled, isNoProgram, scanner } from "./scan";
import { VirtualTable, type Col } from "./VirtualTable";

type Mode = "bytes" | "ascii" | "utf16le";
const COLS: Col<MemoryHit>[] = [
  { key: "address", label: "Address", width: 130, render: (r) => r.address },
  { key: "bytes", label: "Bytes", width: 260, render: (r) => r.bytes },
  { key: "function", label: "Function", render: (r) => r.function ?? "" },
];
const PAGE = 1000, CAP = 50_000; // rows per request; the search pauses (Continue) after this many matches to bound memory

/**
 * Memory search (Ghidra's search over the loaded initialized blocks): hex bytes with `??` wildcards or text (ASCII / UTF-16).
 * Pages are requested one after another and appended (streaming); Cancel stops after the current page and keeps what was found.
 */
export function MemSearchPanel({ searchMemory, version, onGo, onError }: { searchMemory: Searches["searchMemory"]; version: number; onGo: (a: Address) => void; onError: (e: unknown) => void }) {
  const [pattern, setPattern] = useState("");
  const [mode, setMode] = useState<Mode>("bytes");
  const [cs, setCs] = useState(true);
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [state, setState] = useState<{ s: "idle" | "searching" | "done" | "cancelled" | "capped" | "error"; resume?: Address; msg?: string }>({ s: "idle" });
  const sc = useRef(scanner()).current;
  const gen = useRef(0);
  const used = useRef({ pattern, mode, cs });
  const run = async (from?: Address) => {
    const g = ++gen.current;
    sc.cancelAll();
    const p = from ? used.current : (used.current = { pattern: pattern.trim(), mode, cs });
    if (!p.pattern) return;
    let start = from, got = from ? hits.length : 0;
    if (!from) setHits([]);
    setState({ s: "searching" });
    for (;;) {
      let r;
      try {
        r = await sc.run(searchMemory({ pattern: p.pattern, kind: p.mode === "bytes" ? "bytes" : "text", encoding: p.mode === "utf16le" ? "utf16le" : "ascii", caseSensitive: p.cs, start, limit: PAGE }));
      } catch (e) {
        if (g !== gen.current) return;
        if (isCancelled(e)) setState({ s: "cancelled", resume: start });
        else if (isNoProgram(e)) setState({ s: "idle" });
        else setState({ s: "error", msg: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (g !== gen.current) return;
      got += r.items.length;
      setHits((h) => [...h, ...r.items]);
      if (!r.next) return setState({ s: "done" });
      if (got >= CAP) return setState({ s: "capped", resume: r.next });
      start = r.next;
    }
  };
  useEffect(() => { gen.current++; sc.cancelAll(); setHits([]); setState({ s: "idle" }); }, [version]); // eslint-disable-line
  useEffect(() => () => { gen.current++; sc.cancelAll(); }, []); // eslint-disable-line
  const msg = { idle: "", searching: "searching…", done: "done", cancelled: "cancelled", capped: `stopped at ${CAP} matches`, error: state.msg ?? "" }[state.s];
  return (
    <div className="panel" role="region" aria-label="Memory search">
      <form className="ph-bar" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input aria-label="Search pattern" placeholder={mode === "bytes" ? "hex bytes, ?? = any byte: 48 8b ?? 24" : "text"} value={pattern} onChange={(e) => setPattern(e.target.value)} style={{ minWidth: 220 }} />
        <select aria-label="Search type" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="bytes">Hex bytes</option><option value="ascii">Text (ASCII)</option><option value="utf16le">Text (UTF-16)</option>
        </select>
        {mode !== "bytes" && <label className="chip"><input type="checkbox" aria-label="Case sensitive" checked={cs} onChange={(e) => setCs(e.target.checked)} />case sensitive</label>}
        <button type="submit" aria-label="Search memory" disabled={!pattern.trim() || state.s === "searching"}>Search</button>
        {state.s === "searching" && <button type="button" aria-label="Cancel search" onClick={() => sc.cancelAll()}>Cancel</button>}
        {(state.s === "cancelled" || state.s === "capped") && state.resume && <button type="button" aria-label="Continue search" onClick={() => void run(state.resume)}>Continue</button>}
        <span role="status" aria-label="Search state" className={state.s === "error" ? "err" : ""}>{hits.length} matches {msg && `· ${msg}`}</span>
      </form>
      <VirtualTable label="Search results" count={hits.length} rowAt={(i) => hits[i]} onVisible={() => {}} cols={COLS} onActivate={(r) => onGo(r.address)} empty={state.s === "done" ? "no matches" : ""} />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { DebugMemory } from "../../../protocol";
import { hexRows } from "./debug";
import { shownDebug } from "./store/program";
import { useProgram, useSession } from "./store/session";

/** Memory of the stopped target: a hexdump (bytes changed since the last read of the same range are marked), or through a Ghidra data type (a structure or array as one row per component). Re-read at every stop. */
export function MemoryPanel() {
  const s = useSession(), d = useProgram(shownDebug), program = useProgram((p) => p.program), live = useProgram((p) => p.debug);
  const [addr, setAddr] = useState("sp"), [len, setLen] = useState(""), [type, setType] = useState("");
  const [mem, setMem] = useState<DebugMemory | null>(null), [error, setError] = useState("");
  const prev = useRef<{ key: string; bytes: string } | null>(null);
  const stopped = live?.state === "stopped";
  const read = async () => {
    if (!program || !live || live.state !== "stopped") return;
    try {
      const regs = Object.fromEntries((live.registers ?? []).map((r) => [r.name.toLowerCase(), r.value]));
      const a = regs[addr.trim().toLowerCase()] ?? addr.trim();  // a register name stands for its value
      const key = `${a}/${len}/${type}`, r = await program.api.debug.memory({ address: a, length: Number(len) || undefined, ...(type.trim() ? { dataType: type.trim() } : {}) });
      setMem({ ...r, address: r.address }); setError("");
      setWas(prev.current?.key === key ? prev.current.bytes : undefined);
      prev.current = { key, bytes: r.bytes };
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setMem(null); }
  };
  const [was, setWas] = useState<string | undefined>();
  useEffect(() => { if (stopped) void read(); }, [live?.stop, stopped]); // eslint-disable-line
  if (!d || d.state === "detached") return <div className="empty" role="status">Not attached.</div>;
  return (
    <div className="regs mem" aria-label="Target memory">
      <div className="mem-bar">
        <label>address <input aria-label="Memory address" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x20000000 or sp" size={14} /></label>
        <label>bytes <input aria-label="Memory length" value={len} onChange={(e) => setLen(e.target.value)} placeholder="default" size={7} /></label>
        <label>as type <input aria-label="Memory data type" value={type} onChange={(e) => setType(e.target.value)} placeholder="uint[4], /MyStruct" size={16} /></label>
        <button onClick={() => void read()} disabled={!stopped} aria-label="Read memory">Read</button>
      </div>
      {error && <div className="err" role="alert">{error}</div>}
      {mem && !mem.items && <pre className="hexdump" aria-label="Hexdump">{hexRows(BigInt(mem.address), mem.bytes, was).map((r) => (
        <div key={r.address}><span className="hx-a">{r.address}</span>  {r.bytes.map((b, i) => <span key={i} className={b.changed ? "hx-c" : ""}>{b.v} </span>)}{" ".repeat(Math.max(0, 16 - r.bytes.length) * 3)} <span className="hx-t">{r.ascii}</span></div>))}</pre>}
      {mem?.items && <table className="vals" aria-label="Typed memory"><thead><tr><th>offset</th><th>type</th><th>name</th><th>value</th></tr></thead>
        <tbody>{mem.items.map((i) => <tr key={i.offset + i.name}><td>+{i.offset.toString(16)}</td><td>{i.type}</td><td>{i.name}</td><td>{i.value}</td></tr>)}</tbody></table>}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Address, XrefFrom, XrefTo } from "../../../protocol";
import { rpc } from "./client";
import { latest } from "./latest";
import type { XrefTarget } from "./editActions";

const LIMIT = 200;
type Row = { go: Address | null; where: string; kind: string; type: string; fn?: string; use?: string };
/** `use`: set on rows of a decompiler variable (variable_uses): the variable name, so the decompiler can highlight the token at that address. */
export type UseHit = { name: string };

/**
 * References to the current address (follows the cursor), or to a pinned target: the row under the listing cursor (X), or a decompiler token
 * (X on a variable/param -> references to that program variable, or the decompiler's writes and reads of a temporary; on a global -> references to its address, on a call target / function name / label -> to its address).
 * "From" lists what the instruction at the current address references (also stack, register and external references, which have no address).
 * Click or Enter navigates to the referencing / referenced address.
 */
export function XrefPanel({ address, target, version, onGo, onFollow }: { address: Address | null; target: XrefTarget | null; version: number; onGo: (a: Address, use?: UseHit) => void; onFollow: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState("");
  const [dir, setDir] = useState<"to" | "from">("to");
  const run = useRef(latest()).current;
  const mode = target ? "to" : dir;
  const at = target?.type === "address" ? target.address : address;
  useEffect(() => {
    const toRows = (r: XrefTo[], use?: string): Row[] => r.map((x) => ({ go: x.from, where: x.from, kind: x.kind, type: x.type, fn: x.function, use }));
    const pending: { cancel?: () => void } = {};
    const fromRows = (r: XrefFrom[]): Row[] => r.map((x) => ({ go: x.to, where: x.to ?? x.label ?? x.target, kind: x.kind, type: x.type }));
    let q: Promise<Row[] | null>;
    if (target?.type === "variable") {
      const { entry, name } = target;
      // a program variable's references; when the program has none (iVar1...), the decompiler's writes and reads of it (a decompile: cancellable)
      q = run(rpc.call("xrefs_to_variable", { entry, name, limit: LIMIT + 1 }).then(async (r) => {
        if (r.length) return toRows(r);
        const c = rpc.callCancellable("variable_uses", { entry, name });
        pending.cancel = c.cancel;
        return toRows(await c.result, name);
      }));
    }
    else if (!at) q = run(Promise.resolve(null));
    else if (mode === "from") q = run(rpc.call("xrefs_from", { address: at }).then(fromRows));
    else q = run(rpc.call("xrefs_to", { address: at, limit: LIMIT + 1 }).then(toRows));
    if (!at && !target) { setRows([]); setMsg(""); return; }
    setRows([]);
    q.then((r) => { if (r) { setRows(r.slice(0, LIMIT)); setMsg(r.length > LIMIT ? `showing ${LIMIT}, more exist` : r.length ? "" : target?.type === "variable" ? "no references or uses" : "no references"); } },
      (e) => { setRows([]); setMsg(e instanceof Error ? e.message : String(e)); });
    return () => pending.cancel?.();
  }, [at, target?.type === "variable" ? target.entry + target.name : "", mode, version]); // eslint-disable-line
  const what = target ? target.label : at ?? "-";
  return (
    <div className="xrefs" role="region" aria-label="References to current address">
      <div className="xh">
        <span>References {mode} {what} ({rows.length}{msg.startsWith("showing") ? "+" : ""})</span>
        {!target && <button aria-label="Show references from" aria-pressed={dir === "from"} onClick={() => setDir(dir === "to" ? "from" : "to")}>{dir === "to" ? "from…" : "to…"}</button>}
        {target && <button aria-label="Follow cursor" onClick={onFollow}>follow cursor</button>}
      </div>
      <div className="xl">
        {rows.map((x, i) => (
          <button key={i} className="xr" disabled={!x.go} onClick={() => x.go && onGo(x.go, x.use ? { name: x.use } : undefined)} title={x.type}>
            <span className="a">{x.where}</span> <span className="xk">{x.kind}</span> <span className="t">{x.type}</span> {x.fn && <span className="f">{x.fn}</span>}
          </button>
        ))}
        {msg && <div className="msg">{msg}</div>}
      </div>
    </div>
  );
}

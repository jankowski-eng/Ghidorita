import { useEffect, useState } from "react";
import type { Address, StackFrame, StackSlot } from "../../../protocol";
import type { FunctionNavigation } from "./backend";
import { isCancelled, isNoProgram } from "./scan";
import { slotDot } from "./palette";
import { VirtualTable, type Col } from "./VirtualTable";

/** Stack offsets as the listing shows them: signed hex ("-0x8", "0x4"). */
export const offsetText = (n: number) => (n < 0 ? "-0x" + (-n).toString(16) : "0x" + n.toString(16));

function Source({ source }: { source: StackSlot["source"] }) {
  const d = slotDot(source);
  return <><span className={"psrc " + d.shape} style={{ "--c": d.color } as React.CSSProperties} title={d.label} role="img" aria-label={d.label} />{source}</>;
}
const COLS: Col<StackSlot>[] = [
  { key: "offset", label: "Offset", width: 80, render: (s) => offsetText(s.offset) },
  { key: "size", label: "Size", width: 50, render: (s) => s.size },
  { key: "name", label: "Name", render: (s) => s.name },
  { key: "type", label: "Type", render: (s) => s.dataType },
  { key: "param", label: "Param", width: 56, render: (s) => (s.parameter ? "param" : "") },
  { key: "source", label: "Source", width: 110, render: (s) => <Source source={s.source} /> },
];

/**
 * The stack frame of the function at the cursor (stack_frame), by offset. Clicking or pressing Enter selects a slot; Rename and Retype
 * (when the provider can edit variables) go through the decompiler's variable edits, and the decompiler view follows the change.
 */
export function StackPanel({ stackFrame, entry, name, version, onError, onRename, onRetype }: {
  stackFrame: FunctionNavigation["stackFrame"]; entry: Address | null; name: string; version: number; onError: (e: unknown) => void;
  onRename?: (entry: Address, slot: StackSlot) => void; onRetype?: (entry: Address, slot: StackSlot) => void;
}) {
  const [data, setData] = useState<StackFrame | null>(null);
  const [msg, setMsg] = useState("");
  const [sel, setSel] = useState<string | null>(null); // the selected slot's name: stays on it across a refresh
  useEffect(() => {
    if (!entry) { setData(null); setMsg("no function at the cursor"); return; }
    let live = true;
    setMsg("loading…");
    stackFrame({ entry }).then((r) => { if (live) { setData(r); setMsg(""); } }, (e) => {
      if (!live || isCancelled(e) || isNoProgram(e)) return;
      setData(null); setMsg(e instanceof Error ? e.message : String(e)); onError(e);
    });
    return () => { live = false; };
  }, [entry, version]); // eslint-disable-line
  useEffect(() => setSel(null), [entry]);
  const slots = data && data.entry === entry ? data.slots : [], slot = slots.find((s) => s.name === sel);
  return (
    <div className="panel" role="region" aria-label="Stack frame">
      <div className="ph-bar">
        <span role="status" aria-label="Frame summary">{entry ? `${name}: ${data && data.entry === entry ? `${slots.length} slots, ${data.parameterSize} B parameters, ${data.localSize} B locals${slot ? ` · ${slot.name} selected` : ""}` : msg}` : msg}</span>
        {onRename && <button disabled={!slot || !entry} aria-label="Rename slot" onClick={() => slot && entry && onRename(entry, slot)}>Rename…</button>}
        {onRetype && <button disabled={!slot || !entry} aria-label="Retype slot" onClick={() => slot && entry && onRetype(entry, slot)}>Retype…</button>}
      </div>
      <VirtualTable label="Stack frame" count={slots.length} rowAt={(i) => slots[i]} onVisible={() => {}} cols={COLS}
        onActivate={(s) => setSel(s.name)} empty={data && data.entry === entry ? "no stack variables" : ""} />
    </div>
  );
}

import type { TypeEdits, TypeReads } from "./backend";
import { useEffect, useRef, useState } from "react";
import type { DataTypeDetail, EnumOp, StructOp } from "../../../protocol";
import { FormDialog } from "./FormDialog";
import { hex } from "./dtTree";

/** Runs one edit RPC; resolves true on success. Errors are shown by the owner (banner) and never thrown. */
export type Run = (f: () => Promise<unknown>) => Promise<boolean>;

/** A text cell: commits on Enter or blur when changed (once per value), Escape reverts; a rejected commit reverts to the stored value. */
function Cell({ value, placeholder, label, disabled, className = "cell", onCommit }: { value: string; placeholder?: string; label: string; disabled?: boolean; className?: string; onCommit: (v: string) => Promise<boolean> }) {
  const [v, setV] = useState(value);
  const sent = useRef<string | null>(null);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v === value || sent.current === v) return; // Enter commits, then the blur it causes must not send it again
    sent.current = v;
    void onCommit(v).then((ok) => { sent.current = null; if (!ok) setV(value); });
  };
  return <input className={className} aria-label={label} value={v} placeholder={placeholder} disabled={disabled} spellCheck={false} autoComplete="off"
    onChange={(e) => setV(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); e.currentTarget.blur(); } else if (e.key === "Escape") { setV(value); e.stopPropagation(); e.currentTarget.blur(); } }} />;
}

/** Struct and union editor: every committed change is one edit_struct call (one Ghidra transaction, one undo step). */
export function StructEditor({ typeSearch, edit, d, run, reload, onApply }: { typeSearch: TypeReads["listDataTypes"]; edit?: TypeEdits["editStruct"]; d: DataTypeDetail; run: Run; reload: () => void; onApply: () => void }) {
  const comps = d.components ?? [];
  const union = d.kind === "union";
  const [sel, setSel] = useState<number | null>(null);
  const [hideFiller, setHideFiller] = useState(false);
  const [dlg, setDlg] = useState<null | "add" | "insert">(null);
  useEffect(() => { if (sel !== null && sel >= comps.length) setSel(null); }, [comps.length]); // eslint-disable-line
  useEffect(() => setSel(null), [d.path]);
  const op = (o: StructOp) => run(() => edit!({ path: d.path, op: o }));
  const cur = sel !== null ? comps[sel] : undefined;
  const shown = hideFiller ? comps.filter((c) => !c.undefined) : comps;
  const moveTo = (to: number) => { if (sel !== null && to >= 0 && to < comps.length) void op({ op: "move", ordinal: sel, to }).then((ok) => ok && setSel(to)); };
  const canMove = union || d.packed;
  return (
    <div className="ed">
      <div className="tools">
        <button aria-label="Add field" onClick={() => setDlg("add")}>Add field…</button>
        <button aria-label="Insert field" disabled={!cur} onClick={() => setDlg("insert")}>Insert before…</button>
        <button aria-label="Delete field" disabled={!cur} onClick={() => void op({ op: "delete", ordinal: sel! })} title="Remove the field; later fields shift up">Delete</button>
        <button aria-label="Clear field" disabled={!cur || cur.undefined} onClick={() => void op({ op: "clear", ordinal: sel! })} title={union ? "Remove the member" : "Turn the field into undefined bytes (size kept)"}>Clear</button>
        <button aria-label="Move field up" disabled={!cur || !canMove} onClick={() => moveTo(sel! - 1)} title={canMove ? "" : "Unpacked structures have fixed offsets: pack the structure to reorder"}>↑</button>
        <button aria-label="Move field down" disabled={!cur || !canMove} onClick={() => moveTo(sel! + 1)}>↓</button>
        <button aria-label="Apply at address" onClick={onApply}>Apply at address…</button>
      </div>
      <div className="tools">
        {!union && <label>Size <Cell label="Size" className="num" value={String(d.size)} disabled={d.packed} onCommit={(v) => op({ op: "resize", size: Number(v) })} /></label>}
        <label><input type="checkbox" aria-label="Packed" checked={!!d.packed} onChange={(e) => void op({ op: "pack", packed: e.target.checked })} /> Packed</label>
        {d.packed && <label>Packing <Cell label="Packing value" className="num" value={String(d.packingValue ?? "")} placeholder="default"
          onCommit={(v) => op({ op: "pack", packed: true, ...(v.trim() ? { packingValue: Number(v) } : {}) })} /></label>}
        <span className="meta">alignment {d.alignment}</span>
        {!union && <label><input type="checkbox" aria-label="Hide undefined" checked={hideFiller} onChange={(e) => setHideFiller(e.target.checked)} /> Hide undefined</label>}
      </div>
      <div className="scroll grow">
        <table className="comps" aria-label="Components">
          <thead><tr><th>Offset</th><th>Size</th><th>Type</th><th>Name</th><th>Comment</th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.ordinal} aria-selected={c.ordinal === sel} className={(c.ordinal === sel ? "sel " : "") + (c.undefined ? "undef" : "")} onClick={() => setSel(c.ordinal)}>
                <td className="mono">{hex(c.offset)}</td><td className="mono">{c.length}</td>
                <td><Cell label={`Type ${c.ordinal}`} value={c.undefined ? "" : c.type} placeholder="undefined" disabled={c.bitfield} onCommit={(v) => op({ op: "set", ordinal: c.ordinal, type: v.trim() })} /></td>
                <td><Cell label={`Name ${c.ordinal}`} value={c.name ?? ""} placeholder={c.undefined ? "" : c.defaultName} disabled={c.undefined || c.bitfield} onCommit={(v) => op({ op: "set", ordinal: c.ordinal, name: v.trim() })} /></td>
                <td><Cell label={`Comment ${c.ordinal}`} value={c.comment ?? ""} disabled={c.undefined || c.bitfield} onCommit={(v) => op({ op: "set", ordinal: c.ordinal, comment: v })} /></td>
              </tr>
            ))}
            {!comps.length && <tr><td colSpan={5} className="meta">No fields yet. Add one, or resize the structure to get undefined bytes to fill in.</td></tr>}
          </tbody>
        </table>
      </div>
      {dlg && <FormDialog typeSearch={typeSearch} title={dlg === "add" ? "Add field" : "Insert field"} submit={dlg === "add" ? "Add" : "Insert"}
        fields={[{ key: "type", label: "Field type", kind: "datatype" }, { key: "name", label: "Field name" }, { key: "comment", label: "Field comment" }]}
        onSubmit={async (v) => { // errors stay in the dialog
          const base = { type: v.type.trim(), name: v.name.trim() || undefined, comment: v.comment || undefined };
          await edit!({ path: d.path, op: dlg === "add" ? { op: "add", ...base } : { op: "insert", ordinal: sel!, ...base } }); reload(); }}
        onClose={() => setDlg(null)} />}
    </div>
  );
}

/** Enum editor: name/value cells commit like struct cells; a rename keeps the value. */
export function EnumEditor({ edit, d, run, reload, onApply }: { edit?: TypeEdits["editEnum"]; d: DataTypeDetail; run: Run; reload: () => void; onApply: () => void }) {
  const [dlg, setDlg] = useState(false);
  const op = (o: EnumOp) => run(() => edit!({ path: d.path, op: o }));
  return (
    <div className="ed">
      <div className="tools">
        <button aria-label="Add value" onClick={() => setDlg(true)}>Add value…</button>
        <label>Size <select aria-label="Enum size" value={d.size} onChange={(e) => void op({ op: "resize", size: Number(e.target.value) as 1 | 2 | 4 | 8 })}>{[1, 2, 4, 8].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <button aria-label="Apply at address" onClick={onApply}>Apply at address…</button>
      </div>
      <div className="scroll grow">
        <table className="comps" aria-label="Enum values">
          <thead><tr><th>Name</th><th>Value</th><th></th></tr></thead>
          <tbody>
            {(d.values ?? []).map((v) => (
              <tr key={v.name}>
                <td><Cell label={`Name of ${v.name}`} value={v.name} onCommit={(n) => op({ op: "set", oldName: v.name, name: n.trim(), value: v.value })} /></td>
                <td><Cell label={`Value of ${v.name}`} value={v.value} onCommit={(x) => op({ op: "set", name: v.name, value: x.trim() })} /></td>
                <td><button aria-label={`Remove ${v.name}`} onClick={() => void op({ op: "remove", name: v.name })}>✕</button></td>
              </tr>
            ))}
            {!(d.values ?? []).length && <tr><td colSpan={3} className="meta">No values yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {dlg && <FormDialog title="Add enum value" submit="Add" fields={[{ key: "name", label: "Value name" }, { key: "value", label: "Value (decimal or 0x…)" }]}
        onSubmit={async (v) => { await edit!({ path: d.path, op: { op: "set", name: v.name.trim(), value: v.value.trim() } }); reload(); }} onClose={() => setDlg(false)} />}
    </div>
  );
}
